/**
 * A minimal MCP client for calling a remote server directly.
 *
 * The point of this file is what it makes possible: the model never gets an
 * order-placing tool. It can only propose. When a human confirms, this server
 * makes the call itself — so no sequence of words, misheard or otherwise, can
 * reach a broker without a person typing first.
 */
import { currentAccessToken } from "./account-session.js";

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 30_000;

export class McpError extends Error {}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** MCP over HTTP answers as JSON or as a single SSE frame. */
async function parseBody(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  if (/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
      } catch {
        /* keep looking */
      }
    }
    throw new McpError("The server sent a stream with no readable message.");
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new McpError(`The server sent something unreadable: ${text.slice(0, 200)}`);
  }
}

export class McpClient {
  private sessionId: string | undefined;

  constructor(private readonly url: string) {}

  private async send(method: string, params: unknown): Promise<unknown> {
    const token = await currentAccessToken();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const issued = response.headers.get("mcp-session-id");
    if (issued) this.sessionId = issued;

    if (response.status === 401 || response.status === 403) {
      // A rejected token usually means the sign-in lapsed rather than anything
      // about this particular call.
      this.sessionId = undefined;
      throw new McpError(
        "The account rejected the saved sign-in. Run `npm run account:login` again."
      );
    }
    if (!response.ok) {
      throw new McpError(`The account server returned HTTP ${response.status}.`);
    }

    const body = await parseBody(response);
    if (body.error) {
      throw new McpError(body.error.message ?? "The account server reported an error.");
    }
    return body.result;
  }

  /** Handshake, once per client. Some servers reject calls without it. */
  private async ensureInitialized(): Promise<void> {
    if (this.sessionId !== undefined) return;
    await this.send("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jarvis", version: "1.0" },
    });
    // A server that issues no session id still counts as initialized.
    this.sessionId ??= "";
  }

  async listTools(): Promise<string[]> {
    return (await this.listToolDefinitions()).map((tool) => tool.name);
  }

  /** Full definitions, including each tool's declared input schema. */
  async listToolDefinitions(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  > {
    await this.ensureInitialized();
    const result = (await this.send("tools/list", {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
    };
    return (result.tools ?? [])
      .filter((tool): tool is { name: string } & typeof tool => Boolean(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = (await this.send("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };

    const text = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    if (result.isError) throw new McpError(text || `${name} failed.`);
    return result.structuredContent ?? tryJson(text);
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
