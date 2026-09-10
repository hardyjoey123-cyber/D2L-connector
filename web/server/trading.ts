/**
 * Voice-initiated trading, structured so speech cannot place an order.
 *
 * The model gets one tool, `propose_trade`, which places nothing — it records
 * an intent and returns. The order only reaches the broker when a person types
 * the ticker symbol to confirm, at which point this module makes the call
 * itself through the MCP client. Speech recognition mishears words; that is a
 * fact about the input, not a bug to be fixed, so the design assumes it.
 *
 * Off unless JARVIS_TRADING=enabled.
 */
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import { McpClient } from "../../src/tools/mcp-client.js";
import { buildOrderArgs, OrderMappingError, type OrderIntent } from "./order-mapping.js";

/** A proposal is only good for a few minutes; prices move. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 8;

export class TradingError extends Error {}

export interface PendingTrade {
  id: string;
  intent: OrderIntent;
  summary: string;
  createdAt: number;
}

export interface TradingConfig {
  enabled: boolean;
  maxNotionalUsd: number;
  accountNumber?: string;
}

export function readTradingConfig(): TradingConfig {
  return {
    enabled: process.env.JARVIS_TRADING?.trim().toLowerCase() === "enabled",
    // A per-order ceiling that a misheard number cannot talk its way past.
    maxNotionalUsd: Number(process.env.JARVIS_MAX_TRADE_USD ?? 200),
    accountNumber: process.env.JARVIS_TRADING_ACCOUNT?.trim() || undefined,
  };
}

const SYMBOL = /^[A-Z]{1,5}$/;

export function createTrading(mcpUrl: string, config: TradingConfig) {
  const client = new McpClient(mcpUrl);
  const pending = new Map<string, PendingTrade>();

  const definitions: Anthropic.Beta.BetaToolUnion[] = [
    {
      name: "propose_trade",
      description:
        "Proposes a stock trade for the user to confirm. This does NOT place an order — it " +
        "shows the details on screen and waits for the user to type the ticker symbol to " +
        "approve. Say out loud what you are proposing and that it needs confirming on screen. " +
        "Only use this when the user clearly asked to buy or sell a specific stock; never " +
        "infer a trade from discussion of one.",
      input_schema: {
        type: "object",
        required: ["symbol", "side"],
        properties: {
          symbol: { type: "string", description: "Ticker symbol, e.g. NVDA." },
          side: { type: "string", enum: ["buy", "sell"] },
          quantity: { type: "number", description: "Number of shares. Give this or amountUsd." },
          amountUsd: { type: "number", description: "Dollar amount. Give this or quantity." },
          orderType: { type: "string", enum: ["market", "limit"] },
          limitPrice: { type: "number", description: "Required when orderType is limit." },
        },
      },
    },
  ];

  /** Rejects anything outside the account's hard rules before a human ever sees it. */
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

    // The cap is only checkable directly for dollar orders; for share counts it
    // needs a price, which a limit order supplies and a market order does not.
    const estimated =
      notional ?? (limitPrice !== undefined && quantity !== undefined ? quantity * limitPrice : undefined);
    if (estimated !== undefined && estimated > config.maxNotionalUsd) {
      throw new TradingError(
        `That is about $${estimated.toFixed(0)}, over the $${config.maxNotionalUsd} per-order limit. ` +
          "Raise JARVIS_MAX_TRADE_USD to allow more."
      );
    }

    return {
      symbol,
      side,
      quantity,
      notional,
      orderType,
      limitPrice,
      accountNumber: config.accountNumber,
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

  /** Records the intent and returns what the screen should ask about. */
  function propose(input: Record<string, unknown>): PendingTrade {
    const intent = validate(input);
    // Drop anything stale so an old proposal can't be confirmed by accident.
    for (const [id, trade] of pending) {
      if (Date.now() - trade.createdAt > CONFIRMATION_TTL_MS) pending.delete(id);
    }
    if (pending.size >= MAX_PENDING) {
      throw new TradingError("Too many unconfirmed proposals. Confirm or dismiss one first.");
    }

    const trade: PendingTrade = {
      id: crypto.randomUUID(),
      intent,
      summary: describe(intent),
      createdAt: Date.now(),
    };
    pending.set(trade.id, trade);
    return trade;
  }

  function get(id: string): PendingTrade | undefined {
    const trade = pending.get(id);
    if (!trade) return undefined;
    if (Date.now() - trade.createdAt > CONFIRMATION_TTL_MS) {
      pending.delete(id);
      return undefined;
    }
    return trade;
  }

  function dismiss(id: string): void {
    pending.delete(id);
  }

  /**
   * Places the order — the only path that reaches the broker, and it needs the
   * symbol typed exactly. Reviews first when the server offers a review tool,
   * so an order the broker would reject fails before it is live.
   */
  async function confirm(id: string, typed: string): Promise<unknown> {
    const trade = get(id);
    if (!trade) {
      throw new TradingError("That proposal has expired. Ask again if you still want it.");
    }
    if (typed.trim().toUpperCase() !== trade.intent.symbol) {
      throw new TradingError(`Type ${trade.intent.symbol} exactly to confirm.`);
    }

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

    const result = await client.callTool(placeTool.name, args);
    pending.delete(id);
    return result;
  }

  return { definitions, propose, confirm, get, dismiss };
}

export type Trading = ReturnType<typeof createTrading>;
