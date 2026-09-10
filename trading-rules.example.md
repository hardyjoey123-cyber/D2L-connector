<!--
  YOUR TRADING BOT'S RULES GO IN THIS FILE.

  Delete everything on this page, paste your bot's rules in, and save. That is
  the whole job. The rules are read fresh every time you ask JARVIS something,
  so you can edit them and the next question already follows the new version —
  no restart.

  What to paste: whatever your bot works from. Its instructions, its strategy,
  its standard operating procedure, its checklist, its position sizing, the
  things it is never allowed to do. Plain English is fine; it does not need to
  be code, and it does not need to be tidy.

  What happens then: before JARVIS places anything, it has to get past these
  rules. Ask it to buy something your rules forbid and it says which rule
  stopped it and places nothing.

  What this file does NOT do: it cannot raise your money limits. The per-order
  and per-day caps live in .env (JARVIS_MAX_TRADE_USD, JARVIS_DAILY_TRADE_USD)
  and are checked in code, after the rules. Nothing written here can talk its
  way past them — that is deliberate, so a rule you paste in badly cannot cost
  you more than the caps allow.

  While this page is untouched, JARVIS trades on its own judgement inside those
  caps. Your bot is almost certainly stricter than that, which is the point of
  moving it here.

  Keeping the file somewhere else, or under a different name, is fine — put the
  path in .env as JARVIS_TRADING_RULES.
-->
