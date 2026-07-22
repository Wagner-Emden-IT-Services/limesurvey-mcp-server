import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { startHttpServer } from "../src/http-server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const config: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
  transport: "http",
  httpHost: "127.0.0.1",
  httpPort: 0,
  httpBearerToken: "test-token",
};

test("protects Streamable HTTP with bearer auth and completes an MCP handshake", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-http" : [{ sid: "123" }];
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const running = await startHttpServer(config, mockFetch);
  const unauthorized = await fetch(running.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(unauthorized.status, 401);

  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    requestInit: { headers: { Authorization: "Bearer test-token" } },
  });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  try {
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 68);
    const result = await client.callTool({ name: "limesurvey_list_surveys", arguments: {} });
    assert.equal(result.isError, undefined);
  } finally {
    await client.close();
    await running.close();
  }
});
