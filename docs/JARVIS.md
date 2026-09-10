# JARVIS — what was built, and why it is shaped this way

A record of the whole project, written so a fresh session (or a future you) can
pick it up without re-deriving anything.

---

## What it is

A voice-driven assistant that runs on your own machine. You talk, it answers out
loud. Behind the voice it can read your coursework, read your brokerage account,
search the web, and place stock trades under a rulebook you write.

Three parts:

- **The page** (`web/public/`) — microphone, speech synthesis, the visualizer,
  and nothing else. It holds no keys and makes no decisions.
- **The server** (`web/server/`) — holds the API key, relays one streaming turn
  to Claude, runs the course tools, and is the only thing that can place an order.
- **The tools** (`src/tools/`) — Brightspace, McGraw-Hill Connect, and a direct
  MCP client for the brokerage.

Conversation state lives in the browser, so the server is stateless and can be
restarted mid-conversation without losing anything.

---

## The parts, in the order they were built

### The voice interface

Wake word, continuous listening, sentence-chunked speech so it starts talking
before the answer is finished, and a canvas visualizer driven by real FFT data
from the microphone and by speech-boundary events on the way out. Dark, cyan,
minimal — transcription is present but deliberately secondary.

Settings (persona, model, accent colour, wake word, web search, which
integrations are on) live in the browser, per device.

### Brightspace

Courses, coursework, grades, announcements, discussions, quizzes. The tools
already existed in this repo; the voice server calls them rather than
reimplementing them.

**What broke:** Brightspace returns collections two different ways — a bare array
sometimes, an `{Objects: [...]}` envelope other times. `quizzes.map is not a
function` on live data. Fixed with `toList()` in `src/d2lClient.ts`, and by
catching per source rather than letting one `Promise.all` discard everything.

### McGraw-Hill Connect

Brightspace showed nothing due, because the actual coursework lives in Connect.
There is no API, so: capture a real browser session, replay it.

**How it was found:** a privacy-preserving capture (`npm run connect:capture`)
that records key names and value *types* only — `{"firstName":"string"}` — never
values. That surfaced `/openapi/paam/studentAssignments`, which is what the
parser targets. 66 assignments now come back.

### Robinhood, read-only

The Claude API's MCP connector, with a default-deny toolset — 16 read tools
allowed, everything else refused server-side. Placing an order is not on that
list and cannot be reached by anything the model says.

**What broke:** `tool_configuration` on the server definition is rejected under
the `mcp-client-2025-11-20` beta. Filtering has to go on the `mcp_toolset` tool
instead.

### Signing in to the brokerage

The voice app is a separate program from any Claude session, so it cannot borrow
a connector configured elsewhere. It needs its own OAuth client: discovery,
dynamic client registration, PKCE, refresh tokens, saved to `.auth/account.json`
at mode 0600.

**What broke, and it was my error:** OAuth metadata discovery 404'd because I
built the URL as issuer + well-known. RFC 8414 puts it at root + path. Once six
standard locations were tried properly, registration turned out to be *open* —
the thing I had predicted was impossible.

### Trading

The model **cannot** place an order. It calls `propose_trade`, which records an
intent and returns. The server places it through its own MCP client — a path
nothing the model says can reach.

What sits between the words and the order is `JARVIS_TRADING_CONFIRM`:

| Mode | Behaviour |
| --- | --- |
| `typed` (default) | The order appears on screen; nothing is sent until you type the ticker. |
| `countdown` | Announced, then placed after N seconds unless cancelled by voice, Esc, or button. |
| `none` | Placed immediately. |

The modes exist because "no approval" and "no safeguard" are different asks.
Speech recognition mishears words; a countdown keeps the flow hands-free while
still leaving somewhere for a misheard order to be stopped.

In `typed` and `countdown` the model is never told the outcome, so it cannot
claim an order filled. Outcomes reach the page over `/api/events` instead.

### The rulebook

`trading-rules.md` — your own trading SOP, read fresh on every question and
prepended to the system prompt. A trade must clear it before it is proposed; if
it does not, JARVIS says which rule stopped it.

Untracked on purpose, like `.env`, so re-downloading the project cannot overwrite
what you pasted in. `trading-rules.example.md` is the shipped template.

Two things the rules deliberately cannot do: raise the dollar caps (checked in
code, after the rules), or change anything outside trading (the framing says so
explicitly). Everything about a broken rulebook — missing, unreadable, oversized
— reduces to "no rules" rather than silence.

### The trade log

Every order sent is appended to `trade-log.md` in the format the SOP specifies:

```
DATE | ACTION | TICKER | AMOUNT | SIGNAL-TYPE | SIGNAL DETAIL | THESIS | AUTHORIZATION | PHASE | RESULT
```

`propose_trade` *requires* a signal type and thesis, so they are recorded rather
than reconstructed later. RESULT is an addition to the format — which orders
actually reached the broker is exactly what a track record needs. Failures are
logged too, with the broker's own words. Writing the log can never fail an order.

---

## Configuration

All in `.env`, which is never committed.

| Setting | What it does |
| --- | --- |
| `ANTHROPIC_API_KEY` | Pays for the thinking. Prepaid credits at console.anthropic.com. |
| `JARVIS_MODEL` | `claude-opus-5` (default), `claude-sonnet-5`, or `claude-haiku-4-5`. Haiku is a fifth the price. |
| `JARVIS_EFFORT` | Default `low` — a voice reply that arrives late feels broken. |
| `JARVIS_MCP_URL` | The brokerage MCP server. |
| `JARVIS_TRADING` | `enabled` turns trading on. Off otherwise. |
| `JARVIS_TRADING_CONFIRM` | `typed` / `countdown` / `none`. |
| `JARVIS_TRADING_COUNTDOWN` | Seconds before a countdown order places. Default 8. |
| `JARVIS_TRADING_ACCOUNT` | The account orders go to. |
| `JARVIS_MAX_TRADE_USD` | Per-order ceiling. Default 200. |
| `JARVIS_DAILY_TRADE_USD` | Ceiling on all buys in a day. Default 1000. Sells raise cash, so they do not count. |
| `JARVIS_TRADING_PHASE` | Recorded in the log's PHASE column. |
| `JARVIS_TRADING_RULES` | Path to the rulebook. Default `trading-rules.md`. |
| `JARVIS_TRADE_LOG` | Path to the log. Default `trade-log.md`. |
| `BRIGHTSPACE_*` | School access. |

`.env` and `.auth/` are both untracked, which is why a fresh download needs both
copied across.

---

## Diagnostics

Every one of these was built because a vague failure report cost an hour. Each
prints a verdict rather than leaving you to interpret output.

| Command | What it tells you |
| --- | --- |
| `npm run trade:schema` | Which accounts this sign-in can trade in, and the real order schemas. Places nothing. |
| `npm run account:check` | Whether the brokerage connection and OAuth are healthy. |
| `npm run account:login` | Signs in to the brokerage and saves the session. |
| `npm run connect:check` | Whether Connect coursework is reachable. Prints a verdict. |
| `npm run connect:capture` | Captures a Connect session. Writes types, never values. |
| `npm run auth:session` | Brightspace login. |

The server also checks the trading account at start-up, so a wrong account number
is a line when it boots rather than a rejection mid-sentence.

---

## Things that will bite you

**Updating loses your settings.** You update by downloading the branch ZIP, so
every update is a new folder. `.env`, `.auth/`, and `trading-rules.md` are all
untracked and must be copied across. Switching to a git clone would make updating
one command and end this entirely — offered several times, never done.

**The PowerShell window running JARVIS is busy.** It looks frozen and will not
accept typing. That is the server running. Open a second window for anything else;
`Ctrl+C` stops it.

**Market hours.** Market orders are regular hours only. Outside 9:30–16:00 ET the
broker rejects them.

**Tradability is per-app, not per-account.** The broker's flag answers "may the
app that is asking trade here", not "does this account allow agents". An account
you already trade from elsewhere can come back unavailable simply because JARVIS
is a separate OAuth client. `npm run account:login` is what grants it.

**Cost.** Every turn resends the tool definitions, the voice rules, and the whole
rulebook, because the API is stateless. That prefix is now cached (about a tenth
of the price on reads), but the model choice still dominates — Opus is five times
Haiku. Set a spend limit in the console.

---

## What was never done

- **No live order has ever been placed.** Every placement test used a stand-in
  broker. The payload was verified against Robinhood's real declared schema, and
  the account is confirmed tradable, but the last mile is untested.
- **The SOP amendment is not in the skill.** See `docs/RESUME.md`.
- **Voice cancel while speaking.** The microphone is closed while JARVIS talks, so
  "cancel" only lands once it stops. Button and Esc always work.

---

## How this was built, if it matters later

The pattern that worked, repeatedly: when something failed, build a diagnostic
that captures what is actually happening, look at the real data, then write code
against reality. It produced the Connect integration and the OAuth path — both of
which I had predicted were probably impossible — and it caught two real bugs from
one paste of the broker's schema.

The pattern that failed: guessing. Every wrong turn in this project came from
reasoning about what an API probably does instead of asking it.
