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
import readline from "node:readline";
import { chromium, type BrowserContext } from "playwright";

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

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Brightspace sets these once you are actually authenticated. Watching for
 * them beats watching the URL: SSO can land you on a campus portal, a course
 * page, or a new tab, none of which look like /d2l/home, and every one of
 * those is a successful login.
 */
const SESSION_COOKIES = ["d2lSecureSessionVal", "d2lSessionVal"];

async function hasSessionCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies();
  return cookies.some(
    (cookie) => SESSION_COOKIES.includes(cookie.name) && cookie.value.length > 0
  );
}

async function main() {
  const domain = normalizeDomain(requireEnv("BRIGHTSPACE_DOMAIN"));
  const statePath = path.resolve(
    process.env.BRIGHTSPACE_SESSION_STATE_PATH || ".auth/storageState.json"
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  console.log("\nOpening a browser window. Log in to Brightspace as you normally would,");
  console.log("including any two-factor/SSO step — new tabs and campus portals are fine.");
  console.log("It saves automatically once you are signed in.");
  console.log("If it somehow doesn't notice, press Enter here to save anyway.\n");

  const browser = await chromium.launch({
    // Headless only exists so this flow can be tested; a real login needs a
    // window you can actually type into.
    headless: process.env.BRIGHTSPACE_LOGIN_HEADLESS === "1",
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${domain}/d2l/home`);

  // Pressing Enter forces a save, for the case where detection fails but the
  // user can plainly see they are logged in.
  const keyboard = readline.createInterface({ input: process.stdin });
  let forced = false;
  keyboard.once("line", () => {
    forced = true;
  });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let detected = false;
  let closed = false;

  while (Date.now() < deadline) {
    if (forced) break;
    try {
      if (await hasSessionCookie(context)) {
        detected = true;
        // Let the dashboard finish setting the rest of its cookies.
        await page.waitForTimeout(2000);
        break;
      }
    } catch {
      // The window was closed, or navigated somewhere the context can't be
      // queried. Save whatever we have rather than losing the login.
      closed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  keyboard.close();
  process.stdin.pause();

  if (!detected && !forced && !closed) {
    await browser.close();
    console.error(
      "\nTimed out waiting for login. Run it again — and if the browser shows you\n" +
        "logged in but nothing happens, press Enter in this window to save anyway."
    );
    process.exit(1);
  }

  if (!detected) {
    const stillThere = await hasSessionCookie(context).catch(() => false);
    if (!stillThere) {
      await browser.close().catch(() => {});
      console.error(
        "\nNo Brightspace session cookie found, so there is nothing to save.\n" +
          "Make sure you are fully logged in — you should be able to see your\n" +
          "courses — then run this again."
      );
      process.exit(1);
    }
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
