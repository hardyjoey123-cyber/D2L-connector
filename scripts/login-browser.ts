#!/usr/bin/env node
/**
 * One-time (well, repeat-as-needed) helper for the "session" auth method.
 *
 * This is a workaround for Brightspace instances that won't issue OAuth or
 * Valence ID/Key API credentials to individual users (common at
 * institutions where only IT/LMS admins can register API applications).
 *
 * It opens a real, visible browser window pointed at your Brightspace
 * domain and lets YOU log in exactly as you normally would — including any
 * SSO redirect and multi-factor authentication your school requires. Your
 * password is never seen, typed, or stored by this script. Once you land on
 * your Brightspace dashboard, the script saves the resulting session
 * cookies to a local file (.auth/storageState.json, gitignored) and exits.
 * The MCP server then replays those cookies to call Brightspace's own JSON
 * API endpoints as you.
 *
 * Read the "Session cookie workaround" section of the README before using
 * this — it comes with real trade-offs (likely against your institution's
 * acceptable-use policy for automated access, and the session will
 * periodically expire and need to be refreshed by re-running this script).
 *
 * Usage: npm run auth:session
 */
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";

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

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  const domain = normalizeDomain(requireEnv("BRIGHTSPACE_DOMAIN"));
  const statePath = path.resolve(
    process.env.BRIGHTSPACE_SESSION_STATE_PATH || ".auth/storageState.json"
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  console.log("\nOpening a browser window. Log in to Brightspace as you normally would,");
  console.log("including any two-factor/SSO step. This script will detect success and");
  console.log(`save your session automatically (waiting up to ${LOGIN_TIMEOUT_MS / 60000} minutes).\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${domain}/d2l/home`);

  try {
    // Brightspace's dashboard shell renders a "D2L.LP" namespace and course
    // widgets under /d2l/home once logged in; wait for the URL to settle
    // there (as opposed to a login/SSO provider domain) as our success signal.
    await page.waitForURL(
      (url) => url.hostname === new URL(domain).hostname && url.pathname.startsWith("/d2l/home"),
      { timeout: LOGIN_TIMEOUT_MS }
    );
    // Give the SPA a moment to finish setting all its session cookies after redirect.
    await page.waitForTimeout(2000);
  } catch {
    await browser.close();
    console.error("\nTimed out waiting for login to complete. Run this again and try once more.");
    process.exit(1);
  }

  await context.storageState({ path: statePath });
  await browser.close();

  console.log(`\nSession saved to ${statePath}.\n`);
  console.log("Add/confirm these in your .env file:\n");
  console.log("BRIGHTSPACE_AUTH_METHOD=session");
  console.log(`BRIGHTSPACE_SESSION_STATE_PATH=${path.relative(process.cwd(), statePath)}\n`);
  console.log(
    "This session will expire like any normal browser login (often in hours to a couple weeks,\n" +
      "depending on your school's settings). Re-run `npm run auth:session` whenever the MCP\n" +
      "server reports the session has expired.\n"
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
