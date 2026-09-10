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
    console.log(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  for (const account of accounts) {
    const allowed = account.agentic_allowed;
    console.log("-".repeat(40));
    // The marker points only at an account that could actually take an order.
    const usable = allowed === true ? "   <- JARVIS_TRADING_ACCOUNT" : "";
    console.log(`  account_number      ${account.account_number ?? "(none)"}${usable}`);
    console.log(`  rhs_account_number  ${account.rhs_account_number ?? "(none)"}`);
    console.log(`  agentic_allowed     ${allowed === undefined ? "(not stated)" : allowed}`);
    if (account.type) console.log(`  type                ${account.type}`);
    if (allowed === false) {
      console.log("  This account rejects agent-placed orders.");
    }
  }
  console.log("-".repeat(40));

  const tradeable = accounts.filter((account) => account.agentic_allowed === true);
  if (tradeable.length) {
    console.log(
      `\nPut this in .env:  JARVIS_TRADING_ACCOUNT=${tradeable[0].account_number}\n` +
        "Equity orders use account_number, not rhs_account_number — on some\n" +
        "brokers they differ.\n"
    );
  } else {
    // No amount of code gets past this one, so say so rather than letting it
    // surface later as a rejected order nobody can explain.
    console.log(
      `\nNone of these ${accounts.length} accounts has agentic_allowed=true, so the\n` +
        "broker will reject an agent-placed order in every one of them. This is a\n" +
        "setting on the broker's side, not here — agent trading has to be enabled\n" +
        "for the account before JARVIS can place anything.\n"
    );
  }
}

interface AccountRow {
  account_number?: string;
  rhs_account_number?: string;
  agentic_allowed?: boolean;
  type?: string;
}

/**
 * Finds the account list wherever the server chose to put it.
 *
 * Guessing at wrapper key names is a losing game — this one nests it under
 * data.accounts, the next will pick something else. So look for the shape
 * instead: the first array whose entries carry an account number is the list,
 * however deeply it is buried.
 */
function extractAccounts(payload: unknown, depth = 0): AccountRow[] {
  if (depth > 6 || payload === null || typeof payload !== "object") return [];

  if (Array.isArray(payload)) {
    const rows = payload.filter(
      (item): item is AccountRow =>
        item !== null &&
        typeof item === "object" &&
        ("account_number" in item || "rhs_account_number" in item)
    );
    if (rows.length) return rows;
    // An array of wrappers rather than of accounts.
    for (const item of payload) {
      const found = extractAccounts(item, depth + 1);
      if (found.length) return found;
    }
    return [];
  }

  for (const value of Object.values(payload as Record<string, unknown>)) {
    const found = extractAccounts(value, depth + 1);
    if (found.length) return found;
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
