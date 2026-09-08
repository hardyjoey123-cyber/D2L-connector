#!/usr/bin/env node
/**
 * One-time helper for the legacy Valence Learning Framework ID/Key auth method.
 *
 * This is D2L's original, non-OAuth authentication scheme: your registered
 * "API Application" has an App Id/App Key pair, and each Brightspace user who
 * wants to authorize the app gets a User Id/User Key pair by visiting a
 * Brightspace URL and logging in.
 *
 * This script builds that authorization URL and starts a local server to
 * capture whatever Brightspace sends back to the redirect. D2L's exact
 * callback query parameter names have varied across documentation versions
 * ("userId"/"userKey" in newer docs, "x_b"/"x_c" in older ones alongside the
 * echoed "x_a" app id) — this script prints the FULL raw callback query
 * string so you can confirm the correct values against what your Brightspace
 * instance actually sends, rather than guessing.
 *
 * If your Brightspace instance has OAuth 2.0 registration available, prefer
 * `npm run auth:oauth` instead — it is the officially recommended, more
 * robust method and this script's field mapping doesn't need to be guessed.
 *
 * Usage: npm run auth:apikey
 */
import "dotenv/config";
import http from "node:http";

const PORT = Number(process.env.BRIGHTSPACE_APIKEY_CALLBACK_PORT || 8919);
const CALLBACK_URL =
  process.env.BRIGHTSPACE_APIKEY_CALLBACK_URL || `http://localhost:${PORT}/callback`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

async function main() {
  const domain = normalizeDomain(requireEnv("BRIGHTSPACE_DOMAIN"));
  const appId = requireEnv("BRIGHTSPACE_APP_ID");

  const authUrl = new URL("/d2l/auth/api/token", domain);
  authUrl.searchParams.set("x_a", appId);
  authUrl.searchParams.set("x_target", CALLBACK_URL);

  console.log("\n1. Open this URL in a browser and log in to Brightspace as the user Claude should act as:\n");
  console.log(`   ${authUrl.toString()}\n`);
  console.log(`2. Waiting for the redirect to ${CALLBACK_URL} ...\n`);

  await new Promise<void>((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const params = Object.fromEntries(url.searchParams.entries());
      res
        .writeHead(200, { "Content-Type": "text/plain" })
        .end("Received the callback. You can close this tab and return to the terminal.");

      console.log("Raw callback query parameters received from Brightspace:\n");
      console.log(JSON.stringify(params, null, 2));
      console.log(
        "\nBrightspace echoes your App Id (x_a) and returns the new User Id/User Key under " +
          'names that vary by instance/version (commonly "userId"/"userKey" or "x_b"/"x_c").\n' +
          "Match the values above to your Brightspace API documentation, then set in .env:\n\n" +
          "BRIGHTSPACE_AUTH_METHOD=apikey\n" +
          `BRIGHTSPACE_APP_ID=${appId}\n` +
          "BRIGHTSPACE_APP_KEY=<your app key, from when you registered the application>\n" +
          "BRIGHTSPACE_USER_ID=<the user id value from above>\n" +
          "BRIGHTSPACE_USER_KEY=<the user key value from above>\n"
      );

      server.close();
      resolve();
    });

    server.listen(PORT);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
