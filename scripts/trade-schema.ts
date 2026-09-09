#!/usr/bin/env node
/**
 * Prints the input schema of the account server's order tools.
 *
 * Read-only: it lists tools and their declared parameters and places nothing.
 * The point is to build the order payload from what the server actually
 * declares rather than from a guess — with real money, a plausible-looking
 * field name that turns out to mean something else is the worst kind of bug.
 *
 * Usage: npm run trade:schema
 */
import "dotenv/config";

import { McpClient } from "../src/tools/mcp-client.js";
import { accountSessionAvailable } from "../src/tools/account-session.js";

const MCP_URL = process.env.JARVIS_MCP_URL?.trim();

/** Tools worth inspecting: anything that looks like it acts on an order. */
const ORDER_LIKE = /order|trade|buy|sell|exercise/i;

async function main() {
  if (!MCP_URL) {
    console.error("JARVIS_MCP_URL is not set in .env.");
    process.exit(1);
  }
  if (!accountSessionAvailable()) {
    console.error("No account sign-in saved. Run `npm run account:login` first.");
    process.exit(1);
  }

  const client = new McpClient(MCP_URL);
  console.log("\nOrder tool schemas\n" + "=".repeat(40));

  const names = await client.listTools();
  console.log(`tools offered: ${names.length}`);

  const relevant = names.filter((name) => ORDER_LIKE.test(name));
  console.log(`order-related: ${relevant.join(", ") || "(none)"}\n`);

  for (const tool of await client.listToolDefinitions()) {
    if (!ORDER_LIKE.test(tool.name)) continue;
    console.log("-".repeat(40));
    console.log(`${tool.name}`);
    if (tool.description) console.log(`  ${tool.description.slice(0, 300)}`);
    console.log(JSON.stringify(tool.inputSchema, null, 2));
    console.log();
  }

  console.log("Nothing was placed. This only reads tool definitions.\n");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
