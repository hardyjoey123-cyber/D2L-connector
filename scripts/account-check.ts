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

/** Pulls the URL out of a `Bearer resource_metadata="…"` challenge. */
function resourceMetadataUrl(challenge: string): string | null {
  return /resource_metadata="([^"]+)"/i.exec(challenge)?.[1] ?? null;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.log(`   ${url} -> HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    console.log(`   ${url} -> ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Follows OAuth discovery to answer one question: can a client like this one
 * register itself, or is registration closed to pre-approved partners? That
 * decides whether building the sign-in flow here is worth anyone's time.
 */
async function probeOAuth(challenge: string) {
  const metadataUrl = resourceMetadataUrl(challenge);
  if (!metadataUrl) {
    console.log("The challenge names no metadata URL, so there is nothing to follow.");
    return;
  }

  const resource = await getJson(metadataUrl);
  if (!resource) {
    console.log("\nVERDICT: the metadata document could not be read.");
    return;
  }

  const servers = Array.isArray(resource.authorization_servers)
    ? (resource.authorization_servers as string[])
    : [];
  console.log(`   scopes advertised:      ${JSON.stringify(resource.scopes_supported ?? "none")}`);
  console.log(`   authorization servers:  ${servers.length ? servers.join(", ") : "none listed"}`);

  const issuer = servers[0];
  if (!issuer) {
    console.log("\nVERDICT: no authorization server is advertised, so there is no sign-in to run.");
    return;
  }

  const base = issuer.replace(/\/$/, "");
  const config =
    (await getJson(`${base}/.well-known/oauth-authorization-server`)) ??
    (await getJson(`${base}/.well-known/openid-configuration`));
  if (!config) {
    console.log("\nVERDICT: the authorization server's configuration could not be read.");
    return;
  }

  const registration = config.registration_endpoint as string | undefined;
  console.log(`   authorization endpoint: ${config.authorization_endpoint ?? "none"}`);
  console.log(`   token endpoint:         ${config.token_endpoint ?? "none"}`);
  console.log(`   registration endpoint:  ${registration ?? "NONE — registration is closed"}`);
  console.log(
    `   PKCE methods:           ${JSON.stringify(config.code_challenge_methods_supported ?? "none")}`
  );

  if (registration) {
    console.log(
      "\nVERDICT: this service supports open client registration, so a sign-in\n" +
        "flow could be built here — the server would run the browser sign-in once,\n" +
        "then keep the token refreshed and hand it to the API."
    );
  } else {
    console.log(
      "\nVERDICT: registration is closed to pre-approved clients only. Nothing\n" +
        "built here can obtain a token, so this cannot be connected this way."
    );
  }
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
        "\nThe challenge points at an OAuth flow. The Claude API's MCP connector\n" +
          "can only send a token it is handed, so something has to obtain one first.\n" +
          "Checking whether this service lets a client like this one register…\n"
      );
      await probeOAuth(challenge);
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
