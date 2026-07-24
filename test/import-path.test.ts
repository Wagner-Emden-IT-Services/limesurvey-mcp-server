import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function connected(config: LimeSurveyConfig) {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-1" : 123456;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "import-path-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, mcpClient: client, requests };
}

function findRequest(requests: JsonRpcRequest[], method: string): JsonRpcRequest {
  const request = requests.find((item) => item.method === method);
  assert.ok(request, `expected a ${method} request`);
  return request;
}

test("imports a large survey file via import_data_path instead of inline base64", async () => {
  const importDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-import-"));
  try {
    const contents = "x".repeat(54 * 1024);
    const filePath = path.join(importDir, "survey.lss");
    await writeFile(filePath, contents);
    const { server, mcpClient, requests } = await connected({ ...baseConfig, importDir });
    try {
      const response = await mcpClient.callTool({
        name: "limesurvey_import_survey",
        arguments: { import_data_path: filePath, import_data_type: "lss" },
      });
      assert.equal(response.isError, undefined);
      const request = findRequest(requests, "import_survey");
      const expectedBase64 = Buffer.from(contents).toString("base64");
      assert.equal(request.params[1], expectedBase64);
      assert.ok(!JSON.stringify(request.params).includes(filePath));
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
  }
});

test("rejects a non-existent import_data_path", async () => {
  const importDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-import-"));
  try {
    const { server, mcpClient } = await connected({ ...baseConfig, importDir });
    try {
      const response = await mcpClient.callTool({
        name: "limesurvey_import_survey",
        arguments: { import_data_path: path.join(importDir, "missing.lss"), import_data_type: "lss" },
      });
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response.structuredContent), /IMPORT_FILE_NOT_FOUND/);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
  }
});

test("rejects an import file larger than the configured limit", async () => {
  const importDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-import-"));
  try {
    const filePath = path.join(importDir, "survey.lss");
    await writeFile(filePath, "x".repeat(1_000));
    const { server, mcpClient } = await connected({ ...baseConfig, importDir, maxImportBytes: 100 });
    try {
      const response = await mcpClient.callTool({
        name: "limesurvey_import_survey",
        arguments: { import_data_path: filePath, import_data_type: "lss" },
      });
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response.structuredContent), /IMPORT_FILE_TOO_LARGE/);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
  }
});

test("rejects both import_data and import_data_path set, and neither set", async () => {
  const importDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-import-"));
  try {
    const filePath = path.join(importDir, "survey.lss");
    await writeFile(filePath, "small");
    const { server, mcpClient } = await connected({ ...baseConfig, importDir });
    try {
      const both = await mcpClient.callTool({
        name: "limesurvey_import_survey",
        arguments: {
          import_data: Buffer.from("small").toString("base64"),
          import_data_path: filePath,
          import_data_type: "lss",
        },
      });
      assert.equal(both.isError, true);
      assert.match(JSON.stringify(both.structuredContent), /IMPORT_PARAM_CONFLICT/);

      const neither = await mcpClient.callTool({
        name: "limesurvey_import_survey",
        arguments: { import_data_type: "lss" },
      });
      assert.equal(neither.isError, true);
      assert.match(JSON.stringify(neither.structuredContent), /IMPORT_PARAM_CONFLICT/);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
  }
});

test("rejects inline import_data over 200000 characters", async () => {
  const { server, mcpClient } = await connected(baseConfig);
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_import_survey",
      arguments: { import_data: "A".repeat(200_001), import_data_type: "lss" },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /IMPORT_PAYLOAD_TOO_LARGE/);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("rejects an import_data_path outside the configured import directory", async () => {
  const importDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-outside-"));
  try {
    const outsideFile = path.join(outsideDir, "survey.lss");
    await writeFile(outsideFile, "small");
    const { server, mcpClient } = await connected({ ...baseConfig, importDir });
    try {
      const response = await mcpClient.callTool({
        name: "limesurvey_import_survey",
        arguments: { import_data_path: outsideFile, import_data_type: "lss" },
      });
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response.structuredContent), /IMPORT_PATH_OUTSIDE_DIR/);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("import_group and import_question accept import_data_path", async () => {
  const importDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-import-"));
  try {
    const groupContents = "group-file-contents";
    const questionContents = "question-file-contents";
    const groupPath = path.join(importDir, "group.lsg");
    const questionPath = path.join(importDir, "question.lsq");
    await writeFile(groupPath, groupContents);
    await writeFile(questionPath, questionContents);
    const { server, mcpClient, requests } = await connected({ ...baseConfig, importDir });
    try {
      const groupResponse = await mcpClient.callTool({
        name: "limesurvey_import_group",
        arguments: { survey_id: 1, import_data_path: groupPath, import_data_type: "lsg" },
      });
      assert.equal(groupResponse.isError, undefined);
      const groupRequest = findRequest(requests, "import_group");
      assert.equal(groupRequest.params[2], Buffer.from(groupContents).toString("base64"));

      const questionResponse = await mcpClient.callTool({
        name: "limesurvey_import_question",
        arguments: { survey_id: 1, group_id: 2, import_data_path: questionPath, import_data_type: "lsq" },
      });
      assert.equal(questionResponse.isError, undefined);
      const questionRequest = findRequest(requests, "import_question");
      assert.equal(questionRequest.params[3], Buffer.from(questionContents).toString("base64"));
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(importDir, { recursive: true, force: true });
  }
});

test("small inline import_data still works unchanged", async () => {
  const { server, mcpClient, requests } = await connected(baseConfig);
  try {
    const base64 = Buffer.from("small survey contents").toString("base64");
    const response = await mcpClient.callTool({
      name: "limesurvey_import_survey",
      arguments: { import_data: base64, import_data_type: "lss" },
    });
    assert.equal(response.isError, undefined);
    const request = findRequest(requests, "import_survey");
    assert.equal(request.params[1], base64);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});
