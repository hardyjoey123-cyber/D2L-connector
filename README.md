# D2L Brightspace MCP Server

An [MCP](https://modelcontextprotocol.io) server that connects Claude directly to your
D2L Brightspace account, exposing your **courses**, **assignments**, **grades**, and
**announcements** through Brightspace's Valence Learning Framework API.

> This repository also contains **[JARVIS](#jarvis-voice-interface)**, a browser-based
> voice assistant with a heads-up-display interface. It is a separate application from
> the MCP server and shares nothing with it but the repo. See below.

## Tools

| Tool                     | Description                                                                      |
| ------------------------ | --------------------------------------------------------------------------------- |
| `list_courses`           | Lists your course enrollments (name, code, org unit ID, dates, role).             |
| `list_assignments`       | Lists dropbox/assignment folders for a course. Takes `orgUnitId`.                |
| `list_grades`            | Lists your grade values for a course. Takes `orgUnitId`.                         |
| `list_announcements`     | Lists announcements (news items) for a course. Takes `orgUnitId`.                |
| `list_quizzes`           | Lists quizzes for a course. Takes `orgUnitId`.                                   |
| `list_discussion_topics` | Lists discussion topics (across all forums) for a course. Takes `orgUnitId`.     |
| `list_discussion_posts`  | Lists posts within one discussion topic. Takes `orgUnitId` and `topicId`.        |

Note: `list_assignments` only covers Brightspace's native Dropbox folders. Coursework hosted on
a third-party publisher platform (e.g. Connect, MyLab, WileyPLUS) that a course merely links out
to won't appear here — that's a separate system outside Brightspace's API entirely.

`orgUnitId` comes from the `list_courses` result — ask Claude to list your courses first,
then query assignments/grades/announcements for whichever course you're interested in.

## Authentication

This server supports three ways to authenticate, in order of preference:

- **OAuth 2.0** (Option A) — the officially supported, recommended method.
- **Legacy Valence ID/Key** (Option B) — an older fallback for instances without OAuth.
- **Session cookie replay** (Option C) — a workaround for when your institution won't issue
  either of the above to individual users at all (common for students).

Options A and B both require an admin-registered API application. If you don't have access
to Brightspace's "Admin Tools > API Management" and can't get IT to register one for you,
skip to **Option C**.

### Option A: OAuth 2.0 (recommended)

1. Ask your Brightspace administrator to register an OAuth 2.0 application for you under
   **Admin Tools > API Management > OAuth 2.0**, or do it yourself if you have access. Set:
   - **Redirect URI**: `http://localhost:8918/callback` (or your own, if you customize
     `BRIGHTSPACE_OAUTH_REDIRECT_URI`)
   - **Scope**: grant at least the scopes this server requests by default (see
     `.env.example`'s `BRIGHTSPACE_OAUTH_SCOPE`), or narrow it to just what you need.
   - Note the generated **Client Id** and **Client Secret**.
2. Copy `.env.example` to `.env` and fill in:
   ```
   BRIGHTSPACE_DOMAIN=yourschool.brightspace.com
   BRIGHTSPACE_AUTH_METHOD=oauth
   BRIGHTSPACE_CLIENT_ID=...
   BRIGHTSPACE_CLIENT_SECRET=...
   ```
3. Run the one-time authorization flow to get a refresh token:
   ```
   npm install
   npm run auth:oauth
   ```
   This opens a local callback server, prints a Brightspace login URL for you to open in a
   browser, and on approval exchanges the authorization code for a refresh token. Copy the
   printed `BRIGHTSPACE_REFRESH_TOKEN` value into `.env`.

   The server automatically refreshes the access token as needed using this refresh token,
   so you shouldn't need to repeat this step unless the refresh token is revoked. If
   Brightspace rotates the refresh token during use, the server logs the new value to
   stderr — update `.env` if that happens.

### Option B: Legacy Valence ID/Key

This is D2L's original (pre-OAuth) Valence authentication scheme: your registered API
Application has an App Id/App Key, and each authorizing user gets a User Id/User Key,
combined via HMAC-SHA256 request signing.

1. Register an "API Application" in Brightspace (Admin Tools > API Management) to get an
   **App Id** and **App Key**.
2. Copy `.env.example` to `.env` and fill in:
   ```
   BRIGHTSPACE_DOMAIN=yourschool.brightspace.com
   BRIGHTSPACE_AUTH_METHOD=apikey
   BRIGHTSPACE_APP_ID=...
   BRIGHTSPACE_APP_KEY=...
   ```
3. Run the helper script to obtain your personal User Id/User Key:
   ```
   npm install
   npm run auth:apikey
   ```
   Open the printed URL, log in to Brightspace, and the script prints the raw callback
   parameters Brightspace sends back. **Field names for the user id/key vary by
   Brightspace version** — the script prints the full raw response so you can match it
   against your instance's documentation rather than guessing. Put the resulting values in
   `.env` as `BRIGHTSPACE_USER_ID` / `BRIGHTSPACE_USER_KEY`.

   If this doesn't work on your instance, use Option A (OAuth) instead — it's the modern,
   fully standardized path.

### Option C: Session cookie workaround (no admin access needed)

Many institutions (especially for student accounts) don't expose API application
registration to anyone but IT/LMS admins. If that's you, this option authenticates by
reusing your own logged-in browser session instead of an API credential — no admin
involvement required.

**Read this before using it:**
- Your **password is never seen or stored** by this tool. Only the resulting session
  cookies are saved locally, and only after you log in yourself in a real browser window.
- This calls Brightspace's own internal JSON API endpoints (the same ones its web UI uses)
  authenticated as your browser session, rather than through a sanctioned API credential.
  Automated access like this is commonly against an institution's acceptable-use policy for
  their LMS, even when it's your own data — use your judgment about your school's rules.
- Sessions expire (typically hours to a couple of weeks, depending on your school's
  settings), so you'll periodically need to redo the one-time login below.
- If your school ever tightens security around the API endpoints this depends on, this
  method can stop working with no warning; Options A/B are more durable when available.

Setup:

1. Copy `.env.example` to `.env` and fill in:
   ```
   BRIGHTSPACE_DOMAIN=d2l.yourschool.edu
   BRIGHTSPACE_AUTH_METHOD=session
   ```
2. Install dependencies and the Playwright browser binary it needs:
   ```
   npm install
   npx playwright install chromium
   ```
3. Log in interactively:
   ```
   npm run auth:session
   ```
   A real Chromium window opens to your Brightspace login page. Log in exactly as you
   normally would, including any two-factor/SSO step your school requires. Once you land on
   your Brightspace dashboard, the script detects it, saves your session to
   `.auth/storageState.json` (already gitignored — never commit this file), and closes the
   browser.
4. Whenever a tool call fails with a message about an expired session, just re-run
   `npm run auth:session`.

## Running the server

```
npm install
npm run build
npm start
```

Or for local development without a build step: `npm run dev`.

## Connecting to Claude

Add this server to your Claude Desktop config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "d2l-brightspace": {
      "command": "node",
      "args": ["/absolute/path/to/D2L-connector/dist/src/index.js"],
      "env": {
        "BRIGHTSPACE_DOMAIN": "yourschool.brightspace.com",
        "BRIGHTSPACE_AUTH_METHOD": "oauth",
        "BRIGHTSPACE_CLIENT_ID": "...",
        "BRIGHTSPACE_CLIENT_SECRET": "...",
        "BRIGHTSPACE_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

(You can omit the `env` block and rely on a `.env` file in the project directory instead —
the server loads it automatically via `dotenv`.)

Restart Claude Desktop, then ask things like "What courses am I enrolled in?" or "What
assignments are due in [course]?" — Claude will call `list_courses` first to find the
course's org unit ID, then the relevant follow-up tool.

## How it works

- **API version discovery**: the server calls Brightspace's public `/d2l/api/versions/`
  endpoint on first use to discover the latest supported API version for each product
  (`lp` = Learning Platform, `le` = Learning Environment), rather than hardcoding a version
  that might not match your instance. Override with `BRIGHTSPACE_LP_VERSION` /
  `BRIGHTSPACE_LE_VERSION` if needed.
- **Pagination**: list endpoints that use Brightspace's bookmark-based paging are followed
  automatically (capped at 500 items).
- **Data mapped**:
  - Courses: `GET /d2l/api/lp/{version}/enrollments/myenrollments/?orgUnitTypeId=3`
  - Assignments: `GET /d2l/api/le/{version}/{orgUnitId}/dropbox/folders/`
  - Grades: `GET /d2l/api/le/{version}/{orgUnitId}/grades/` +
    `GET /d2l/api/le/{version}/{orgUnitId}/grades/values/myGradeValues/`
  - Announcements: `GET /d2l/api/le/{version}/{orgUnitId}/news/`
  - Quizzes: `GET /d2l/api/le/{version}/{orgUnitId}/quizzes/`
  - Discussion topics: `GET /d2l/api/le/{version}/{orgUnitId}/discussions/forums/` +
    `GET /d2l/api/le/{version}/{orgUnitId}/discussions/forums/{forumId}/topics/` per forum
  - Discussion posts: `GET /d2l/api/le/{version}/{orgUnitId}/discussions/topics/{topicId}/posts/`

## Security notes

- Credentials (client secret, refresh token, app/user keys, or session cookies) are read
  from environment variables / local files and never logged. Keep `.env` and `.auth/` out of
  version control (both are already in `.gitignore`).
- This server only performs read (`GET`) requests — it cannot modify grades, submit
  assignments, or post announcements.
- The session cookie method (Option C) grants whoever holds `.auth/storageState.json` full
  access to your Brightspace account for the life of that session — treat that file like a
  password and never share or commit it.


---

# JARVIS voice interface

A browser-based, voice-driven assistant with an Iron Man style holographic interface.
You speak, Claude answers, and it speaks back — no typing, no chat log to scroll.

![The JARVIS interface mid-reply: a glowing cyan reactor ring over a dark grid, with the transcript in small text below](web/docs/interface.jpg)

## What it is

- **Real-time voice in and out.** The browser transcribes your speech, streams it to
  Claude, and speaks the reply back. Speech starts on the first complete sentence rather
  than waiting for the whole response, so replies begin almost immediately.
- **Hands-free conversation.** Once engaged it loops: listen, answer, listen again. Tap
  the core (or press Space) while it's talking to interrupt and take the floor back.
- **A visualizer that reacts to real audio.** While listening, the ring is driven by an
  FFT of your actual microphone input. While speaking, it's driven by the synthesizer's
  word-boundary events, so the pulse tracks the rhythm of the speech.
- **Text stays secondary.** The last exchange appears under the visualizer in low
  contrast; the full transcript lives in a panel you open deliberately.

## Running it

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env    # see .env.example
npm run jarvis
```

Then open <http://127.0.0.1:8917> and click the core.

`npm run jarvis` runs the TypeScript directly via tsx. For a compiled build use
`npm run build && npm run jarvis:start`.

## Controls

| Action | Control |
| --- | --- |
| Engage / stand down | Click the core, or <kbd>Space</kbd> |
| Interrupt a reply and speak | Click the core, or <kbd>Space</kbd>, while it's talking |
| Mute the voice (text only) | <kbd>M</kbd>, or the **Voice** button |
| Open the transcript | <kbd>L</kbd>, or the **Log** button |
| Type instead of speaking | <kbd>/</kbd>, or the **Type** button |
| Stand down / close panels | <kbd>Esc</kbd> |

## Browser support

Voice **input** uses the Web Speech API's `SpeechRecognition`, which today means Chrome,
Edge, or Safari — Firefox has no implementation. The interface detects this and falls
back to the text input, so everything except the microphone still works there. Voice
**output** (`speechSynthesis`) is supported everywhere.

The assistant's voice is whichever system voice best matches a British English preference
list; the exact voice depends on what your OS and browser ship.

## How it's put together

The front end is plain ES modules with no build step and no framework — the whole thing
is served as static files.

| File | Responsibility |
| --- | --- |
| `web/server/index.ts` | Static host, plus `POST /api/chat` streaming relay to Claude |
| `web/public/js/app.js` | The turn state machine, and everything wired together |
| `web/public/js/signal.js` | Shared animation state both canvases read from |
| `web/public/js/audio.js` | Microphone FFT, log-mapped to the visualizer's bands |
| `web/public/js/visualizer.js` | The reactor: rings, ticks, radial waveform |
| `web/public/js/ambient.js` | Drifting grid layers and light motes |
| `web/public/js/voice.js` | Speech recognition and sentence-chunked synthesis |
| `web/public/js/claude.js` | SSE client for the backend |

**The API key never reaches the browser.** The page talks only to the local server, which
holds the key and streams Claude's response back over SSE. The server binds to
`127.0.0.1` by default for the same reason: it has no authentication of its own, so it
shouldn't be reachable from the network. Set `JARVIS_HOST=0.0.0.0` only if you understand
that anyone who can reach the port can spend your API credits.

Conversation state lives entirely in the browser and is sent with each request, so the
server is stateless and restarting it mid-conversation loses nothing. History is capped
at the last 30 turns to bound cost and latency.

## Tuning

Everything below is optional and set in `.env` (see `.env.example`):

- `JARVIS_EFFORT` — thinking depth, default `low`. Voice is latency-sensitive chat, which
  is exactly the workload that doesn't repay high effort; a reply that lands two seconds
  late feels broken regardless of how good it is. Raise it if you'd rather wait.
- `JARVIS_SYSTEM_PROMPT` — replaces the built-in instructions wholesale. The default tells
  Claude to answer in one to three sentences of plain spoken prose, with no markdown,
  since every word gets read aloud.
- `ANTHROPIC_WORKSPACE_ID` — only needed if your API key is *not* scoped to a
  workspace. Organization-level keys must name a workspace on every request, and
  the API returns a 400 saying so. Creating a workspace-scoped key in the console
  is the simpler fix; this is here for when you'd rather keep the key you have.
- `JARVIS_MODEL`, `JARVIS_MAX_TOKENS`, `JARVIS_PORT`, `JARVIS_HOST`.
