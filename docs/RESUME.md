# JARVIS — resume here

Last updated 2026-09-10. Branch `claude/jarvis-voice-assistant-utyzzj`, all work
pushed.

## Paste this into a fresh chat to pick up

> I have a voice assistant called JARVIS in the repo hardyjoey123-cyber/D2L-connector,
> branch claude/jarvis-voice-assistant-utyzzj. It does voice in and out, reads my
> Brightspace coursework and my McGraw-Hill Connect assignments, reads my Robinhood
> account, searches the web, and places trades in my Agentic account following the
> rules in trading-rules.md. Read docs/JARVIS.md and docs/RESUME.md first — they
> explain how it fits together and where I left off. I run Windows PowerShell and I
> update by downloading the branch ZIP, not with git. Give me one command at a time.

## Where things stand

**Working and verified end to end**

- Voice interface: wake word, speech in, speech out, the visualizer, settings panel.
- Brightspace: courses, coursework, grades, announcements, discussions, quizzes.
- McGraw-Hill Connect: 66 assignments read through a captured browser session.
- Robinhood: read-only account access — balances, positions, orders, quotes, news.
- Web search.
- Trading: the whole path from a spoken sentence to an order at the broker, proven
  against a stand-in broker and against Robinhood's own declared order schema.

**Set up but never fired for real**

- No live order has ever been placed through JARVIS. Everything about placement is
  verified against a stand-in broker; the last mile — a real order in the real
  account — has not been done.

**Known limitations**

- Voice cancel during a countdown only works once JARVIS has stopped speaking,
  because the microphone is closed while it talks. The button and Esc always work.
- Market orders are regular hours only, 9:30–16:00 ET. Outside that the broker
  rejects them, and the interface says "not placed" without explaining why.
- The rulebook is capped at 20,000 characters.

## The one thing left outstanding

The SOP amendment adding "Direct instruction from Joe" as a fourth signal source is
live in `trading-rules.md`, so JARVIS follows it — but it is **not** in the
`ai-trading-agent-sop` skill or in `rule-changes-log.md`. Under your own SOP a rule
change that is not written into SKILL.md has not taken effect. The exact text for
both edits was handed over on 2026-09-10; paste it in when you next touch the SOP.

## First thing to do when you come back

```powershell
npm run trade:schema
```

It lists your accounts and the order schemas and places nothing. If account
652372665 comes back tradable, the sign-in is still good. If it does not, run
`npm run account:login` and grant the Agentic account again.
