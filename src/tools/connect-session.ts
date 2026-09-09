/**
 * Fetches Connect coursework by replaying a captured browser session.
 *
 * Why a browser rather than a plain HTTP call: the endpoint is reached through
 * an LTI launch, its query parameters include identifiers we would have to
 * reconstruct, and its auth is whatever Connect's app happens to use this
 * month. Loading the page the app itself loads and reading the response it
 * makes sidesteps all of that — slower, but it either works or fails clearly.
 *
 * Requires `npm run connect:capture` to have been run first.
 */
import fs from "node:fs";
import path from "node:path";

import { parseStudentAssignments, type ConnectAssignment } from "./connect.js";

const STATE_PATH = ".auth/connect.json";
const ENDPOINT_PATH = ".auth/connect-endpoint.json";
/**
 * Connect is slow to boot, but this is also how long a spoken question waits
 * before hearing that something is wrong — so it is a compromise, not a
 * generous ceiling. Override with CONNECT_TIMEOUT_MS when debugging.
 */
const NAVIGATION_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 25_000);
/** Launching a browser per question would be unusable in a voice loop. */
const CACHE_MS = 15 * 60 * 1000;
/**
 * An expired session stays expired until the user re-captures, so remember the
 * failure briefly rather than making every question pay the timeout again.
 */
const FAILURE_CACHE_MS = 2 * 60 * 1000;

const ASSIGNMENTS_ENDPOINT = /\/openapi\/paam\/studentAssignments/;

export class ConnectSessionError extends Error {}

interface EndpointRecord {
  replayUrl?: string;
}

let cache: { at: number; assignments: ConnectAssignment[] } | null = null;
let lastFailure: { at: number; message: string } | null = null;

/** True when a capture exists, so callers can offer the feature or not. */
export function connectSessionAvailable(root = process.cwd()): boolean {
  return (
    fs.existsSync(path.resolve(root, STATE_PATH)) &&
    fs.existsSync(path.resolve(root, ENDPOINT_PATH))
  );
}

export function clearConnectCache(): void {
  cache = null;
  lastFailure = null;
}

export async function fetchConnectAssignments(
  { root = process.cwd(), force = false } = {}
): Promise<ConnectAssignment[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.assignments;
  if (!force && lastFailure && Date.now() - lastFailure.at < FAILURE_CACHE_MS) {
    throw new ConnectSessionError(lastFailure.message);
  }

  const statePath = path.resolve(root, STATE_PATH);
  const endpointPath = path.resolve(root, ENDPOINT_PATH);
  if (!fs.existsSync(statePath) || !fs.existsSync(endpointPath)) {
    throw new ConnectSessionError(
      "No Connect session saved. Run `npm run connect:capture` first."
    );
  }

  const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8")) as EndpointRecord;
  if (!endpoint.replayUrl) {
    throw new ConnectSessionError(
      "The saved Connect capture has no page to reload. Run `npm run connect:capture` again."
    );
  }

  // Imported lazily so the voice server starts without Playwright's browsers
  // installed, which only this path needs.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();

    const payload = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new ConnectSessionError(
              "Connect did not return an assignment list. The saved session has most " +
                "likely expired — run `npm run connect:capture` again."
            )
          ),
        NAVIGATION_TIMEOUT_MS
      );

      context.on("response", (response) => {
        if (!ASSIGNMENTS_ENDPOINT.test(response.url())) return;
        clearTimeout(timer);
        response
          .json()
          .then(resolve)
          .catch(() =>
            reject(new ConnectSessionError("Connect returned something unreadable."))
          );
      });
    });

    await page.goto(endpoint.replayUrl, {
      waitUntil: "commit",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const assignments = parseStudentAssignments(await payload);
    cache = { at: Date.now(), assignments };
    lastFailure = null;
    return assignments;
  } catch (error) {
    lastFailure = {
      at: Date.now(),
      message: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}
