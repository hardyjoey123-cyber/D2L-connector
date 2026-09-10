/**
 * Voice-initiated trading.
 *
 * The model never places an order. It calls `propose_trade`, which records an
 * intent; placement happens here, in one of three modes:
 *
 *   typed     — a person types the ticker on screen. Nothing is placed without it.
 *   countdown — hands-free. The order is announced and placed after a few
 *               seconds unless cancelled, by voice, key or button.
 *   none      — placed immediately.
 *
 * The modes exist because "no approval" and "no safeguard" are different asks.
 * Speech recognition mishears words; a countdown keeps the flow hands-free
 * while still leaving somewhere for a misheard order to be stopped. `none`
 * removes that, and is documented as doing so.
 *
 * Off entirely unless JARVIS_TRADING=enabled.
 */
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import { McpClient } from "../../src/tools/mcp-client.js";
import { describeAccount, fetchAccounts, tradableAccounts } from "../../src/tools/accounts.js";
import { buildOrderArgs, OrderMappingError, type OrderIntent } from "./order-mapping.js";
import { logPlacement } from "./trade-log.js";

/** A proposal is only good for a few minutes; prices move. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 8;

export type ConfirmMode = "typed" | "countdown" | "none";

export class TradingError extends Error {}

/**
 * Why this trade exists. Recorded with the order because a log that says only
 * what was bought cannot tell you afterwards whether the rules were followed —
 * and a rulebook that asks the agent to learn from its own history needs the
 * history to say what the signal was.
 */
export interface TradeRationale {
  signalType: string;
  signalDetail: string;
  thesis: string;
}

export interface PendingTrade {
  id: string;
  intent: OrderIntent;
  summary: string;
  rationale: TradeRationale;
  createdAt: number;
  /** Set in countdown mode: when this order places itself. */
  placesAt?: number;
}

export interface TradingConfig {
  enabled: boolean;
  confirmMode: ConfirmMode;
  countdownSeconds: number;
  maxNotionalUsd: number;
  /** Ceiling on everything placed today, across orders. 0 disables it. */
  dailyLimitUsd: number;
  accountNumber?: string;
}

export function readTradingConfig(): TradingConfig {
  const mode = (process.env.JARVIS_TRADING_CONFIRM?.trim().toLowerCase() ??
    "typed") as ConfirmMode;
  return {
    enabled: process.env.JARVIS_TRADING?.trim().toLowerCase() === "enabled",
    confirmMode: mode === "countdown" || mode === "none" ? mode : "typed",
    countdownSeconds: Math.max(0, Number(process.env.JARVIS_TRADING_COUNTDOWN ?? 8)),
    // A per-order ceiling that a misheard number cannot talk its way past.
    maxNotionalUsd: Number(process.env.JARVIS_MAX_TRADE_USD ?? 200),
    // The backstop that matters most without a human in the loop: one bad
    // afternoon is bounded even if every individual order looks reasonable.
    dailyLimitUsd: Number(process.env.JARVIS_DAILY_TRADE_USD ?? 1000),
    accountNumber: process.env.JARVIS_TRADING_ACCOUNT?.trim() || undefined,
  };
}

const SYMBOL = /^[A-Z]{1,5}$/;

export interface PlacementOutcome {
  id: string;
  summary: string;
  placed: boolean;
  error?: string;
  result?: unknown;
}

export function createTrading(mcpUrl: string, config: TradingConfig) {
  const client = new McpClient(mcpUrl);
  const pending = new Map<string, PendingTrade>();
  const timers = new Map<string, NodeJS.Timeout>();
  /** Listeners for orders that place themselves, so the page can be told. */
  const watchers = new Set<(outcome: PlacementOutcome) => void>();

  let spentToday = 0;
  let spendDay = new Date().toDateString();

  function today(): string {
    return new Date().toDateString();
  }

  function spendSoFar(): number {
    if (spendDay !== today()) {
      spendDay = today();
      spentToday = 0;
    }
    return spentToday;
  }

  /** Only dollar-denominated orders can be counted before they fill. */
  function recordSpend(intent: OrderIntent): void {
    const known = estimatedCost(intent);
    if (known !== undefined) spentToday = spendSoFar() + known;
  }

  function estimatedCost(intent: OrderIntent): number | undefined {
    if (intent.notional !== undefined) return intent.notional;
    if (intent.limitPrice !== undefined && intent.quantity !== undefined) {
      return intent.quantity * intent.limitPrice;
    }
    return undefined;
  }

  const definitions: Anthropic.Beta.BetaToolUnion[] = [
    {
      name: "propose_trade",
      description:
        config.confirmMode === "typed"
          ? "Proposes a stock trade for the user to confirm. This does NOT place an order — it " +
            "shows the details on screen and waits for the user to type the ticker symbol to " +
            "approve. Say what you are proposing and that it needs confirming on screen. Only " +
            "use this when the user clearly asked to buy or sell a specific stock; never infer " +
            "a trade from discussion of one."
          : "Places a stock trade in the user's brokerage account. This spends real money and " +
            "cannot be undone. Say clearly and immediately what is being bought or sold, the " +
            "size, and that it can be cancelled by saying cancel. Only use this when the user " +
            "clearly asked to buy or sell a specific stock; never infer a trade from discussion " +
            "of one, and never place one they did not ask for.",
      input_schema: {
        type: "object",
        required: ["symbol", "side", "signalType", "signalDetail", "thesis"],
        properties: {
          symbol: { type: "string", description: "Ticker symbol, e.g. NVDA." },
          side: { type: "string", enum: ["buy", "sell"] },
          quantity: { type: "number", description: "Number of shares. Give this or amountUsd." },
          amountUsd: { type: "number", description: "Dollar amount. Give this or quantity." },
          orderType: { type: "string", enum: ["market", "limit"] },
          limitPrice: { type: "number", description: "Required when orderType is limit." },
          // Recorded, not decorative: these are what the log is read back for.
          signalType: {
            type: "string",
            enum: ["congress", "insider", "macro", "direct", "exit"],
            description:
              "Where this trade came from. Use direct when the user asked for this " +
              "specific trade themselves, and exit when closing a position under an " +
              "exit rule. Never invent a signal to fill this in — if the user simply " +
              "asked for it, that is direct.",
          },
          signalDetail: {
            type: "string",
            description:
              "The specific evidence, in one line: who bought, when, how much, the " +
              "filing, the divergence — or, for a direct trade, what the user asked for.",
          },
          thesis: {
            type: "string",
            description: "One sentence on why this trade should work.",
          },
        },
      },
    },
  ];

  /** Rejects anything outside the account's hard rules before it can be placed. */
  function validate(input: Record<string, unknown>): OrderIntent {
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    if (!SYMBOL.test(symbol)) {
      throw new TradingError(
        `"${input.symbol}" is not a US ticker symbol. Only listed stocks and ETFs are allowed.`
      );
    }

    const side = String(input.side ?? "").toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new TradingError("The side must be buy or sell.");
    }

    const orderType = String(input.orderType ?? "market").toLowerCase();
    if (orderType !== "market" && orderType !== "limit") {
      throw new TradingError("Only market and limit orders are allowed.");
    }

    const quantity = input.quantity === undefined ? undefined : Number(input.quantity);
    const notional = input.amountUsd === undefined ? undefined : Number(input.amountUsd);
    if ((quantity === undefined) === (notional === undefined)) {
      throw new TradingError("Give either a number of shares or a dollar amount, not both.");
    }
    if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) {
      throw new TradingError("The number of shares must be a positive number.");
    }
    if (notional !== undefined && (!Number.isFinite(notional) || notional <= 0)) {
      throw new TradingError("The dollar amount must be positive.");
    }

    const limitPrice = input.limitPrice === undefined ? undefined : Number(input.limitPrice);
    if (orderType === "limit" && (!Number.isFinite(limitPrice) || (limitPrice ?? 0) <= 0)) {
      throw new TradingError("A limit order needs a positive limit price.");
    }
    // Brokers size a dollar order from the live price, which a limit order does
    // not have — Robinhood declares its dollar field market-only. Catch it here
    // rather than letting the broker reject it after the order was announced.
    if (orderType === "limit" && notional !== undefined) {
      throw new TradingError(
        "A limit order has to be a number of shares, not a dollar amount. " +
          "Say how many shares, or place it at market."
      );
    }

    const thesis = String(input.thesis ?? "").trim();
    const signalType = String(input.signalType ?? "").trim().toLowerCase();
    if (!signalType || !thesis) {
      throw new TradingError(
        "Every trade has to record where it came from and why. Say the signal and the thesis."
      );
    }

    const intent: OrderIntent = {
      symbol,
      side,
      quantity,
      notional,
      orderType,
      limitPrice,
      accountNumber: config.accountNumber,
    };

    // Buys spend; sells raise cash, so only buys are measured against the caps.
    const estimated = estimatedCost(intent);
    if (side === "buy" && estimated !== undefined) {
      if (estimated > config.maxNotionalUsd) {
        throw new TradingError(
          `That is about $${estimated.toFixed(0)}, over the $${config.maxNotionalUsd} per-order ` +
            "limit. Raise JARVIS_MAX_TRADE_USD to allow more."
        );
      }
      if (config.dailyLimitUsd > 0 && spendSoFar() + estimated > config.dailyLimitUsd) {
        throw new TradingError(
          `That would take today's buying to about $${(spendSoFar() + estimated).toFixed(0)}, ` +
            `over the $${config.dailyLimitUsd} daily limit. Nothing was placed.`
        );
      }
    }

    return intent;
  }

  function rationaleOf(input: Record<string, unknown>): TradeRationale {
    return {
      signalType: String(input.signalType ?? "").trim().toLowerCase() || "unrecorded",
      signalDetail: String(input.signalDetail ?? "").trim() || "not given",
      thesis: String(input.thesis ?? "").trim() || "not given",
    };
  }

  function describe(intent: OrderIntent): string {
    const size =
      intent.quantity !== undefined
        ? `${intent.quantity} share${intent.quantity === 1 ? "" : "s"} of`
        : `$${intent.notional} of`;
    const price =
      intent.orderType === "limit" ? ` with a limit of $${intent.limitPrice}` : " at market";
    return `${intent.side === "buy" ? "Buy" : "Sell"} ${size} ${intent.symbol}${price}`;
  }

  function sweepExpired(): void {
    for (const [id, trade] of pending) {
      if (trade.placesAt === undefined && Date.now() - trade.createdAt > CONFIRMATION_TTL_MS) {
        pending.delete(id);
      }
    }
  }

  /** The single path to the broker. Everything else routes through here. */
  async function place(trade: PendingTrade): Promise<unknown> {
    const definitions = await client.listToolDefinitions();
    const placeTool = definitions.find((tool) => /^place_equity_order$/i.test(tool.name));
    if (!placeTool) {
      throw new TradingError(
        "This account server offers no way to place an equity order, so nothing was sent."
      );
    }

    let args: Record<string, unknown>;
    try {
      args = buildOrderArgs(placeTool.inputSchema, trade.intent);
    } catch (error) {
      if (error instanceof OrderMappingError) throw new TradingError(error.message);
      throw error;
    }

    const reviewTool = definitions.find((tool) => /^review_equity_order$/i.test(tool.name));
    if (reviewTool) {
      // A rejection here is the broker refusing before any money moves.
      await client.callTool(reviewTool.name, buildOrderArgs(reviewTool.inputSchema, trade.intent));
    }

    let result: unknown;
    try {
      result = await client.callTool(placeTool.name, args);
    } catch (error) {
      logPlacement(trade, config.confirmMode, config.countdownSeconds, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
    recordSpend(trade.intent);
    logPlacement(trade, config.confirmMode, config.countdownSeconds, true);
    return result;
  }

  function announce(outcome: PlacementOutcome): void {
    for (const watcher of watchers) {
      try {
        watcher(outcome);
      } catch {
        /* a failing listener must not affect the order */
      }
    }
  }

  function cancelTimer(id: string): void {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  /**
   * Records the intent and, depending on the mode, places it now, schedules it,
   * or leaves it for a typed confirmation.
   */
  async function propose(
    input: Record<string, unknown>
  ): Promise<{ trade: PendingTrade; mode: ConfirmMode; result?: unknown }> {
    const intent = validate(input);
    sweepExpired();
    if (pending.size >= MAX_PENDING) {
      throw new TradingError("Too many orders in flight. Wait for them to settle.");
    }

    const trade: PendingTrade = {
      id: crypto.randomUUID(),
      intent,
      summary: describe(intent),
      rationale: rationaleOf(input),
      createdAt: Date.now(),
    };

    if (config.confirmMode === "none") {
      const result = await place(trade);
      return { trade, mode: "none", result };
    }

    if (config.confirmMode === "countdown") {
      trade.placesAt = Date.now() + config.countdownSeconds * 1000;
      pending.set(trade.id, trade);
      timers.set(
        trade.id,
        setTimeout(() => {
          timers.delete(trade.id);
          if (!pending.has(trade.id)) return; // cancelled in the meantime
          pending.delete(trade.id);
          place(trade)
            .then((result) =>
              announce({ id: trade.id, summary: trade.summary, placed: true, result })
            )
            .catch((error) =>
              announce({
                id: trade.id,
                summary: trade.summary,
                placed: false,
                error: error instanceof Error ? error.message : String(error),
              })
            );
        }, config.countdownSeconds * 1000)
      );
      return { trade, mode: "countdown" };
    }

    pending.set(trade.id, trade);
    return { trade, mode: "typed" };
  }

  function get(id: string): PendingTrade | undefined {
    const trade = pending.get(id);
    if (!trade) return undefined;
    if (trade.placesAt === undefined && Date.now() - trade.createdAt > CONFIRMATION_TTL_MS) {
      pending.delete(id);
      return undefined;
    }
    return trade;
  }

  /** Stops a pending order, whether it was waiting on a person or a timer. */
  function dismiss(id: string): boolean {
    cancelTimer(id);
    return pending.delete(id);
  }

  /** Typed confirmation: requires the ticker, exactly. */
  async function confirm(id: string, typed: string): Promise<unknown> {
    const trade = get(id);
    if (!trade) {
      throw new TradingError("That proposal has expired. Ask again if you still want it.");
    }
    if (typed.trim().toUpperCase() !== trade.intent.symbol) {
      throw new TradingError(`Type ${trade.intent.symbol} exactly to confirm.`);
    }
    cancelTimer(id);
    pending.delete(id);
    return place(trade);
  }

  /**
   * Checks at start-up that the configured account can actually take an order.
   *
   * Without this the first sign of a wrong account number is a rejection in the
   * middle of a spoken trade — the worst possible moment to discover a config
   * mistake. It is advisory only: it never blocks start-up and never throws,
   * because a broker that is briefly unreachable should not stop the assistant
   * answering questions about coursework.
   */
  async function preflight(): Promise<string[]> {
    let accounts;
    try {
      accounts = await fetchAccounts(client);
    } catch (error) {
      return [
        `  Could not check the trading account: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }
    if (!accounts.length) return []; // nothing to check against

    const tradable = tradableAccounts(accounts);
    const configured = config.accountNumber;

    if (!configured) {
      return tradable.length
        ? [
            "  JARVIS_TRADING_ACCOUNT is not set, so no order can be placed.",
            `  Set it to ${describeAccount(tradable[0])}.`,
          ]
        : ["  JARVIS_TRADING_ACCOUNT is not set, so no order can be placed."];
    }

    const match = accounts.find((account) => account.account_number === configured);
    if (!match) {
      return [
        `  JARVIS_TRADING_ACCOUNT is ${configured}, which this sign-in cannot see.`,
        tradable.length
          ? `  It can trade in ${describeAccount(tradable[0])}.`
          : "  Run `npm run account:login` and grant the account you want traded.",
      ];
    }

    if (match.agentic_allowed === true) {
      return [`  Trading account ${describeAccount(match)} confirmed.`];
    }

    // The flag is caller-relative, so this is about which app signed in — not
    // about the account, which may well be agent-enabled for something else.
    return [
      `  ${describeAccount(match)} is not tradable by this sign-in, so every order will`,
      "  be rejected. This is about which app is asking, not the account itself.",
      tradable.length
        ? `  This sign-in can trade in ${describeAccount(tradable[0])}.`
        : "  Run `npm run account:login` and grant it the account you want traded.",
    ];
  }

  function onPlacement(watcher: (outcome: PlacementOutcome) => void): () => void {
    watchers.add(watcher);
    return () => watchers.delete(watcher);
  }

  return {
    definitions,
    propose,
    confirm,
    dismiss,
    get,
    onPlacement,
    preflight,
    mode: config.confirmMode,
    countdownSeconds: config.countdownSeconds,
    spentToday: spendSoFar,
  };
}

export type Trading = ReturnType<typeof createTrading>;
