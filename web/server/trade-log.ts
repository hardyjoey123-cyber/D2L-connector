/**
 * A written record of every order this program sent.
 *
 * A trading bot that keeps a log and a voice assistant that does not are two
 * different things, and the one you can audit afterwards is the bot. Every
 * placement attempt lands here, successes and failures alike — a failure that
 * leaves no trace is the one that gets argued about later.
 *
 * Appended, never rewritten, and never allowed to fail an order: the log
 * exists to describe what happened, so it must not change what happens.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_PATH = path.resolve(process.env.JARVIS_TRADE_LOG?.trim() || "trade-log.md");

const HEADER = `# Trade log

Orders placed by JARVIS. Appended automatically; edit freely, nothing here is read back.

| When | Order | Result |
| --- | --- | --- |
`;

/** Table cells break on pipes and newlines, and broker errors contain both. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function logPlacement(summary: string, placed: boolean, error?: string): void {
  const when = new Date().toLocaleString();
  const result = placed ? "placed" : `failed — ${error ?? "unknown error"}`;
  const row = `| ${cell(when)} | ${cell(summary)} | ${cell(result)} |\n`;
  try {
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, HEADER, "utf8");
    fs.appendFileSync(LOG_PATH, row, "utf8");
  } catch (error) {
    // Losing the log is bad. Losing the order because the log failed is worse.
    console.warn(`Could not write ${LOG_PATH}: ${(error as Error).message}`);
  }
}

export const tradeLogPath = LOG_PATH;
