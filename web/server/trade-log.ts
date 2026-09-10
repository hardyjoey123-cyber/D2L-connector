/**
 * A written record of every order this program sent.
 *
 * The format is the one the user's trading rulebook specifies:
 *
 *   DATE | ACTION | TICKER | $AMOUNT | SIGNAL-TYPE | SIGNAL DETAIL | THESIS |
 *   AUTHORIZATION | PHASE
 *
 * with a RESULT column added on the end, because a rulebook that asks the agent
 * to weight future decisions by its own track record needs to know which orders
 * actually reached the broker. Failures are logged too: a failure that leaves no
 * trace is the one that gets argued about later.
 *
 * Appended, never rewritten, and never allowed to fail an order — the log exists
 * to describe what happened, so it must not change what happens.
 */
import fs from "node:fs";
import path from "node:path";

import type { ConfirmMode, PendingTrade } from "./trading.js";

const LOG_PATH = path.resolve(process.env.JARVIS_TRADE_LOG?.trim() || "trade-log.md");

/** Which approval phase the rulebook is in, for the record. */
const PHASE = process.env.JARVIS_TRADING_PHASE?.trim() || "3";

const COLUMNS = [
  "DATE",
  "ACTION",
  "TICKER",
  "AMOUNT",
  "SIGNAL-TYPE",
  "SIGNAL DETAIL",
  "THESIS",
  "AUTHORIZATION",
  "PHASE",
  "RESULT",
];

const HEADER =
  `# Trade log\n\n` +
  `Every order JARVIS sent, appended automatically. Nothing here is read back by\n` +
  `the program — it is the record you and the agent read.\n\n` +
  `| ${COLUMNS.join(" | ")} |\n| ${COLUMNS.map(() => "---").join(" | ")} |\n`;

/** Table cells break on pipes and newlines, and broker errors contain both. */
function cell(text: string): string {
  const flat = String(text ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return flat || "—";
}

/** How the order came to be placed, in the terms the rulebook uses. */
function authorization(mode: ConfirmMode, countdownSeconds: number): string {
  if (mode === "typed") return "human, typed confirmation";
  if (mode === "countdown") return `voice, ${countdownSeconds}s to cancel`;
  return "autonomous, post-notify";
}

function amountOf(trade: PendingTrade): string {
  const { notional, quantity, limitPrice, orderType } = trade.intent;
  if (notional !== undefined) return `$${notional}`;
  const shares = `${quantity} sh`;
  return orderType === "limit" && limitPrice !== undefined ? `${shares} @ $${limitPrice}` : shares;
}

export function logPlacement(
  trade: PendingTrade,
  mode: ConfirmMode,
  countdownSeconds: number,
  placed: boolean,
  error?: string
): void {
  const row = [
    new Date().toISOString().slice(0, 10),
    trade.intent.side.toUpperCase(),
    trade.intent.symbol,
    amountOf(trade),
    trade.rationale.signalType.toUpperCase(),
    trade.rationale.signalDetail,
    trade.rationale.thesis,
    authorization(mode, countdownSeconds),
    PHASE,
    placed ? "placed" : `FAILED — ${error ?? "unknown error"}`,
  ];

  try {
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, HEADER, "utf8");
    fs.appendFileSync(LOG_PATH, `| ${row.map(cell).join(" | ")} |\n`, "utf8");
  } catch (error) {
    // Losing the log is bad. Losing the order because the log failed is worse.
    console.warn(`Could not write ${LOG_PATH}: ${(error as Error).message}`);
  }
}

export const tradeLogPath = LOG_PATH;
