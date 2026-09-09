#!/usr/bin/env node
/**
 * Capture step for reading McGraw-Hill Connect coursework.
 *
 * Connect has no public API, and at this institution it is reached by LTI
 * launch from Brightspace rather than a standalone login — so there is no
 * password to hand a script and no documented endpoint to call. Instead this
 * opens a real browser, lets you navigate to your Connect assignments exactly
 * as you normally would, and records the JSON its own web app fetches along
 * the way. Those recordings are what a parser gets written against.
 *
 * Nothing is uploaded. Everything lands in .auth/ (gitignored). The summary
 * printed at the end deliberately shows only URLs and the *shape* of each
 * response — key names and value types, never values — so it is safe to paste
 * into a chat without leaking your name, email, or scores.
 *
 * Usage: npm run connect:capture
 */
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { chromium } from "playwright";

const CAPTURE_TIMEOUT_MS = 20 * 60 * 1000;
/**
 * Hosts worth recording; Brightspace traffic is noise here. Overridable so the
 * same capture works for other publishers (Pearson, WileyPLUS, Cengage).
 */
const INTERESTING_HOST = new RegExp(
  process.env.CONNECT_CAPTURE_HOSTS ??
    "mheducation|mhhe\\.com|connect\\.|readanywhere|ebook",
  "i"
);
const MAX_CAPTURES = 200;
const MAX_BODY_BYTES = 512 * 1024;
/**
 * Every response, not just JSON, recorded as URL + type + size only. This is
 * how you tell whether something like an eBook arrives as readable text, as
 * images, or as an encrypted blob — without storing any of it.
 */
const MAX_RESOURCE_LOG = 400;

interface Capture {
  url: string;
  method: string;
  status: number;
  body: unknown;
}

interface ResourceNote {
  url: string;
  status: number;
  type: string;
  bytes: number | null;
}

function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

/**
 * Describes a value's structure without revealing it. `{name: "Joey"}`
 * becomes `{name: string}` — enough to write a parser, nothing personal.
 */
/** Counts and sizes per content type, with a few example paths each. */
function summarizeResources(resources: ResourceNote[]) {
  const byType = new Map<string, { count: number; totalBytes: number; examples: string[] }>();
  for (const resource of resources) {
    const entry = byType.get(resource.type) ?? { count: 0, totalBytes: 0, examples: [] };
    entry.count += 1;
    entry.totalBytes += resource.bytes ?? 0;
    if (entry.examples.length < 3) {
      try {
        const parsed = new URL(resource.url);
        entry.examples.push(`${parsed.hostname}${parsed.pathname}`);
      } catch {
        entry.examples.push(resource.url);
      }
    }
    byType.set(resource.type, entry);
  }
  return [...byType.entries()]
    .sort((a, b) => b[1].totalBytes - a[1].totalBytes)
    .map(([type, entry]) => ({ type, ...entry }));
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [shapeOf(value[0], depth + 1), `× ${value.length}`];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as object).slice(0, 40)) {
      out[key] = shapeOf(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    // Dates are the whole point of this exercise, so flag them by pattern.
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "string(date-like)";
    return "string";
  }
  return typeof value;
}

/** Ranks captures by how likely they are to hold coursework with due dates. */
function score(capture: Capture): number {
  const haystack = `${capture.url} ${JSON.stringify(capture.body ?? "").slice(0, 4000)}`.toLowerCase();
  let points = 0;
  for (const term of ["assignment", "duedate", "due_date", "duedt", "homework", "activity"]) {
    if (haystack.includes(term)) points += 2;
  }
  for (const term of ["section", "course", "class", "roster", "gradebook"]) {
    if (haystack.includes(term)) points += 1;
  }
  return points;
}

async function main() {
  const brightspace = normalizeDomain(process.env.BRIGHTSPACE_DOMAIN ?? "d2l.sdbor.edu");
  const outDir = path.resolve(".auth/connect-capture");
  const statePath = path.resolve(".auth/connect.json");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\nA browser window will open on Brightspace.");
  console.log("\n  1. Log in as usual.");
  console.log("  2. Go into your accounting course.");
  console.log("  3. Click through to Connect the way you normally do.");
  console.log("  4. Open the page that lists your assignments and due dates.");
  console.log("  5. To include the textbook: open the eBook and read a chapter.");
  console.log("\nThen come back here and press Enter.\n");

  const browser = await chromium.launch({
    headless: process.env.CONNECT_CAPTURE_HEADLESS === "1",
  });
  const context = await browser.newContext();
  const captures: Capture[] = [];
  const resources: ResourceNote[] = [];

  // Record JSON the Connect app fetches for itself. Its own API is a far more
  // reliable thing to parse than rendered HTML.
  context.on("response", (response) => {
    const url = response.url();
    if (!INTERESTING_HOST.test(new URL(url).hostname)) return;

    const headers = response.headers();
    if (resources.length < MAX_RESOURCE_LOG) {
      const length = Number(headers["content-length"]);
      resources.push({
        url: url.split("?")[0],
        status: response.status(),
        type: (headers["content-type"] ?? "unknown").split(";")[0],
        bytes: Number.isFinite(length) ? length : null,
      });
    }

    if (captures.length >= MAX_CAPTURES) return;
    if (!/json/i.test(headers["content-type"] ?? "")) return;

    void response
      .body()
      .then((buffer) => {
        if (buffer.length > MAX_BODY_BYTES) return;
        captures.push({
          url,
          method: response.request().method(),
          status: response.status(),
          body: JSON.parse(buffer.toString("utf8")),
        });
      })
      .catch(() => {
        // Streamed, redirected, or non-JSON despite the header — skip it.
      });
  });

  const page = await context.newPage();
  await page.goto(`${brightspace}/d2l/home`);

  const keyboard = readline.createInterface({ input: process.stdin });
  await Promise.race([
    new Promise<void>((resolve) => keyboard.once("line", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_TIMEOUT_MS)),
  ]);
  keyboard.close();
  // readline keeps stdin referenced; without this the process never exits.
  process.stdin.pause();

  const visited = context
    .pages()
    .map((p) => p.url())
    .filter((url) => {
      try {
        return INTERESTING_HOST.test(new URL(url).hostname);
      } catch {
        return false;
      }
    });

  try {
    await context.storageState({ path: statePath });
  } catch {
    console.error("Could not save the browser session (window closed early?).");
  }
  await browser.close().catch(() => {});

  if (captures.length === 0) {
    console.error("\nNothing was captured from Connect.");
    console.error("Either the assignments page was never opened, or Connect served it as");
    console.error("plain HTML rather than JSON. Re-run and make sure you land on the page");
    console.error("that actually lists your assignments before pressing Enter.\n");
    process.exit(1);
  }

  // Newest-first within score, since the assignments page is usually last.
  const ranked = [...captures].sort((a, b) => score(b) - score(a));
  fs.writeFileSync(path.join(outDir, "captures.json"), JSON.stringify(captures, null, 2));

  const summary = {
    capturedAt: new Date().toISOString(),
    connectPagesVisited: visited,
    responseCount: captures.length,
    mostPromising: ranked.slice(0, 6).map((capture) => ({
      url: capture.url.split("?")[0],
      query: [...new URLSearchParams(capture.url.split("?")[1] ?? "").keys()],
      method: capture.method,
      status: capture.status,
      shape: shapeOf(capture.body),
    })),
    allUrls: [...new Set(captures.map((c) => c.url.split("?")[0]))],
    // Grouped by content type: the quickest way to see whether a reader is
    // serving text, images, or something opaque.
    resourceTypes: summarizeResources(resources),
  };
  const summaryPath = path.join(outDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Record a page that triggered the assignment fetch, so later runs can
  // reload it with the saved session instead of asking you to click through
  // Brightspace again.
  const assignmentsCall = captures.find((capture) =>
    /\/openapi\/paam\/studentAssignments/.test(capture.url)
  );
  const replayUrl = visited.find((url) => /newconnect\./i.test(url)) ?? visited[0];
  fs.writeFileSync(
    path.resolve(".auth/connect-endpoint.json"),
    JSON.stringify({ replayUrl, assignmentsUrl: assignmentsCall?.url ?? null }, null, 2)
  );

  if (!assignmentsCall) {
    console.warn(
      "\nWarning: no studentAssignments response was seen. Coursework lookups may not\n" +
        "work. Re-run and make sure you open the page listing your assignments.\n"
    );
  }

  console.log(`\nCaptured ${captures.length} responses from Connect.`);
  console.log(`Full data (contains your personal information): ${path.join(outDir, "captures.json")}`);
  console.log(`Shareable summary (structure only, no values): ${summaryPath}\n`);
  console.log("Open the summary and paste its contents back into the chat:\n");
  console.log(`  notepad ${path.relative(process.cwd(), summaryPath)}\n`);

  // Playwright leaves handles behind after a capture session; exit rather than
  // leaving the user staring at a prompt that never returns.
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
