/**
 * A stand-in for the brokerage MCP server.
 *
 * Started in-process by the tests so `npm test` needs no setup and touches no
 * real account. It records every tools/call it receives, which is how the tests
 * assert that an order reached the broker — or, for a cancelled one, that
 * nothing did.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface BrokerAccount {
  account_number: string;
  rhs_account_number?: string;
  agentic_allowed: boolean;
  type?: string;
  nickname?: string;
}

export interface BrokerOptions {
  /** Omit to serve no get_accounts tool at all. */
  accounts?: BrokerAccount[];
}

export interface Broker {
  url: string;
  /** Every tools/call received, in order. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Shaped like the real one: required fields, string-typed numbers, no enums. */
const ORDER_TOOLS = [
  {
    name: "review_equity_order",
    description: "Simulate a stock order without placing it.",
    inputSchema: {
      type: "object",
      required: ["account_number", "symbol", "side", "type"],
      properties: {
        account_number: { type: "string" },
        symbol: { type: "string" },
        side: { type: "string" },
        type: { type: "string" },
        quantity: { type: "string" },
        dollar_amount: { type: "string" },
        limit_price: { type: "string" },
        time_in_force: { type: "string" },
      },
    },
  },
  {
    name: "place_equity_order",
    description: "Place a real equity order with real money.",
    inputSchema: {
      type: "object",
      required: ["account_number", "symbol", "side", "type"],
      properties: {
        account_number: { type: "string" },
        symbol: { type: "string" },
        side: { type: "string" },
        type: { type: "string" },
        quantity: { type: "string" },
        dollar_amount: { type: "string" },
        limit_price: { type: "string" },
        time_in_force: { type: "string" },
      },
    },
  },
];

export function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  const calls: Broker["calls"] = [];
  const tools = [...ORDER_TOOLS];
  if (options.accounts) {
    tools.push({
      name: "get_accounts",
      description: "List the user's brokerage accounts.",
      inputSchema: { type: "object", required: [], properties: {} },
    });
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // The real server rejects an unauthenticated call; so should this one,
      // or a broken token would pass the tests.
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        res.writeHead(401).end("{}");
        return;
      }

      const rpc = JSON.parse(body) as {
        id: unknown;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };

      let result: unknown;
      if (rpc.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "stand-in", version: "1" },
        };
      } else if (rpc.method === "tools/list") {
        result = { tools };
      } else {
        const name = rpc.params?.name ?? "";
        calls.push({ name, args: rpc.params?.arguments ?? {} });
        // Nested exactly as the real server nests it, so the extractor is
        // tested against the shape that actually broke it.
        const payload =
          name === "get_accounts"
            ? { data: { accounts: options.accounts ?? [] } }
            : { ok: true, echoed: rpc.params };
        result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }

      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
