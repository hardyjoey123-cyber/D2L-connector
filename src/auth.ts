import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * Produces the pieces a request needs to be authenticated against Brightspace,
 * regardless of which auth method (OAuth 2.0 or legacy Valence ID/Key) is configured.
 */
export interface AuthApplication {
  /** Extra headers to attach to the request. */
  headers: Record<string, string>;
  /** Extra query parameters to append to the request URL. */
  query: Record<string, string>;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedOAuthToken: CachedToken | null = null;

async function refreshOAuthAccessToken(config: Config): Promise<CachedToken> {
  const oauth = config.oauth!;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    scope: oauth.scope,
  });

  const response = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to refresh Brightspace OAuth token (${response.status} ${response.statusText}): ${text}`
    );
  }

  const json = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (json.refresh_token && json.refresh_token !== oauth.refreshToken) {
    process.stderr.write(
      "[d2l-mcp] Brightspace issued a new refresh token. Update BRIGHTSPACE_REFRESH_TOKEN in your .env " +
        "with the value below to avoid future re-authentication:\n" +
        `[d2l-mcp] New refresh token: ${json.refresh_token}\n`
    );
  }

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  return {
    accessToken: json.access_token,
    // Refresh a little early to avoid races against clock skew.
    expiresAt: Date.now() + expiresInMs - 30_000,
  };
}

async function getOAuthAccessToken(config: Config): Promise<string> {
  if (cachedOAuthToken && cachedOAuthToken.expiresAt > Date.now()) {
    return cachedOAuthToken.accessToken;
  }
  cachedOAuthToken = await refreshOAuthAccessToken(config);
  return cachedOAuthToken.accessToken;
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Legacy Valence Learning Framework ID/Key request signing.
 *
 * Each request is signed with two HMAC-SHA256 signatures computed over
 * `${METHOD}&${lowercased absolute URL without query string}&${timestamp}`:
 *   - x_c: signed with the application key (proves the calling app)
 *   - x_d: signed with the user key (proves the acting user)
 *
 * See D2L's Valence Authentication documentation for the full spec. If you
 * see 403 "invalid signature" errors, double check your system clock and
 * that appKey/userKey were copied correctly, or switch to OAuth 2.0 (the
 * currently recommended auth method) via BRIGHTSPACE_AUTH_METHOD=oauth.
 */
function signRequest(
  config: Config,
  method: string,
  absoluteUrlWithoutQuery: string
): Record<string, string> {
  const apiKey = config.apiKey!;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const baseString = `${method.toUpperCase()}&${absoluteUrlWithoutQuery.toLowerCase()}&${timestamp}`;

  const appSignature = base64UrlEncode(
    crypto.createHmac("sha256", apiKey.appKey).update(baseString).digest()
  );
  const userSignature = base64UrlEncode(
    crypto.createHmac("sha256", apiKey.userKey).update(baseString).digest()
  );

  return {
    x_a: apiKey.appId,
    x_b: apiKey.userId,
    x_c: appSignature,
    x_d: userSignature,
    x_t: timestamp,
  };
}

interface PlaywrightStorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // epoch seconds, or -1 for session cookies
}

interface CachedCookieHeader {
  header: string;
  mtimeMs: number;
}

let cachedCookieHeader: CachedCookieHeader | null = null;

/** Returns true if `cookieDomain` (as stored by Playwright) applies to `host`. */
function cookieAppliesToHost(cookieDomain: string, host: string): boolean {
  const normalizedCookieDomain = cookieDomain.replace(/^\./, "");
  return host === normalizedCookieDomain || host.endsWith(`.${normalizedCookieDomain}`);
}

/**
 * Builds a `Cookie` header by replaying the session cookies captured into a
 * Playwright storageState.json file (see scripts/login-browser.ts). This lets
 * the server act as the logged-in user against Brightspace's own JSON API
 * endpoints, for institutions that won't issue OAuth or Valence ID/Key
 * credentials. No password is ever stored — only the resulting session
 * cookies, which expire like any normal browser session.
 */
function getSessionCookieHeader(config: Config, host: string): string {
  const statePath = path.resolve(config.session!.statePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(statePath);
  } catch {
    throw new Error(
      `No saved Brightspace session found at ${statePath}. Run \`npm run auth:session\` to log in first.`
    );
  }

  if (cachedCookieHeader && cachedCookieHeader.mtimeMs === stat.mtimeMs) {
    return cachedCookieHeader.header;
  }

  const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
    cookies: PlaywrightStorageStateCookie[];
  };

  const now = Date.now() / 1000;
  const relevant = state.cookies.filter(
    (cookie) =>
      cookieAppliesToHost(cookie.domain, host) && (cookie.expires < 0 || cookie.expires > now)
  );

  if (relevant.length === 0) {
    throw new Error(
      `Saved Brightspace session at ${statePath} has no valid cookies for ${host}. ` +
        "It may have expired — run `npm run auth:session` again to log back in."
    );
  }

  const header = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  cachedCookieHeader = { header, mtimeMs: stat.mtimeMs };
  return header;
}

/**
 * Builds the headers/query parameters needed to authenticate `method absoluteUrl`
 * (absoluteUrl must not include a query string) against Brightspace.
 */
export async function authenticateRequest(
  config: Config,
  method: string,
  absoluteUrlWithoutQuery: string
): Promise<AuthApplication> {
  if (config.authMethod === "oauth") {
    const accessToken = await getOAuthAccessToken(config);
    return {
      headers: { Authorization: `Bearer ${accessToken}` },
      query: {},
    };
  }

  if (config.authMethod === "session") {
    const host = new URL(absoluteUrlWithoutQuery).hostname;
    return {
      headers: { Cookie: getSessionCookieHeader(config, host) },
      query: {},
    };
  }

  return {
    headers: {},
    query: signRequest(config, method, absoluteUrlWithoutQuery),
  };
}
