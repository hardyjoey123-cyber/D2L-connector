# D2L Brightspace MCP Server

An [MCP](https://modelcontextprotocol.io) server that connects Claude directly to your
D2L Brightspace account, exposing your **courses**, **assignments**, **grades**, and
**announcements** through Brightspace's Valence Learning Framework API.

## Tools

| Tool                  | Description                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `list_courses`        | Lists your course enrollments (name, code, org unit ID, dates, role).        |
| `list_assignments`    | Lists dropbox/assignment folders for a course. Takes `orgUnitId`.           |
| `list_grades`         | Lists your grade values for a course. Takes `orgUnitId`.                    |
| `list_announcements`  | Lists announcements (news items) for a course. Takes `orgUnitId`.           |

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

## Security notes

- Credentials (client secret, refresh token, app/user keys, or session cookies) are read
  from environment variables / local files and never logged. Keep `.env` and `.auth/` out of
  version control (both are already in `.gitignore`).
- This server only performs read (`GET`) requests — it cannot modify grades, submit
  assignments, or post announcements.
- The session cookie method (Option C) grants whoever holds `.auth/storageState.json` full
  access to your Brightspace account for the life of that session — treat that file like a
  password and never share or commit it.
