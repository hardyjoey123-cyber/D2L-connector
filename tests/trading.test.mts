/**
 * The trading paths, end to end against a stand-in broker.
 *
 * Everything here is about money moving or not moving, so the assertions are
 * on what actually reached the broker rather than on what the code returned.
 */
import fs from "node:fs";
import path from "node:path";

import { startBroker } from "./support/broker.mjs";
import { check, report, sandbox, section, sleep } from "./support/harness.mjs";

const repo = process.cwd();
const dir = sandbox();

const { createTrading, readTradingConfig } = await import(`${repo}/web/server/trading.js`);
const { ensureRulesFile, loadTradingRules, tradingRulesPrompt } = await import(
  `${repo}/web/server/strategy.js`
);

const base = {
  enabled: true as const,
  confirmMode: "countdown" as const,
  countdownSeconds: 1,
  maxNotionalUsd: 200,
  dailyLimitUsd: 1000,
  accountNumber: "652372665",
};
const reason = { signalType: "direct", signalDetail: "asked for", thesis: "a test" };
const placed = (broker: { calls: Array<{ name: string }> }) =>
  broker.calls.filter((call) => call.name === "place_equity_order");

/* ------------------------------------------------------------ confirm modes */

section("Confirmation modes");
{
  const broker = await startBroker();

  // countdown: announced now, placed later, and the outcome is broadcast.
  const trading = createTrading(broker.url, base);
  const outcomes: Array<{ placed: boolean; error?: string }> = [];
  trading.onPlacement((outcome) => outcomes.push(outcome));

  const { trade, mode } = await trading.propose({
    symbol: "NVDA", side: "buy", amountUsd: 50, ...reason,
  });
  check("countdown returns before placing", mode === "countdown" && trade.placesAt !== undefined);
  check("nothing has reached the broker yet", placed(broker).length === 0);

  await sleep(1400);
  check("the order reaches the broker", placed(broker).length === 1);
  check("the outcome is announced", outcomes[0]?.placed === true, outcomes[0]?.error ?? "");
  check(
    "the payload uses the broker's own field names",
    JSON.stringify(placed(broker)[0].args) ===
      JSON.stringify({
        symbol: "NVDA", side: "buy", type: "market", dollar_amount: "50",
        time_in_force: "gfd", account_number: "652372665",
      }),
    JSON.stringify(placed(broker)[0].args)
  );
  check("review runs before placing", broker.calls[0]?.name === "review_equity_order");

  // cancel: the timer is stopped and nothing is sent.
  const cancelled = createTrading(broker.url, base);
  const second = await cancelled.propose({ symbol: "TSLA", side: "buy", amountUsd: 40, ...reason });
  check("cancelling reports that it stopped one", cancelled.dismiss(second.trade.id) === true);
  await sleep(1400);
  check("a cancelled order never reaches the broker",
    placed(broker).filter((c) => c.args.symbol === "TSLA").length === 0);

  // none: placed inside the propose call.
  const immediate = createTrading(broker.url, { ...base, confirmMode: "none" });
  const third = await immediate.propose({ symbol: "MSFT", side: "buy", amountUsd: 25, ...reason });
  check("none places inline", third.mode === "none" && third.result !== undefined);

  await broker.close();
}

/* ------------------------------------------------------------------- limits */

section("Limits");
{
  const broker = await startBroker();
  const trading = createTrading(broker.url, { ...base, dailyLimitUsd: 120 });

  await trading.propose({ symbol: "AAPL", side: "buy", amountUsd: 100, ...reason });
  await sleep(1400);
  check("the first order is placed", placed(broker).length === 1);

  const refuse = async (input: Record<string, unknown>): Promise<string> => {
    try {
      await trading.propose(input);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  check("the daily cap refuses the second",
    /daily limit/i.test(await refuse({ symbol: "AAPL", side: "buy", amountUsd: 100, ...reason })));
  await sleep(1200);
  check("a refused order never reaches the broker", placed(broker).length === 1);

  const sell = await trading.propose({ symbol: "AAPL", side: "sell", quantity: 1, ...reason });
  check("a sell is still allowed at the cap", sell.mode === "countdown");
  trading.dismiss(sell.trade.id);

  check("the per-order cap holds",
    /per-order limit/i.test(await refuse({ symbol: "NVDA", side: "buy", amountUsd: 5000, ...reason })));
  check("a trade with no signal or thesis is refused",
    /where it came from/i.test(await refuse({ symbol: "NVDA", side: "buy", amountUsd: 10 })));
  check("a dollar limit order is refused before the broker sees it",
    /number of shares, not a dollar amount/i.test(
      await refuse({ symbol: "AAPL", side: "buy", amountUsd: 50, orderType: "limit", limitPrice: 180, ...reason })));

  await broker.close();
}

/* ----------------------------------------------------------------- rulebook */

section("Rulebook");
{
  check("a missing rulebook reads as no rules", loadTradingRules() === undefined);

  fs.copyFileSync(path.join(repo, "trading-rules.example.md"), path.join(dir, "trading-rules.example.md"));
  ensureRulesFile();
  check("the file is created from the template", fs.existsSync(path.join(dir, "trading-rules.md")));
  check("an untouched template is still no rules", loadTradingRules() === undefined);

  fs.writeFileSync(path.join(dir, "trading-rules.md"), "Never buy meme stocks.");
  check("pasted rules are read verbatim", loadTradingRules() === "Never buy meme stocks.");

  ensureRulesFile();
  check("the template does not overwrite real rules", loadTradingRules() === "Never buy meme stocks.");

  await sleep(15); // a same-millisecond write would look unchanged to the cache
  fs.writeFileSync(path.join(dir, "trading-rules.md"), "Edited.");
  check("an edit is picked up without a restart", loadTradingRules() === "Edited.");

  check("the prompt says the rules constrain trading only",
    tradingRulesPrompt("x").includes("constrain trading only"));

  await sleep(15);
  fs.writeFileSync(path.join(dir, "trading-rules.md"), "x".repeat(20_001));
  check("an oversized rulebook is refused, not truncated", loadTradingRules() === undefined);
  fs.rmSync(path.join(dir, "trading-rules.md"));
}

/* --------------------------------------------------------------- trade log */

section("Trade log");
{
  const broker = await startBroker();
  const trading = createTrading(broker.url, { ...base, confirmMode: "none" });
  await trading.propose({
    symbol: "NVDA", side: "buy", amountUsd: 50,
    signalType: "congress", signalDetail: "Rep. Example bought 2026-09-02", thesis: "follows the filing",
  });

  const log = fs.readFileSync(path.join(dir, "trade-log.md"), "utf8");
  check("the log uses the rulebook's columns",
    /\| DATE \| ACTION \| TICKER \| AMOUNT \| SIGNAL-TYPE \| SIGNAL DETAIL \| THESIS \| AUTHORIZATION \| PHASE \| RESULT \|/.test(log));
  check("the signal and thesis are recorded, not just the order",
    /\| CONGRESS \| Rep\. Example bought 2026-09-02 \| follows the filing \|/.test(log),
    log.trim().split("\n").at(-1));
  check("the mode actually used is recorded", /\| autonomous, post-notify \|/.test(log));

  const rows = log.trim().split("\n").filter((line) => line.startsWith("|"));
  check("every row has the same column count",
    rows.every((row) => row.split(/(?<!\\)\|/).length === rows[0].split(/(?<!\\)\|/).length));

  await broker.close();
}

/* ------------------------------------------------------- start-up account check */

section("Start-up account check");
{
  const accounts = [
    { account_number: "780649786", rhs_account_number: "780649786", agentic_allowed: false, type: "margin" },
    { account_number: "652372665", rhs_account_number: "652372665", agentic_allowed: true, type: "limited_margin", nickname: "Agentic" },
  ];

  const withAccounts = await startBroker({ accounts });
  const lines = async (url: string, accountNumber?: string, list = accounts) =>
    (await createTrading(url, { ...base, accountNumber }).preflight()).join(" ");

  check("the configured account is confirmed",
    /confirmed/.test(await lines(withAccounts.url, "652372665")));
  check("an unknown account number is caught and the right one named",
    /cannot see/.test(await lines(withAccounts.url, "999999999")) &&
    /652372665/.test(await lines(withAccounts.url, "999999999")));
  check("a missing account number names the one to use",
    /not set/.test(await lines(withAccounts.url, undefined)));
  await withAccounts.close();

  const noneTradable = await startBroker({
    accounts: accounts.map((account) => ({ ...account, agentic_allowed: false })),
  });
  const blocked = await lines(noneTradable.url, "652372665");
  check("an untradable account is blamed on the sign-in, not the account",
    /not tradable by this sign-in/.test(blocked) && /which app is asking/.test(blocked), blocked);
  check("it does not tell you to enable something already enabled", !/enable/i.test(blocked));
  await noneTradable.close();

  const noAccountTool = await startBroker();
  check("a broker with no account tool stays quiet",
    (await lines(noAccountTool.url, "652372665")) === "");
  await noAccountTool.close();

  check("an unreachable broker reports rather than throwing",
    /Could not check/.test(await lines("http://127.0.0.1:1", "652372665")));
}

/* -------------------------------------------------------------------- config */

section("Configuration");
{
  process.env.JARVIS_TRADING = "enabled";
  process.env.JARVIS_TRADING_CONFIRM = "COUNTDOWN";
  check("the mode is parsed case-insensitively", readTradingConfig().confirmMode === "countdown");
  process.env.JARVIS_TRADING_CONFIRM = "nonsense";
  check("an unknown mode falls back to typed", readTradingConfig().confirmMode === "typed");
  delete process.env.JARVIS_TRADING_CONFIRM;
  check("the default is typed", readTradingConfig().confirmMode === "typed");
}

report();
