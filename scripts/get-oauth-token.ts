#!/usr/bin/env node
/**
 * One-time helper to perform the OAuth 2.0 authorization code flow against
 * Brightspace and obtain a refresh token to put in .env as
 * BRIGHTSPACE_REFRESH_TOKEN.
 *
 * Requires BRIGHTSPACE_DOMAIN, BRIGHTSPACE_CLIENT_ID, and
 * BRIGHTSPACE_CLIENT_SECRET to already be set (in .env or the environment).
 * Register the client_id/secret and the redirect URI used here
 * (default http://localhost:8918/callback) in Brightspace's
 * Admin Tools > API Management before running this.
 *
 * Usage: npm run auth:oauth
 */
import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.BRIGHTSPACE_OAUTH_CALLBACK_PORT || 8918);
const REDIRECT_URI =
  process.env.BRIGHTSPACE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/callback`;
const AUTHORIZE_URL =
  process.env.BRIGHTSPACE_OAUTH_AUTHORIZE_URL || "https://auth.brightspace.com/oauth2/auth";
const TOKEN_URL =
  process.env.BRIGHTSPACE_OAUTH_TOKEN_URL || "https://auth.brightspace.com/core/connect/token";
const SCOPE =
  process.env.BRIGHTSPACE_OAUTH_SCOPE ||
  "core:*:* content:toc:read enrollment:orgunit:read grades:gradeobject:read grades:gradevalue:read dropbox:folder:read dropbox:file:read";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const clientId = requireEnv("BRIGHTSPACE_CLIENT_ID");
  const clientSecret = requireEnv("BRIGHTSPACE_CLIENT_SECRET");
  const state = crypto.randomBytes(16).toString("hex");

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPE);
  authorizeUrl.searchParams.set("state", state);

  console.log("\n1. Open this URL in a browser and log in to Brightspace:\n");
  console.log(`   ${authorizeUrl.toString()}\n`);
  console.log(`2. Approve access. Waiting for redirect to ${REDIRECT_URI} ...\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`Brightspace returned an OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state || !authCode) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid state or missing code.");
        server.close();
        reject(new Error("OAuth callback had a mismatched state or missing code."));
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/plain" })
        .end("Authorization succeeded. You can close this tab and return to the terminal.");
      server.close();
      resolve(authCode);
    });

    server.listen(PORT);
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`Token exchange failed (${response.status} ${response.statusText}): ${text}`);
    process.exit(1);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  console.log("\nSuccess! Add these to your .env file:\n");
  console.log(`BRIGHTSPACE_AUTH_METHOD=oauth`);
  console.log(`BRIGHTSPACE_REFRESH_TOKEN=${json.refresh_token}`);
  console.log(`\n(Access token, valid for ${json.expires_in}s, not needed — the server refreshes it automatically.)\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
