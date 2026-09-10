#!/usr/bin/env node
/**
 * Backend for the Jarvis voice interface.
 *
 * Two jobs only: serve the static front end, and relay one streaming
 * conversation turn to Claude. The API key stays here — the browser never
 * sees it — and conversation state stays in the browser, so this process is
 * stateless and can be restarted mid-conversation without losing anything.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { projectRoot } from "../../src/config.js";
import { createCourseTools } from "./courses.js";
import {
  accountSessionAvailable,
  currentAccessToken,
  AccountSessionError,
} from "../../src/tools/account-session.js";
import {
  createTrading,
  readTradingConfig,
  TradingError,
  type ConfirmMode,
  type Trading,
} from "./trading.js";
import {
  ensureRulesFile,
  loadTradingRules,
  tradingRulesPath,
  tradingRulesPrompt,
} from "./strategy.js";

const PUBLIC_DIR = path.join(projectRoot, "web", "public");

const PORT = Number(process.env.JARVIS_PORT ?? 8917);
// Localhost by default: this server holds an API key and has no auth of its
// own, so it should not be reachable from the network unless asked for.
const HOST = process.env.JARVIS_HOST ?? "127.0.0.1";
const MODEL = process.env.JARVIS_MODEL ?? "claude-opus-5";
const MAX_TOKENS = Number(process.env.JARVIS_MAX_TOKENS ?? 2000);

/**
 * Voice is latency-sensitive chat, which is exactly the workload that does not
 * repay high effort — a reply that arrives two seconds late feels broken no
 * matter how good it is. Thinking stays on (adaptive is Opus 5's default);
 * only its depth is dialed back. Raise this via JARVIS_EFFORT if you'd rather
 * trade response time for depth.
 */
const EFFORT = (process.env.JARVIS_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * How to write for a speech synthesizer. These rules hold whatever persona the
 * user picks, so they live here rather than in the swappable half — a persona
 * that reintroduces bullet points makes the assistant read them aloud as
 * "asterisk".
 */
const VOICE_RULES = `Every word you produce is spoken aloud by a speech synthesizer, never
read, so write for the ear:

- Answer in one to three sentences. Stop as soon as the question is answered.
- Plain spoken prose only. No markdown, no bullet points, no numbered lists,
  no code blocks, no emoji, no stage directions, no asterisks.
- Write numbers, units, and symbols the way a person would say them:
  "about twenty percent", "three point five kilometers", "nineteen ninety-five".
- If something genuinely needs a long or structured answer, give the short
  spoken version and offer to go deeper.
- The transcript you receive comes from imperfect speech recognition. If a word
  is clearly garbled, infer what was meant rather than asking about it; ask for
  a repeat only when the meaning is genuinely unrecoverable.`;

/** The half the settings panel can replace. */
const DEFAULT_PERSONA = `You are JARVIS, a voice-driven assistant. Your manner is calm,
precise, and lightly dry. Do not use honorifics such as "sir" or "madam", and do not
open with filler like "certainly" or "of course".`;

const PERSONA_LIMIT = 2000;

/** JARVIS_SYSTEM_PROMPT still replaces everything, persona included. */
const SYSTEM_PROMPT_OVERRIDE = process.env.JARVIS_SYSTEM_PROMPT;

/** Grounding for "what's due this week" — the model needs to know when now is. */
function todayLine(): string {
  return `Today is ${new Date().toDateString()}.`;
}

const ACCOUNT_GUIDANCE = `You can read the user's brokerage account: balances, positions,
orders, realized profit and loss, quotes and news. Speak numbers the way a person would:
"up about four percent", "twelve hundred dollars", not raw decimals.`;

/** Only when trading is off, so the model is never told both things. */
const ACCOUNT_READ_ONLY = `This access is read-only — you cannot place, modify or cancel an
order. Say so plainly if asked to trade, rather than implying you tried.`;

/**
 * What propose_trade actually does depends on the confirmation mode, and the
 * model has to describe it accurately: telling someone to confirm on screen
 * while the order places itself is worse than saying nothing.
 */
const TRADING_GUIDANCE: Record<ConfirmMode, string> = {
  typed: `You can propose a stock trade with propose_trade. It does not place anything: it
puts the order on screen and the user types the ticker symbol to approve it. Say what you are
proposing and that it needs confirming on screen. Never say an order was placed — you are not
told the outcome. Only propose when the user clearly asked to buy or sell a named stock;
discussing a stock is not asking to trade it.`,

  countdown: `You can place a stock trade with propose_trade. It spends real money. The order
is held for a few seconds and then placed unless the user cancels, so the moment you call it,
say plainly what is being bought or sold and how much, and that saying cancel stops it. Never
say an order filled — you are not told the outcome. Only place a trade the user clearly asked
for, naming the stock; discussing a stock is not asking to trade it, and you must never place
one they did not ask for.`,

  none: `You can place a stock trade with propose_trade. It goes straight to the brokerage,
spends real money, and cannot be undone or cancelled. Say plainly what was placed and how
much. Only place a trade the user clearly asked for, naming the stock; discussing a stock is
not asking to trade it, and you must never place one they did not ask for. If a request is
ambiguous in any way, ask rather than place.`,
};

const COURSE_GUIDANCE = `You can look up the user's Brightspace courses, coursework, grades,
and announcements. Use those tools whenever a question touches their classes rather than
guessing. Speak about dates the way a person would — "Thursday", "next Tuesday", "in three
days" — not as calendar timestamps, and mention only the few most relevant items unless
asked for the full list.`;

function buildSystemPrompt(
  persona: string | undefined,
  withCourses: boolean,
  withAccount: boolean,
  withTrading: boolean
): string {
  if (SYSTEM_PROMPT_OVERRIDE) return SYSTEM_PROMPT_OVERRIDE;
  const parts = [persona?.trim() || DEFAULT_PERSONA, VOICE_RULES, todayLine()];
  if (withCourses) parts.push(COURSE_GUIDANCE);
  if (withAccount) {
    parts.push(ACCOUNT_GUIDANCE);
    if (withTrading) {
      parts.push(TRADING_GUIDANCE[tradingConfig.confirmMode]);
      // Read per turn: editing the rulebook takes effect on the next question.
      const rules = loadTradingRules();
      if (rules) parts.push(tradingRulesPrompt(rules));
    } else {
      parts.push(ACCOUNT_READ_ONLY);
    }
  }
  return parts.join("\n\n");
}

/**
 * Models the browser may ask for. An allowlist rather than a passthrough: the
 * model name arrives from the page, and a typo should not become a confusing
 * API error mid-conversation.
 */
const ALLOWED_MODELS = new Set(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);

/* ------------------------------------------------------------ trading MCP */

/**
 * An optional remote MCP server, for reading a brokerage account out loud.
 *
 * The voice app is a separate program from any Claude session, so it cannot
 * borrow a connector configured elsewhere — it needs its own URL and token.
 * The API calls the server on our behalf; nothing here ever holds brokerage
 * credentials.
 */
const MCP_URL = process.env.JARVIS_MCP_URL?.trim();
const MCP_TOKEN = process.env.JARVIS_MCP_TOKEN?.trim();
const MCP_NAME = process.env.JARVIS_MCP_NAME?.trim() || "trading";

/**
 * Read-only by construction. `allowed_tools` is enforced by the API, so a tool
 * that is not on this list cannot be called however the conversation goes —
 * which matters when the input is speech recognition and the account is real
 * money. Placing or cancelling orders is deliberately absent: enabling that is
 * a change to the trading rulebook, not a change to this file.
 */
const MCP_READ_ONLY_TOOLS = [
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_orders",
  "get_equity_quotes",
  "get_equity_historicals",
  "get_equity_fundamentals",
  "get_equity_news",
  "get_realized_pnl",
  "get_pnl_trade_history",
  "get_option_positions",
  "get_crypto_positions",
  "get_watchlists",
  "get_watchlist_items",
  "get_earnings_calendar",
  "search",
];

const mcpEnabled = Boolean(MCP_URL);
if (mcpEnabled) {
  console.log(
    `Account tools enabled (${MCP_NAME}): read-only, ${MCP_READ_ONLY_TOOLS.length} tools. ` +
      "Placing or cancelling orders is not available."
  );
  if (!accountSessionAvailable() && !MCP_TOKEN) {
    console.log("  No account sign-in saved yet — run `npm run account:login`.");
  }
}

function mcpServers(token: string | undefined): Anthropic.Beta.BetaRequestMCPServerURLDefinition[] {
  if (!MCP_URL) return [];
  // Filtering lives on the toolset below, not here: the mcp-client beta
  // rejects tool_configuration on the server definition.
  return [
    {
      type: "url",
      name: MCP_NAME,
      url: MCP_URL,
      ...(token ? { authorization_token: token } : {}),
    },
  ];
}

/**
 * A token for this turn. Prefers a signed-in session (which refreshes itself)
 * and falls back to a static one from .env for servers that issue those.
 */
async function accountToken(): Promise<string | undefined> {
  if (accountSessionAvailable()) return currentAccessToken();
  return MCP_TOKEN;
}

/**
 * Default-deny: every tool from the server is disabled, then the read-only
 * ones are switched back on by name. A tool nobody listed cannot be called
 * even if the server later adds it — which is the property worth having when
 * the input is speech recognition and the account holds real money.
 */
function mcpToolset(): Anthropic.Beta.BetaMCPToolset {
  return {
    type: "mcp_toolset",
    mcp_server_name: MCP_NAME,
    default_config: { enabled: false },
    configs: Object.fromEntries(
      MCP_READ_ONLY_TOOLS.map((name) => [name, { enabled: true }])
    ),
  };
}

const API_KEY = process.env.ANTHROPIC_API_KEY?.trim();

if (!API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set.\n" +
      "Add it to .env in the project root (see .env.example), then start again."
  );
  process.exit(1);
}

// A real key is ~100 characters. Catching the example value here saves a
// round trip through the API to be told it is invalid.
if (!API_KEY.startsWith("sk-ant-") || API_KEY.length < 40) {
  console.error(
    `ANTHROPIC_API_KEY does not look like a real key (got ${API_KEY.length} characters).\n` +
      "It should start with sk-ant- and run about 100 characters. If you copied a\n" +
      "placeholder from the docs, replace it with a key from\n" +
      "https://console.anthropic.com/settings/keys"
  );
  process.exit(1);
}

/**
 * Keys created at the organization level aren't tied to a workspace, and the
 * API rejects them unless the request names one. Keys scoped to a workspace
 * carry it already and need nothing here.
 */
const WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID?.trim();

const client = new Anthropic(
  WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE_ID } } : {}
);

/**
 * Voice-initiated trading. Off unless explicitly enabled, and even then the
 * model only ever proposes — see web/server/trading.ts.
 */
const tradingConfig = readTradingConfig();
const trading: Trading | null =
  tradingConfig.enabled && MCP_URL ? createTrading(MCP_URL, tradingConfig) : null;
if (tradingConfig.enabled && !MCP_URL) {
  console.warn("JARVIS_TRADING is enabled but JARVIS_MCP_URL is not set, so trading is off.");
}
if (trading) {
  const gate = {
    typed: "each confirmed by typing the ticker",
    countdown: `each placed after ${tradingConfig.countdownSeconds}s unless cancelled`,
    none: "placed immediately, with no confirmation step",
  }[tradingConfig.confirmMode];
  console.log(
    `Trading enabled: $${tradingConfig.maxNotionalUsd} per order, ` +
      `$${tradingConfig.dailyLimitUsd} per day, ${gate}.`
  );
  if (tradingConfig.confirmMode === "none") {
    console.warn(
      "  JARVIS_TRADING_CONFIRM=none: a misheard word becomes a real order with " +
        "nothing in between."
    );
  }
  ensureRulesFile();
  const rules = loadTradingRules();
  console.log(
    rules
      ? `  Trading rules loaded from ${tradingRulesPath} (${rules.length} characters).`
      : `  No trading rules yet. Open ${tradingRulesPath} and paste your bot's rules in ` +
        "to have them followed."
  );
}

/** null unless Brightspace is configured in .env. */
const courseTools = createCourseTools();
if (courseTools) {
  console.log("Brightspace tools enabled: courses, coursework, grades, announcements.");
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Guards against `..` escaping PUBLIC_DIR, and maps `/` to index.html. */
function resolveStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const filePath = resolveStaticPath(req.url ?? "/");
  if (!filePath) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface ChatRequest {
  messages: Anthropic.MessageParam[];
  persona?: string;
  model: string;
  webSearch: boolean;
  courses: boolean;
  account: boolean;
}

/**
 * Accepts the browser's copy of the conversation plus its settings. Anything
 * that isn't a well-formed alternating-ish user/assistant text history is
 * rejected rather than passed through to the API to fail there with a less
 * useful message.
 */
function parseChatRequest(raw: string): ChatRequest {
  const body = JSON.parse(raw) as unknown;
  if (typeof body !== "object" || body === null || !Array.isArray((body as any).messages)) {
    throw new Error("Expected a JSON body of the form { messages: [...] }");
  }

  const { messages: input, persona, model, webSearch, courses, account } = body as {
    messages: unknown[];
    persona?: unknown;
    model?: unknown;
    webSearch?: unknown;
    courses?: unknown;
    account?: unknown;
  };

  if (input.length === 0) throw new Error("messages must not be empty");
  if (input.length > 200) throw new Error("Conversation too long");

  const messages = input.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`messages[${i}] must be an object`);
    }
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      throw new Error(`messages[${i}].role must be "user" or "assistant"`);
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`messages[${i}].content must be a non-empty string`);
    }
    return { role, content } satisfies Anthropic.MessageParam;
  });

  if (messages[0].role !== "user") throw new Error("Conversation must start with a user turn");
  if (messages[messages.length - 1].role !== "user") {
    throw new Error("Conversation must end with a user turn");
  }

  if (persona !== undefined && typeof persona !== "string") {
    throw new Error("persona must be a string");
  }
  if (typeof persona === "string" && persona.length > PERSONA_LIMIT) {
    throw new Error(`persona must be at most ${PERSONA_LIMIT} characters`);
  }
  if (model !== undefined && (typeof model !== "string" || !ALLOWED_MODELS.has(model))) {
    throw new Error(`model must be one of: ${[...ALLOWED_MODELS].join(", ")}`);
  }

  return {
    messages,
    persona: persona as string | undefined,
    model: (model as string | undefined) ?? MODEL,
    webSearch: webSearch === true,
    // Only honoured when Brightspace is actually configured.
    courses: courses !== false && courseTools !== null,
    account: account !== false && mcpEnabled,
  };
}

/**
 * Newer models take the dynamically-filtered search tool; Haiku is not on that
 * list and needs the basic variant, so the tool is chosen per model rather
 * than declared once.
 */
function webSearchTool(model: string): Anthropic.ToolUnion {
  const dynamicFiltering = new Set(["claude-opus-5", "claude-sonnet-5"]);
  // Voice answers are short, so a couple of searches is plenty — and each one
  // costs both money and the seconds the user spends listening to silence.
  const max_uses = 3;
  return dynamicFiltering.has(model)
    ? { type: "web_search_20260209", name: "web_search", max_uses }
    : { type: "web_search_20250305", name: "web_search", max_uses };
}

function sseSend(res: http.ServerResponse, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** How many times a paused or tool-using turn may be resumed before we stop. */
const MAX_ROUNDS = 6;

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let request: ChatRequest;
  try {
    request = parseChatRequest(await readBody(req));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: message }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Streaming only helps if nothing downstream buffers it.
    "x-accel-buffering": "no",
  });

  const messages: Anthropic.Beta.BetaMessageParam[] = [...request.messages];
  const useCourses = request.courses && courseTools !== null;
  let useAccount = request.account && mcpEnabled;
  const useTrading = useAccount && trading !== null;
  const system = buildSystemPrompt(request.persona, useCourses, useAccount, useTrading);

  // Resolved once per turn rather than per round, and a failure here disables
  // the account rather than failing the whole answer — the rest of what was
  // asked may not need it.
  let token: string | undefined;
  if (useAccount) {
    try {
      token = await accountToken();
    } catch (error) {
      useAccount = false;
      const detail =
        error instanceof AccountSessionError ? error.message : "The account session is unavailable.";
      console.warn(`Account access disabled for this turn: ${detail}`);
      sseSend(res, { type: "status", label: "account-unavailable" });
    }
  }

  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  if (request.webSearch) tools.push(webSearchTool(request.model));
  if (useCourses && courseTools) tools.push(...courseTools.definitions);
  if (useAccount) tools.push(mcpToolset());
  if (useTrading && trading) tools.push(...trading.definitions);

  let current: ReturnType<typeof client.beta.messages.stream> | null = null;
  // If the listener navigates away or barges in, stop paying for tokens
  // nobody will hear.
  const abort = () => current?.abort();
  res.on("close", abort);

  try {
    // A server-side tool can pause the turn mid-answer; resume it until the
    // model actually finishes rather than cutting the reply off at the search.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // The beta endpoint throughout: it is a superset, and the MCP connector
      // only exists there.
      const stream = client.beta.messages.stream({
        model: request.model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        system,
        messages,
        ...(tools.length ? { tools } : {}),
        ...(useAccount
          ? { mcp_servers: mcpServers(token), betas: ["mcp-client-2025-11-20"] }
          : {}),
      });
      current = stream;

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          sseSend(res, { type: "delta", text: event.delta.text });
        } else if (
          event.type === "content_block_start" &&
          event.content_block.type === "server_tool_use"
        ) {
          // Searching adds seconds of silence; tell the page so it can say so.
          sseSend(res, { type: "status", label: "searching" });
        }
      }

      const final = await stream.finalMessage();

      if (final.stop_reason === "refusal") {
        sseSend(res, {
          type: "error",
          message: "That request was declined. Try asking something else.",
        });
        return;
      }
      if (final.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: final.content });
        continue;
      }

      // Client-side tools: Brightspace lookups run here, then the model gets
      // another turn to actually answer with what came back.
      // Gated on useCourses as well as availability: a tool the request did
      // not enable must never run, whatever the model asks for.
      if (final.stop_reason === "tool_use" && (useCourses || useTrading)) {
        const calls = final.content.filter(
          (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use"
        );
        if (calls.length === 0) {
          sseSend(res, { type: "done", stopReason: final.stop_reason });
          return;
        }

        if (calls.some((call) => call.name !== "propose_trade")) {
          sseSend(res, { type: "status", label: "courses" });
        }
        // Run them together: several courses in one question is the normal case.
        const results = await Promise.all(
          calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            try {
              const input = (call.input ?? {}) as Record<string, unknown>;

              if (call.name === "propose_trade") {
                if (!useTrading || !trading) {
                  throw new TradingError("Trading is not enabled.");
                }
                const { trade, mode, result } = await trading.propose(input);
                sseSend(res, {
                  type: "confirm",
                  id: trade.id,
                  summary: trade.summary,
                  symbol: trade.intent.symbol,
                  mode,
                  placesAt: trade.placesAt ?? null,
                  countdownSeconds: trading.countdownSeconds,
                });

                // The model is told the outcome only when there is one it could
                // not misreport: in typed and countdown modes it does not learn
                // whether the order went through, so it cannot claim it did.
                const status =
                  mode === "none"
                    ? "Placed."
                    : mode === "countdown"
                      ? `Placing in ${trading.countdownSeconds} seconds unless the user ` +
                        "cancels. Say what is being placed and that saying cancel stops it. " +
                        "You will not be told the outcome."
                      : "Awaiting the user's typed confirmation on screen. Nothing has been " +
                        "placed, and you will not be told the outcome.";

                return {
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: JSON.stringify({
                    order: trade.summary,
                    status,
                    ...(mode === "none" && result !== undefined ? { result } : {}),
                  }),
                };
              }

              if (!useCourses || !courseTools) {
                throw new Error(`Unknown tool: ${call.name}`);
              }
              const output = await courseTools.run(call.name, input);
              return {
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify(output),
              };
            } catch (error) {
              console.error(`Tool ${call.name} failed:`, error);
              // A refused trade is not a failed lookup. Saying so lets the model
              // relay the real reason — and a rule that stopped an order is
              // exactly what the user needs to hear.
              const what = call.name === "propose_trade" ? "The trade was not placed" : "Lookup failed";
              return {
                type: "tool_result",
                tool_use_id: call.id,
                is_error: true,
                content: error instanceof Error ? `${what}: ${error.message}` : `${what}.`,
              };
            }
          })
        );

        messages.push({ role: "assistant", content: final.content });
        messages.push({ role: "user", content: results });
        continue;
      }

      sseSend(res, { type: "done", stopReason: final.stop_reason });
      return;
    }

    sseSend(res, {
      type: "error",
      message: "That needed more lookups than expected. Try a narrower question.",
    });
  } catch (error) {
    if (res.writableEnded) return;
    // The abort above is the normal path when a listener leaves mid-reply;
    // it is not worth reporting as a failure.
    const aborted = error instanceof Anthropic.APIUserAbortError;
    if (!aborted) {
      console.error("Claude request failed:", error);
      sseSend(res, { type: "error", message: describeApiError(error) });
    }
  } finally {
    res.off("close", abort);
    if (!res.writableEnded) res.end();
  }
}

function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Authentication failed. Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited. Give it a moment and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API. Check the network connection.";
  }
  if (error instanceof Anthropic.APIError) {
    if (error.message.includes("anthropic-workspace-id")) {
      return (
        "This API key is not tied to a workspace. Either create a key scoped to " +
        "one, or set ANTHROPIC_WORKSPACE_ID in .env."
      );
    }
    return `Claude API error ${error.status ?? ""}: ${error.message}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The only path that reaches the broker. It requires the ticker typed exactly,
 * which is why the model is never given an order tool: this cannot be reached
 * by anything the model says, only by something a person types.
 */
async function handleConfirm(req: http.IncomingMessage, res: http.ServerResponse) {
  const reply = (status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (!trading) {
    reply(400, { error: "Trading is not enabled on this server." });
    return;
  }

  let id: unknown;
  let typed: unknown;
  try {
    ({ id, typed } = JSON.parse(await readBody(req)) as { id?: unknown; typed?: unknown });
  } catch {
    reply(400, { error: "Expected a JSON body of the form { id, typed }." });
    return;
  }
  if (typeof id !== "string" || typeof typed !== "string") {
    reply(400, { error: "Both id and typed must be strings." });
    return;
  }

  try {
    const result = await trading.confirm(id, typed);
    console.log(`Order placed after typed confirmation: ${id}`);
    reply(200, { placed: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Order not placed (${id}): ${message}`);
    reply(error instanceof TradingError ? 400 : 502, { placed: false, error: message });
  }
}

/**
 * A standing stream for things that happen outside a turn — chiefly a
 * countdown order placing itself after the conversation has moved on.
 */
function handleEvents(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = trading?.onPlacement((outcome) => {
    sseSend(res, { type: "placement", ...outcome });
  });

  // Proxies and browsers drop an idle stream; a comment costs nothing.
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe?.();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    void handleChat(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/api/events") {
    handleEvents(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/confirm") {
    void handleConfirm(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/dismiss") {
    void readBody(req)
      .then((raw) => {
        const { id } = JSON.parse(raw) as { id?: unknown };
        if (typeof id === "string") trading?.dismiss(id);
      })
      .catch(() => {})
      .finally(() => res.writeHead(204).end());
    return;
  }
  if (req.method === "GET" && req.url === "/api/health") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          ok: true,
          model: MODEL,
          effort: EFFORT,
          models: [...ALLOWED_MODELS],
          courses: courseTools !== null,
          account: mcpEnabled,
          accountSignedIn: accountSessionAvailable(),
          trading: trading !== null,
          tradingMode: trading?.mode ?? null,
          countdownSeconds: trading?.countdownSeconds ?? 0,
          maxTradeUsd: tradingConfig.maxNotionalUsd,
          dailyTradeUsd: tradingConfig.dailyLimitUsd,
        })
      );
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    void serveStatic(req, res);
    return;
  }
  res.writeHead(405, { "content-type": "text/plain" }).end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`JARVIS interface ready at http://${HOST}:${PORT} (model: ${MODEL}, effort: ${EFFORT})`);
});
