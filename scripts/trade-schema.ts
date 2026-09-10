#!/usr/bin/env node
/**
 * Prints the accounts you can trade in, and the input schema of the account
 * server's order tools.
 *
 * Read-only: it lists accounts, tools and their declared parameters, and places
 * nothing.
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

/**
 * Which account an order goes to is the one field nothing else can check for
 * you: brokers hand out more than one number per account, and the wrong one is
 * a rejected order at best. So print them next to the flag that says whether an
 * agent may trade there, and say plainly which one belongs in .env.
 */
async function printAccounts(client: McpClient): Promise<void> {
  console.log("\nAccounts\n" + "=".repeat(40));

  const names = await client.listTools();
  const tool = names.find((name) => /^get_accounts$/i.test(name));
  if (!tool) {
    console.log("This server offers no way to list accounts. Skipping.\n");
    return;
  }

  let payload: unknown;
  try {
    payload = await client.callTool(tool, {});
  } catch (error) {
    console.log(`Could not list accounts: ${error instanceof Error ? error.message : error}\n`);
    return;
  }

  const accounts = extractAccounts(payload);
  if (!accounts.length) {
    console.log("No accounts came back. Raw response:");
    console.log(`${JSON.stringify(payload).slice(0, 600)}\n`);
    return;
  }

  for (const account of accounts) {
    const allowed = account.agentic_allowed;
    console.log("-".repeat(40));
    console.log(`  account_number      ${account.account_number ?? "(none)"}   <- JARVIS_TRADING_ACCOUNT`);
    console.log(`  rhs_account_number  ${account.rhs_account_number ?? "(none)"}`);
    console.log(`  agentic_allowed     ${allowed === undefined ? "(not stated)" : allowed}`);
    if (account.type) console.log(`  type                ${account.type}`);
    if (allowed === false) {
      console.log("  This account rejects agent-placed orders.");
    }
  }
  console.log("-".repeat(40));
  console.log(
    "\nPut the account_number of an agentic_allowed account in .env as\n" +
      "JARVIS_TRADING_ACCOUNT. Equity orders use account_number, not\n" +
      "rhs_account_number — they are often different.\n"
  );
}

interface AccountRow {
  account_number?: string;
  rhs_account_number?: string;
  agentic_allowed?: boolean;
  type?: string;
}

/** The shape varies: a bare array, or one wrapped in results/accounts/data. */
function extractAccounts(payload: unknown): AccountRow[] {
  const seen = payload as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(seen)) return seen as AccountRow[];
  if (seen && typeof seen === "object") {
    for (const key of ["results", "accounts", "data", "items"]) {
      const value = (seen as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as AccountRow[];
    }
  }
  return [];
}

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

  await printAccounts(client);

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
