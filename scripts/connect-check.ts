#!/usr/bin/env node
/**
 * Diagnoses the Connect connection.
 *
 * "It doesn't work" has several distinct causes — no capture, a capture that
 * missed the assignments call, a session that has expired, or one that was
 * only ever valid inside an LTI launch and bounces when reloaded directly.
 * They need different fixes, so this reports which one it is.
 *
 * Prints paths and statuses, not page contents, so the output is safe to
 * share.
 *
 * Usage: npm run connect:check
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { parseStudentAssignments } from "../src/tools/connect.js";

const STATE_PATH = path.resolve(".auth/connect.json");
const ENDPOINT_PATH = path.resolve(".auth/connect-endpoint.json");
const TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 30_000);

/** Login pages are the tell for an expired or launch-only session. */
const LOGIN_HINT = /login|signin|sign-in|sso|auth|launch|lti/i;

/** Matches the capture script's filter, and is overridable the same way. */
const INTERESTING_HOST = new RegExp(
  process.env.CONNECT_CAPTURE_HOSTS ?? "mheducation|mhhe\\.com|connect\\.",
  "i"
);

function short(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function main() {
  console.log("\nConnect diagnostic\n" + "=".repeat(40));

  const haveState = fs.existsSync(STATE_PATH);
  const haveEndpoint = fs.existsSync(ENDPOINT_PATH);
  console.log(`saved session file:   ${haveState ? "found" : "MISSING"}`);
  console.log(`saved endpoint file:  ${haveEndpoint ? "found" : "MISSING"}`);

  if (!haveState || !haveEndpoint) {
    console.log("\nVERDICT: no capture on this machine.");
    console.log("FIX: run `npm run connect:capture`, log in, open your assignments,");
    console.log("     then press Enter.\n");
    process.exit(1);
  }

  const endpoint = JSON.parse(fs.readFileSync(ENDPOINT_PATH, "utf8")) as {
    replayUrl?: string;
    assignmentsUrl?: string;
  };
  console.log(`page to reload:       ${endpoint.replayUrl ? short(endpoint.replayUrl) : "MISSING"}`);
  console.log(
    `assignments call seen during capture: ${endpoint.assignmentsUrl ? "yes" : "NO"}`
  );

  if (!endpoint.replayUrl) {
    console.log("\nVERDICT: the capture never reached a Connect page.");
    console.log("FIX: re-run `npm run connect:capture` and make sure you get all the way");
    console.log("     into Connect before pressing Enter.\n");
    process.exit(1);
  }

  const cookieCount = (
    JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as { cookies?: unknown[] }
  ).cookies?.length;
  console.log(`cookies saved:        ${cookieCount ?? 0}`);

  console.log("\nReloading that page with the saved session…\n");

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE_PATH });
  const page = await context.newPage();

  const seen: string[] = [];
  let assignmentsPayload: unknown = null;

  context.on("response", (response) => {
    const url = response.url();
    if (!INTERESTING_HOST.test(url)) return;
    if (!/json/i.test(response.headers()["content-type"] ?? "")) return;
    seen.push(`${response.status()} ${short(url)}`);
    if (/\/openapi\/paam\/studentAssignments/.test(url)) {
      void response
        .json()
        .then((body) => {
          assignmentsPayload = body;
        })
        .catch(() => {});
    }
  });

  try {
    await page.goto(endpoint.replayUrl, { waitUntil: "load", timeout: TIMEOUT_MS });
  } catch {
    console.log("(navigation timed out or was interrupted)");
  }

  // Connect fetches its data after load; give it room.
  const deadline = Date.now() + TIMEOUT_MS;
  while (!assignmentsPayload && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  await browser.close().catch(() => {});

  console.log(`landed on:            ${short(finalUrl)}`);
  console.log(`page title:           ${title || "(none)"}`);
  console.log(`json responses seen:  ${seen.length}`);
  for (const line of seen.slice(0, 12)) console.log(`   ${line}`);

  if (assignmentsPayload) {
    const assignments = parseStudentAssignments(assignmentsPayload);
    const courses = [...new Set(assignments.map((a) => a.course).filter(Boolean))];
    console.log(`\nassignments parsed:   ${assignments.length}`);
    console.log(`courses seen:         ${courses.join(", ") || "(none)"}`);
    console.log("\nVERDICT: working. Connect coursework is reachable.\n");
    return;
  }

  console.log("\nassignments parsed:   0");
  if (LOGIN_HINT.test(finalUrl) || LOGIN_HINT.test(title)) {
    console.log("\nVERDICT: the saved session was rejected and Connect bounced to a login.");
    console.log("FIX: re-run `npm run connect:capture`. If it keeps happening, this");
    console.log("     institution's Connect session may only be valid inside a launch");
    console.log("     from Brightspace, which cannot be reloaded later.\n");
  } else if (seen.length === 0) {
    console.log("\nVERDICT: Connect returned no JSON at all — the page did not load as");
    console.log("         a logged-in student.");
    console.log("FIX: re-run `npm run connect:capture`.\n");
  } else {
    console.log("\nVERDICT: Connect loaded but never fetched the assignment list.");
    console.log("FIX: re-run `npm run connect:capture` and press Enter while the page");
    console.log("     showing your assignments and due dates is open.\n");
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
