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
orders, realized profit and loss, quotes and news. This access is read-only — you cannot
place, modify or cancel an order, and you should say so plainly if asked to trade rather
than implying you tried. Speak numbers the way a person would: "up about four percent",
"twelve hundred dollars", not raw decimals.`;

const COURSE_GUIDANCE = `You can look up the user's Brightspace courses, coursework, grades,
and announcements. Use those tools whenever a question touches their classes rather than
guessing. Speak about dates the way a person would — "Thursday", "next Tuesday", "in three
days" — not as calendar timestamps, and mention only the few most relevant items unless
asked for the full list.`;

function buildSystemPrompt(
  persona: string | undefined,
  withCourses: boolean,
  withAccount: boolean
): string {
  if (SYSTEM_PROMPT_OVERRIDE) return SYSTEM_PROMPT_OVERRIDE;
  const parts = [persona?.trim() || DEFAULT_PERSONA, VOICE_RULES, todayLine()];
  if (withCourses) parts.push(COURSE_GUIDANCE);
  if (withAccount) parts.push(ACCOUNT_GUIDANCE);
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
}

function mcpServers(): Anthropic.Beta.BetaRequestMCPServerURLDefinition[] {
  if (!MCP_URL) return [];
  return [
    {
      type: "url",
      name: MCP_NAME,
      url: MCP_URL,
      ...(MCP_TOKEN ? { authorization_token: MCP_TOKEN } : {}),
      tool_configuration: { allowed_tools: MCP_READ_ONLY_TOOLS, enabled: true },
    },
  ];
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
  const useAccount = request.account && mcpEnabled;
  const system = buildSystemPrompt(request.persona, useCourses, useAccount);

  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  if (request.webSearch) tools.push(webSearchTool(request.model));
  if (useCourses && courseTools) tools.push(...courseTools.definitions);
  if (useAccount) tools.push({ type: "mcp_toolset", mcp_server_name: MCP_NAME });

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
          ? { mcp_servers: mcpServers(), betas: ["mcp-client-2025-11-20"] }
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
      if (final.stop_reason === "tool_use" && useCourses && courseTools) {
        const calls = final.content.filter(
          (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use"
        );
        if (calls.length === 0) {
          sseSend(res, { type: "done", stopReason: final.stop_reason });
          return;
        }

        sseSend(res, { type: "status", label: "courses" });
        // Run them together: several courses in one question is the normal case.
        const results = await Promise.all(
          calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            try {
              const output = await courseTools.run(
                call.name,
                (call.input ?? {}) as Record<string, unknown>
              );
              return {
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify(output),
              };
            } catch (error) {
              console.error(`Tool ${call.name} failed:`, error);
              return {
                type: "tool_result",
                tool_use_id: call.id,
                is_error: true,
                content:
                  error instanceof Error
                    ? `Lookup failed: ${error.message}`
                    : "Lookup failed.",
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

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    void handleChat(req, res);
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
