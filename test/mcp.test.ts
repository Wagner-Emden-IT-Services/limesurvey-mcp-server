import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const config: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

test("completes an MCP handshake, lists schemas, and calls a LimeSurvey tool", async () => {
  const rpcMethods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    rpcMethods.push(request.method);
    const result = request.method === "get_session_key"
      ? "session-1"
      : [{ sid: "123", surveyls_title: "Customer survey", active: "Y" }];
    return new Response(JSON.stringify({ id: request.id, result, error: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { server } = createServer(config, mockFetch);
  const client = new Client({ name: "limesurvey-mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 68);
    const listSurveys = listed.tools.find((tool) => tool.name === "limesurvey_list_surveys");
    assert.ok(listSurveys?.inputSchema);
    assert.ok(listSurveys?.outputSchema);

    const response = await client.callTool({
      name: "limesurvey_list_surveys",
      arguments: { response_format: "json" },
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(rpcMethods, ["get_session_key", "list_surveys"]);
    assert.deepEqual(response.structuredContent, {
      method: "list_surveys",
      result: [{ sid: "123", surveyls_title: "Customer survey", active: "Y" }],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("enforces read-only mode before calling LimeSurvey", async () => {
  const rpcMethods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    rpcMethods.push(request.method);
    const result = request.method === "get_session_key" ? "session-1" : [{ sid: "123" }];
    return new Response(JSON.stringify({ id: request.id, result, error: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { server } = createServer({ ...config, readOnly: true }, mockFetch);
  const client = new Client({ name: "read-only-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const response = await client.callTool({
      name: "limesurvey_add_response",
      arguments: { survey_id: 123, response: { Q1: "answer" } },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /LIMESURVEY_READ_ONLY/);
    assert.deepEqual(rpcMethods, []);

    const readResponse = await client.callTool({ name: "limesurvey_list_surveys", arguments: {} });
    assert.equal(readResponse.isError, undefined);
    assert.deepEqual(rpcMethods, ["get_session_key", "list_surveys"]);
  } finally {
    await client.close();
    await server.close();
  }
});
