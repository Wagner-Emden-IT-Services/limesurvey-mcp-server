import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const baseConfig: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

async function connected(config: LimeSurveyConfig, mockFetch: typeof fetch) {
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "workflow-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, mcpClient: client };
}

test("finds surveys by title and paginates the workflow result", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key"
      ? "session-1"
      : [
          { sid: "100", surveyls_title: "Customer pulse" },
          { sid: "200", surveyls_title: "Employee pulse" },
          { sid: "300", surveyls_title: "Onboarding" },
        ];
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(baseConfig, mockFetch);
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_find_surveys",
      arguments: { query: "pulse", offset: 1, limit: 1 },
    });
    assert.deepEqual(response.structuredContent, {
      workflow: "find_surveys",
      result: {
        items: [{ sid: "200", surveyls_title: "Employee pulse" }],
        total: 2,
        offset: 1,
        limit: 1,
      },
    });
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("writes decoded exports only inside the configured export directory", async () => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-export-"));
  const csv = "id,answer\n1,yes\n";
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-1" : Buffer.from(csv).toString("base64");
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected({ ...baseConfig, exportDir }, mockFetch);
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_export_responses_to_file",
      arguments: { survey_id: 123, document_type: "csv", file_name: "responses.csv" },
    });
    assert.equal(response.isError, undefined);
    assert.equal(await readFile(path.join(exportDir, "responses.csv"), "utf8"), csv);
    assert.match(JSON.stringify(response.structuredContent), /sha256/);

    const traversal = await mcpClient.callTool({
      name: "limesurvey_export_responses_to_file",
      arguments: { survey_id: 123, document_type: "csv", file_name: "../outside.csv" },
    });
    assert.equal(traversal.isError, true);
    assert.match(JSON.stringify(traversal.structuredContent), /plain file name/);
  } finally {
    await mcpClient.close();
    await server.close();
    await rm(exportDir, { recursive: true, force: true });
  }
});
