/**
 * The order payload, against the schema the real broker declared.
 *
 * No network and no broker: this is the one test that can prove the bytes are
 * right, because the fixture is the live schema rather than a stand-in's idea
 * of one. It is also the test that caught dollar_amount being market-only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOrderArgs } from "../web/server/order-mapping.js";
import { check, report, section } from "./support/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "place-equity-order.schema.json"), "utf8")
);
const account = "652372665";

section("Order payload against the real schema");

const buy = buildOrderArgs(schema, {
  symbol: "NVDA", side: "buy", notional: 50, orderType: "market", accountNumber: account,
});
check(
  "a dollar market buy maps onto the real field names",
  JSON.stringify(buy) ===
    JSON.stringify({
      symbol: "NVDA", side: "buy", type: "market", dollar_amount: "50",
      time_in_force: "gfd", account_number: account,
    }),
  JSON.stringify(buy)
);
check("the dollar amount goes to dollar_amount, never quantity",
  "dollar_amount" in buy && !("quantity" in buy));
check("every value the schema types as string IS a string",
  Object.entries(buy).every(([key, value]) =>
    schema.properties[key].type !== "string" || typeof value === "string"));
check("no field the schema does not declare is ever sent",
  Object.keys(buy).every((key) => key in schema.properties));
check("every required field is present",
  (schema.required as string[]).every((field) => field in buy));

const sell = buildOrderArgs(schema, {
  symbol: "TSLA", side: "sell", quantity: 2, orderType: "market", accountNumber: account,
});
check("a share sell uses quantity, as a string", sell.quantity === "2" && sell.side === "sell");

const limit = buildOrderArgs(schema, {
  symbol: "AAPL", side: "buy", quantity: 3, orderType: "limit", limitPrice: 180.5, accountNumber: account,
});
check("a limit order carries the type and the limit price",
  limit.type === "limit" && limit.limit_price === "180.5" && limit.quantity === "3");

let refused = "";
try {
  buildOrderArgs(schema, { symbol: "NVDA", side: "buy", notional: 50, orderType: "market" });
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
check("a missing account number refuses the order rather than sending a headless one",
  /JARVIS_TRADING_ACCOUNT/.test(refused), refused);

report();
