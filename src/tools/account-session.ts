/**
 * Stores and refreshes the token for the brokerage MCP server.
 *
 * The token lives in .auth/ (gitignored) alongside the Brightspace and Connect
 * sessions. The voice server asks for a current one on each request and hands
 * it to the API; refresh happens here so a long-lived process never serves an
 * expired token.
 */
import fs from "node:fs";
import path from "node:path";

import { refreshTokens, type ClientCredentials, type TokenSet } from "./account-oauth.js";

const SESSION_PATH = ".auth/account.json";
/** Refresh a little early rather than racing the expiry. */
const REFRESH_MARGIN_MS = 120_000;

export interface StoredSession {
  mcpUrl: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

export class AccountSessionError extends Error {}

function sessionPath(root: string): string {
  return path.resolve(root, SESSION_PATH);
}

export function accountSessionAvailable(root = process.cwd()): boolean {
  return fs.existsSync(sessionPath(root));
}

export function readSession(root = process.cwd()): StoredSession | null {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(root), "utf8")) as StoredSession;
  } catch {
    return null;
  }
}

export function writeSession(session: StoredSession, root = process.cwd()): void {
  const file = sessionPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
  // The refresh token is as good as a login; keep it off other accounts on
  // shared machines where the platform supports it.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows and some filesystems don't support this; not fatal. */
  }
}

/** One refresh at a time, however many requests arrive at once. */
let inFlight: Promise<string> | null = null;

/**
 * A token good for at least the next couple of minutes, refreshing if needed.
 * Throws with an actionable message rather than returning something expired.
 */
export async function currentAccessToken(root = process.cwd()): Promise<string> {
  const session = readSession(root);
  if (!session) {
    throw new AccountSessionError(
      "No account session saved. Run `npm run account:login` first."
    );
  }

  if (session.expiresAt - REFRESH_MARGIN_MS > Date.now()) return session.accessToken;

  if (!session.refreshToken) {
    throw new AccountSessionError(
      "The account session expired and there is no refresh token. Run " +
        "`npm run account:login` again."
    );
  }

  if (!inFlight) {
    inFlight = (async () => {
      const client: ClientCredentials = {
        clientId: session.clientId,
        clientSecret: session.clientSecret,
      };
      let tokens: TokenSet;
      try {
        tokens = await refreshTokens(session.tokenEndpoint, client, session.refreshToken!);
      } catch (error) {
        throw new AccountSessionError(
          `Could not refresh the account session: ${
            error instanceof Error ? error.message : String(error)
          }. Run \`npm run account:login\` again.`
        );
      }
      writeSession({ ...session, ...tokens }, root);
      return tokens.accessToken;
    })().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}
