#!/usr/bin/env node
/**
 * Signs in to the brokerage MCP server and saves a token the voice interface
 * can use.
 *
 * The Claude API's MCP connector can only send a token it is handed, and this
 * service wants an interactive OAuth sign-in — so this performs it: discovery,
 * dynamic client registration, an authorization code exchange with PKCE, and a
 * refresh token saved to .auth/account.json (gitignored).
 *
 * Nothing here sees your brokerage password; you type it on the provider's own
 * page, exactly as with the Brightspace login.
 *
 * Usage: npm run account:login
 */
import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";

import { discover, exchangeCode, registerClient } from "../src/tools/account-oauth.js";
import { writeSession } from "../src/tools/account-session.js";

const MCP_URL = process.env.JARVIS_MCP_URL?.trim();
const PORT = Number(process.env.JARVIS_OAUTH_CALLBACK_PORT || 8919);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const CLIENT_NAME = process.env.JARVIS_OAUTH_CLIENT_NAME || "Jarvis voice interface";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Waits for the provider to redirect back with an authorization code. */
function awaitCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const done = (message: string) => {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(`<html><body style="font-family:system-ui;padding:3rem">
            <h2>${message}</h2><p>You can close this tab and go back to the terminal.</p>
          </body></html>`);
        server.close();
      };

      if (error) {
        done("Sign-in was declined.");
        reject(new Error(`The provider returned an error: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        done("Something went wrong.");
        reject(new Error("The redirect was missing a code or its state did not match."));
        return;
      }
      done("Signed in.");
      resolve(code);
    });

    server.listen(PORT);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the sign-in to finish."));
    }, LOGIN_TIMEOUT_MS).unref();
  });
}

async function main() {
  if (!MCP_URL) {
    console.error("JARVIS_MCP_URL is not set in .env, so there is nothing to sign in to.");
    process.exit(1);
  }

  console.log(`\nSigning in to ${new URL(MCP_URL).hostname}\n${"=".repeat(40)}`);

  console.log("Looking up how this service wants clients to sign in…");
  const config = await discover(MCP_URL);
  console.log(`   authorization: ${config.authorizationEndpoint}`);
  console.log(`   scopes:        ${config.scopes.join(" ") || "(none advertised)"}`);

  if (!config.registrationEndpoint) {
    console.error(
      "\nThis service does not allow clients to register, so no token can be\n" +
        "obtained and it cannot be connected this way."
    );
    process.exit(1);
  }

  console.log("\nRegistering this app…");
  const client = await registerClient(config, REDIRECT_URI, CLIENT_NAME);
  console.log(`   client id: ${client.clientId}`);

  // PKCE: the verifier never leaves this machine, so an intercepted code is
  // useless on its own.
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authorizeUrl = new URL(config.authorizationEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (config.scopes.length) authorizeUrl.searchParams.set("scope", config.scopes.join(" "));

  console.log("\nOpen this in your browser and approve access:\n");
  console.log(`   ${authorizeUrl.toString()}\n`);
  console.log(`Waiting for the redirect back to ${REDIRECT_URI} …\n`);

  const code = await awaitCode(state);
  console.log("Got the code. Exchanging it for a token…");

  const tokens = await exchangeCode(config, client, code, verifier, REDIRECT_URI);
  writeSession({
    mcpUrl: MCP_URL,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenEndpoint: config.tokenEndpoint,
    ...tokens,
  });

  const hours = Math.round((tokens.expiresAt - Date.now()) / 36e5);
  console.log(`\nSigned in. Token saved to .auth/account.json (valid about ${hours}h).`);
  console.log(
    tokens.refreshToken
      ? "A refresh token was issued, so it will renew itself from now on.\n"
      : "No refresh token was issued, so you will need to run this again when it expires.\n"
  );
  console.log("Start the interface with `npm run jarvis` and ask how your portfolio is doing.\n");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
