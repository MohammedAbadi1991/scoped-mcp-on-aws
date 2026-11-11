import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHandler } from "../src/app.js";
import { InMemoryNotesStore } from "../src/store.js";
import { apiEvent, type ClientName } from "./helpers.js";

/**
 * Talks to the Lambda handler with the official MCP TypeScript client, through
 * a local HTTP bridge that stands in for API Gateway. TEST ONLY: the bridge
 * injects claims for a fixed client, which is exactly what a real deployment
 * must never do.
 */
const store = new InMemoryNotesStore();
const handler = createHandler(() => ({ store, audit: () => {} }));
const bridges: Server[] = [];

async function startBridge(client: ClientName): Promise<URL> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const event = apiEvent({ client, method: req.method });
    event.headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
    );
    event.body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
    const result = await handler(event);
    res.writeHead(result.statusCode ?? 500, result.headers as Record<string, string>);
    res.end(result.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  bridges.push(server);
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
}

async function connect(client: ClientName): Promise<Client> {
  const mcp = new Client({ name: `test-${client}`, version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(await startBridge(client)));
  return mcp;
}

describe("official MCP client against the Lambda handler", () => {
  let reader: Client;
  let editor: Client;

  before(async () => {
    reader = await connect("reader");
    editor = await connect("editor");
  });

  after(async () => {
    await Promise.all([reader.close(), editor.close()]);
    await Promise.all(bridges.map((b) => new Promise((r) => b.close(r))));
  });

  it("negotiates the protocol and lists only the caller's tools", async () => {
    const tools = (await reader.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["get_note", "list_notes"]);
  });

  it("round-trips a note between two differently scoped clients", async () => {
    const created = await editor.callTool({
      name: "create_note",
      arguments: { title: "Runbook", body: "Restart the worker, then check the queue depth." },
    });
    const id = (created.structuredContent as { id: string }).id;

    const read = await reader.callTool({ name: "get_note", arguments: { id } });
    assert.equal((read.structuredContent as { title: string }).title, "Runbook");
  });

  it("reports a missing tool as a tool error, not a crash", async () => {
    const result = await reader.callTool({ name: "delete_note", arguments: { id: "000000000-00000000" } });
    assert.equal(result.isError, true);
  });
});
