/**
 * Reading the brokerage's account list.
 *
 * Two callers need this: the diagnostic that tells you which account to
 * configure, and the start-up check that tells you the configured one is
 * wrong. Neither should be guessing at the response shape on its own.
 */
import type { McpClient } from "./mcp-client.js";

export interface AccountRow {
  account_number?: string;
  rhs_account_number?: string;
  /**
   * Caller-relative: whether the app that asked may trade here, NOT whether the
   * account permits agents at all. The same account can be tradable for one
   * client and not another, which is why nothing here says "enable it".
   */
  agentic_allowed?: boolean;
  type?: string;
  nickname?: string;
}

/**
 * Finds the account list wherever the server chose to put it.
 *
 * Guessing at wrapper key names is a losing game — one server nests it under
 * data.accounts, the next picks something else. So look for the shape instead:
 * the first array whose entries carry an account number is the list, however
 * deeply it is buried.
 */
export function extractAccounts(payload: unknown, depth = 0): AccountRow[] {
  if (depth > 6 || payload === null || typeof payload !== "object") return [];

  if (Array.isArray(payload)) {
    const rows = payload.filter(
      (item): item is AccountRow =>
        item !== null &&
        typeof item === "object" &&
        ("account_number" in item || "rhs_account_number" in item)
    );
    if (rows.length) return rows;
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

/** The accounts this sign-in can see, or [] if the server offers no such tool. */
export async function fetchAccounts(client: McpClient): Promise<AccountRow[]> {
  const names = await client.listTools();
  const tool = names.find((name) => /^get_accounts$/i.test(name));
  if (!tool) return [];
  return extractAccounts(await client.callTool(tool, {}));
}

export function tradableAccounts(accounts: AccountRow[]): AccountRow[] {
  return accounts.filter((account) => account.agentic_allowed === true);
}

export function describeAccount(account: AccountRow): string {
  const name = account.nickname ? ` "${account.nickname}"` : "";
  return `${account.account_number ?? "(no number)"}${name}`;
}
