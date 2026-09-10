# Tests

Everything here is about money moving or not moving, so the assertions are on
what actually reached the broker rather than on what a function returned.

## The ones that run anywhere

```bash
npm test
```

No setup, no network, no account. The stand-in broker starts in-process on a
random port, and each run works inside a throwaway directory holding a fake
saved session — so the trade log, the rulebook and the account token all resolve
there instead of on top of your real ones. Nothing it does can reach a brokerage.

- `order-payload.test.mts` — the order payload against
  `fixtures/place-equity-order.schema.json`, which is the schema Robinhood
  actually declared, captured verbatim. This is the only test that can prove the
  bytes are right, and it is the one that caught `dollar_amount` being
  market-only.
- `trading.test.mts` — confirmation modes, the caps, the rulebook, the trade
  log, and the start-up account check.

## The one that needs a browser

```bash
# terminal 1 — a server pointed at a stand-in, never a real account
JARVIS_TRADING=enabled JARVIS_TRADING_CONFIRM=countdown JARVIS_TRADING_COUNTDOWN=3 \
  JARVIS_MCP_URL=<stand-in url> npm run jarvis

# terminal 2
node tests/interface.test.mjs
```

Needs Playwright installed. Drives the countdown banner: that it appears instead
of the typed dialog, counts down, places, and that both Cancel and Esc leave
nothing placed.

## Adding to these

Assert on `broker.calls` — what the broker received — not on return values. A
test that checks a function returned "cancelled" while an order quietly went out
is worse than no test.
