#!/usr/bin/env node
/**
 * Backend for the Jarvis voice interface.
 *
 * Two jobs only: serve the static front end, and relay one streaming
 * conversation turn to Claude. The API key stays here — the browser never
 * sees it — and conversation state stays in the browser, so this process is
 * stateless and can be restarted mid-conversation without losing anything.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { projectRoot } from "../../src/config.js";

const PUBLIC_DIR = path.join(projectRoot, "web", "public");

const PORT = Number(process.env.JARVIS_PORT ?? 8917);
// Localhost by default: this server holds an API key and has no auth of its
// own, so it should not be reachable from the network unless asked for.
const HOST = process.env.JARVIS_HOST ?? "127.0.0.1";
const MODEL = process.env.JARVIS_MODEL ?? "claude-opus-5";
const MAX_TOKENS = Number(process.env.JARVIS_MAX_TOKENS ?? 2000);

/**
 * Voice is latency-sensitive chat, which is exactly the workload that does not
 * repay high effort — a reply that arrives two seconds late feels broken no
 * matter how good it is. Thinking stays on (adaptive is Opus 5's default);
 * only its depth is dialed back. Raise this via JARVIS_EFFORT if you'd rather
 * trade response time for depth.
 */
const EFFORT = (process.env.JARVIS_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const DEFAULT_SYSTEM_PROMPT = `You are JARVIS, a voice-driven assistant. Every word you produce is
spoken aloud by a speech synthesizer, never read, so write for the ear:

- Answer in one to three sentences. Stop as soon as the question is answered.
- Plain spoken prose only. No markdown, no bullet points, no numbered lists,
  no code blocks, no emoji, no stage directions, no asterisks.
- Write numbers, units, and symbols the way a person would say them:
  "about twenty percent", "three point five kilometers", "nineteen ninety-five".
- If something genuinely needs a long or structured answer, give the short
  spoken version and offer to go deeper.
- Your manner is calm, precise, and lightly dry. Do not use honorifics such as
  "sir" or "madam", and do not open with filler like "certainly" or "of course".
- The transcript you receive comes from imperfect speech recognition. If a word
  is clearly garbled, infer what was meant rather than asking about it; ask for
  a repeat only when the meaning is genuinely unrecoverable.`;

const SYSTEM_PROMPT = process.env.JARVIS_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT;

const API_KEY = process.env.ANTHROPIC_API_KEY?.trim();

if (!API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set.\n" +
      "Add it to .env in the project root (see .env.example), then start again."
  );
  process.exit(1);
}

// A real key is ~100 characters. Catching the example value here saves a
// round trip through the API to be told it is invalid.
if (!API_KEY.startsWith("sk-ant-") || API_KEY.length < 40) {
  console.error(
    `ANTHROPIC_API_KEY does not look like a real key (got ${API_KEY.length} characters).\n` +
      "It should start with sk-ant- and run about 100 characters. If you copied a\n" +
      "placeholder from the docs, replace it with a key from\n" +
      "https://console.anthropic.com/settings/keys"
  );
  process.exit(1);
}

/**
 * Keys created at the organization level aren't tied to a workspace, and the
 * API rejects them unless the request names one. Keys scoped to a workspace
 * carry it already and need nothing here.
 */
const WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID?.trim();

const client = new Anthropic(
  WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE_ID } } : {}
);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Guards against `..` escaping PUBLIC_DIR, and maps `/` to index.html. */
function resolveStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const filePath = resolveStaticPath(req.url ?? "/");
  if (!filePath) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Accepts the browser's copy of the conversation. Anything that isn't a
 * well-formed alternating-ish user/assistant text history is rejected rather
 * than passed through to the API to fail there with a less useful message.
 */
function parseMessages(raw: string): Anthropic.MessageParam[] {
  const body = JSON.parse(raw) as unknown;
  if (typeof body !== "object" || body === null || !Array.isArray((body as any).messages)) {
    throw new Error("Expected a JSON body of the form { messages: [...] }");
  }

  const input = (body as { messages: unknown[] }).messages;
  if (input.length === 0) throw new Error("messages must not be empty");
  if (input.length > 200) throw new Error("Conversation too long");

  const messages = input.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`messages[${i}] must be an object`);
    }
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      throw new Error(`messages[${i}].role must be "user" or "assistant"`);
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`messages[${i}].content must be a non-empty string`);
    }
    return { role, content } satisfies Anthropic.MessageParam;
  });

  if (messages[0].role !== "user") throw new Error("Conversation must start with a user turn");
  if (messages[messages.length - 1].role !== "user") {
    throw new Error("Conversation must end with a user turn");
  }
  return messages;
}

function sseSend(res: http.ServerResponse, event: unknown) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let messages: Anthropic.MessageParam[];
  try {
    messages = parseMessages(await readBody(req));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: message }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Streaming only helps if nothing downstream buffers it.
    "x-accel-buffering": "no",
  });

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system: SYSTEM_PROMPT,
    messages,
  });

  // If the listener navigates away or barges in, stop paying for tokens
  // nobody will hear.
  const abort = () => stream.abort();
  res.on("close", abort);

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sseSend(res, { type: "delta", text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      sseSend(res, {
        type: "error",
        message: "That request was declined. Try asking something else.",
      });
    } else {
      sseSend(res, { type: "done", stopReason: final.stop_reason });
    }
  } catch (error) {
    if (res.writableEnded) return;
    // The abort above is the normal path when a listener leaves mid-reply;
    // it is not worth reporting as a failure.
    const aborted = error instanceof Anthropic.APIUserAbortError;
    if (!aborted) {
      console.error("Claude request failed:", error);
      sseSend(res, { type: "error", message: describeApiError(error) });
    }
  } finally {
    res.off("close", abort);
    if (!res.writableEnded) res.end();
  }
}

function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Authentication failed. Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited. Give it a moment and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API. Check the network connection.";
  }
  if (error instanceof Anthropic.APIError) {
    if (error.message.includes("anthropic-workspace-id")) {
      return (
        "This API key is not tied to a workspace. Either create a key scoped to " +
        "one, or set ANTHROPIC_WORKSPACE_ID in .env."
      );
    }
    return `Claude API error ${error.status ?? ""}: ${error.message}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    void handleChat(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/api/health") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, model: MODEL, effort: EFFORT }));
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    void serveStatic(req, res);
    return;
  }
  res.writeHead(405, { "content-type": "text/plain" }).end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`JARVIS interface ready at http://${HOST}:${PORT} (model: ${MODEL}, effort: ${EFFORT})`);
});
