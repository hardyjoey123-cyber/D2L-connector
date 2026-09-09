#!/usr/bin/env node
/**
 * Diagnoses the brokerage MCP connection.
 *
 * Two questions this answers that nothing else can: whether the server accepts
 * a static token at all (many require an interactive OAuth flow, which the
 * Messages API connector cannot perform), and whether the tool names this
 * project allows actually exist on that server — an allowlist of names that
 * don't match is indistinguishable from no access at all.
 *
 * Prints statuses, header names and tool names. Never the token.
 *
 * Usage: npm run account:check
 */
import "dotenv/config";

/** Kept in step with web/server/index.ts. */
const READ_ONLY_TOOLS = [
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

const URL_ = process.env.JARVIS_MCP_URL?.trim();
const TOKEN = process.env.JARVIS_MCP_TOKEN?.trim();
const TIMEOUT_MS = 20_000;

/** MCP over HTTP may answer as JSON or as a single SSE frame. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          /* keep looking */
        }
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
}

async function rpc(method: string, params: unknown, sessionId?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(URL_!, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { response, body: await readBody(response) };
}

async function main() {
  console.log("\nAccount (MCP) diagnostic\n" + "=".repeat(40));
  console.log(`JARVIS_MCP_URL:   ${URL_ ?? "MISSING"}`);
  console.log(`JARVIS_MCP_TOKEN: ${TOKEN ? `set (${TOKEN.length} characters)` : "not set"}`);

  if (!URL_) {
    console.log("\nVERDICT: no server configured.");
    console.log("FIX: add JARVIS_MCP_URL to .env, then run this again.\n");
    process.exit(1);
  }

  console.log("\nConnecting…\n");

  let init;
  try {
    init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jarvis-account-check", version: "1.0" },
    });
  } catch (error) {
    console.log(`could not reach it: ${error instanceof Error ? error.message : error}`);
    console.log("\nVERDICT: the server is unreachable from this machine.");
    console.log("FIX: check the URL, and that you are not behind a network that blocks it.\n");
    process.exit(1);
  }

  const { response, body } = init;
  console.log(`HTTP status:      ${response.status} ${response.statusText}`);
  const challenge = response.headers.get("www-authenticate");
  if (challenge) console.log(`www-authenticate: ${challenge}`);

  if (response.status === 401 || response.status === 403) {
    console.log("\nVERDICT: the server rejected the request.");
    if (!TOKEN) {
      console.log("It needs credentials and none were sent.");
    } else {
      console.log("The token that was sent was not accepted.");
    }
    if (challenge && /oauth|bearer.*resource_metadata/i.test(challenge)) {
      console.log(
        "\nThe challenge above points at an OAuth flow. That is an interactive\n" +
          "browser sign-in, which the Claude API's MCP connector cannot perform —\n" +
          "it can only send a token it is given. Unless that service can issue a\n" +
          "long-lived token you can paste into .env, this cannot be connected\n" +
          "this way, and no change to this project would fix it."
      );
    }
    console.log();
    process.exit(1);
  }

  if (!response.ok) {
    console.log(`body: ${JSON.stringify(body).slice(0, 300)}`);
    console.log("\nVERDICT: the server answered with an error. See the body above.\n");
    process.exit(1);
  }

  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  console.log(`session id:       ${sessionId ? "issued" : "none"}`);

  const listed = await rpc("tools/list", {}, sessionId);
  const tools = (listed.body as { result?: { tools?: Array<{ name?: string }> } })?.result?.tools;
  if (!Array.isArray(tools)) {
    console.log(`tools/list said:  ${JSON.stringify(listed.body).slice(0, 300)}`);
    console.log("\nVERDICT: connected, but it did not return a tool list.\n");
    process.exit(1);
  }

  const names = tools.map((tool) => tool.name).filter(Boolean) as string[];
  const matched = READ_ONLY_TOOLS.filter((name) => names.includes(name));
  const missing = READ_ONLY_TOOLS.filter((name) => !names.includes(name));

  console.log(`tools offered:    ${names.length}`);
  console.log(`allowlist match:  ${matched.length} of ${READ_ONLY_TOOLS.length}`);
  if (missing.length) console.log(`   not on server: ${missing.join(", ")}`);
  const writers = names.filter((name) => /place|cancel|exercise|sell|buy/i.test(name));
  if (writers.length) {
    console.log(`   (server also offers ${writers.length} order tools; none are enabled here)`);
  }

  if (matched.length === 0) {
    console.log("\nVERDICT: connected, but none of the allowed tool names exist here.");
    console.log("FIX: paste the tool list above to me and I will correct the names.\n");
    process.exit(1);
  }

  console.log("\nVERDICT: working. The account is reachable and read-only access is live.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
