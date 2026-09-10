/**
 * Builds an order payload from the server's own declared schema.
 *
 * Hardcoding field names is how you buy a hundred shares when you meant a
 * hundred dollars: "quantity" and "amount" are both plausible names for both
 * things, and only the schema says which is which. So the intent is expressed
 * in normalized terms here and mapped onto whatever the server actually
 * declares — and if a required field cannot be filled, this refuses rather
 * than sending a half-formed order.
 */

export interface OrderIntent {
  symbol: string;
  side: "buy" | "sell";
  /** Exactly one of these. */
  quantity?: number;
  notional?: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  accountNumber?: string;
}

interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>;
}

/** Candidate property names per concept, best first. */
const FIELD_ALIASES = {
  symbol: ["symbol", "ticker", "instrument_symbol", "instrument"],
  side: ["side", "direction", "action"],
  orderType: ["type", "order_type", "orderType"],
  quantity: ["quantity", "shares", "qty", "share_quantity"],
  notional: ["amount", "notional", "dollar_amount", "notional_amount"],
  limitPrice: ["limit_price", "price", "limitPrice"],
  timeInForce: ["time_in_force", "timeInForce", "tif"],
  account: ["account_number", "account_id", "accountNumber", "account"],
} as const;

/** Preference order for a day order that expires rather than resting. */
const TIME_IN_FORCE_PREFERENCE = ["gfd", "day", "gtc", "ioc", "fok", "opg"];

export class OrderMappingError extends Error {}

function pick(schema: JsonSchema, aliases: readonly string[]): string | null {
  const properties = schema.properties ?? {};
  for (const alias of aliases) {
    if (alias in properties) return alias;
  }
  // Fall back to a case-insensitive match before giving up.
  const lowered = new Map(Object.keys(properties).map((key) => [key.toLowerCase(), key]));
  for (const alias of aliases) {
    const hit = lowered.get(alias.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Matches our value against the schema's enum, respecting its casing. */
function enumValue(
  schema: JsonSchema,
  field: string,
  wanted: string
): string | undefined {
  const options = schema.properties?.[field]?.enum;
  if (!Array.isArray(options) || options.length === 0) return wanted;
  const match = options.find(
    (option) => typeof option === "string" && option.toLowerCase() === wanted.toLowerCase()
  );
  return typeof match === "string" ? match : undefined;
}

/** Numbers go out as strings when the schema says string — brokers are picky. */
function coerce(schema: JsonSchema, field: string, value: number): string | number {
  return schema.properties?.[field]?.type === "string" ? String(value) : value;
}

export function buildOrderArgs(
  rawSchema: unknown,
  intent: OrderIntent
): Record<string, unknown> {
  const schema = (rawSchema ?? {}) as JsonSchema;
  if (!schema.properties) {
    throw new OrderMappingError(
      "The account server did not declare what an order needs, so one cannot be built safely."
    );
  }

  const args: Record<string, unknown> = {};
  const missing: string[] = [];

  const symbolField = pick(schema, FIELD_ALIASES.symbol);
  if (!symbolField) throw new OrderMappingError("The order tool declares no field for the symbol.");
  args[symbolField] = intent.symbol;

  const sideField = pick(schema, FIELD_ALIASES.side);
  if (!sideField) throw new OrderMappingError("The order tool declares no field for buy or sell.");
  const side = enumValue(schema, sideField, intent.side);
  if (side === undefined) {
    throw new OrderMappingError(`The order tool does not accept "${intent.side}" as a side.`);
  }
  args[sideField] = side;

  const typeField = pick(schema, FIELD_ALIASES.orderType);
  if (typeField) {
    const type = enumValue(schema, typeField, intent.orderType);
    if (type === undefined) {
      throw new OrderMappingError(
        `The order tool does not accept "${intent.orderType}" orders.`
      );
    }
    args[typeField] = type;
  } else if (intent.orderType === "limit") {
    throw new OrderMappingError("The order tool declares no order type, so a limit cannot be set.");
  }

  if (intent.quantity !== undefined) {
    const field = pick(schema, FIELD_ALIASES.quantity);
    if (!field) throw new OrderMappingError("The order tool declares no field for a share count.");
    args[field] = coerce(schema, field, intent.quantity);
  } else if (intent.notional !== undefined) {
    const field = pick(schema, FIELD_ALIASES.notional);
    if (!field) {
      throw new OrderMappingError(
        "The order tool declares no field for a dollar amount, so this must be given in shares."
      );
    }
    args[field] = coerce(schema, field, intent.notional);
  }

  if (intent.orderType === "limit") {
    const field = pick(schema, FIELD_ALIASES.limitPrice);
    if (!field) throw new OrderMappingError("The order tool declares no field for a limit price.");
    if (intent.limitPrice === undefined) {
      throw new OrderMappingError("A limit order needs a limit price.");
    }
    args[field] = coerce(schema, field, intent.limitPrice);
  }

  const tifField = pick(schema, FIELD_ALIASES.timeInForce);
  if (tifField) {
    const options = schema.properties[tifField]?.enum;
    if (Array.isArray(options) && options.length) {
      const chosen = TIME_IN_FORCE_PREFERENCE.map((wanted) =>
        options.find((o) => typeof o === "string" && o.toLowerCase() === wanted)
      ).find(Boolean);
      args[tifField] = chosen ?? options[0];
    } else {
      args[tifField] = "gfd";
    }
  }

  const accountField = pick(schema, FIELD_ALIASES.account);
  const flagged = new Set<string>();
  if (accountField) {
    if (!intent.accountNumber) {
      missing.push(`${accountField} (set JARVIS_TRADING_ACCOUNT in .env)`);
      flagged.add(accountField);
    } else {
      args[accountField] = intent.accountNumber;
    }
  }

  // Anything the server insists on that we could not fill is a hard stop: a
  // partially-formed order is worse than none.
  for (const field of schema.required ?? []) {
    if (!(field in args) && !flagged.has(field)) missing.push(field);
  }
  if (missing.length) {
    throw new OrderMappingError(
      `The order tool requires fields this cannot supply: ${missing.join(", ")}.`
    );
  }

  return args;
}
