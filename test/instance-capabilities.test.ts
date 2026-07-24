import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { JsonRpcRequest, JsonValue, LimeSurveyConfig } from "../src/types.js";

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
  const client = new Client({ name: "instance-capabilities-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, mcpClient: client };
}

function resultOf(structuredContent: unknown): Record<string, unknown> {
  return (structuredContent as { result: Record<string, unknown> }).result;
}

function siteSettingsFetch(values: Record<string, JsonValue>): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    let result: JsonValue;
    if (request.method === "get_session_key") {
      result = "session-1";
    } else if (request.method === "get_site_settings") {
      const settingName = String(request.params[1]);
      result = Object.prototype.hasOwnProperty.call(values, settingName) ? values[settingName]! : null;
    } else {
      result = null;
    }
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
}

function permissionDeniedFetch(): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key"
      ? "session-1"
      : { status: "No permission", error_code: "ERR_NO_PERMISSION" };
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
}

test("get_instance_info reports server config and best-effort LimeSurvey version", async () => {
  const mockFetch = siteSettingsFetch({
    versionnumber: "6.5.11",
    dbversionnumber: "617",
    defaulttemplate: "fruity_twentythree",
  });
  const { server, mcpClient } = await connected(
    { ...baseConfig, exportDir: "./exports", enableExperimentalMethods: true },
    mockFetch,
  );
  try {
    const response = await mcpClient.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    assert.equal(result.read_only_mode, false);
    assert.equal(result.experimental_methods_enabled, true);
    assert.deepEqual(result.configured_directories, { export_dir: "./exports", import_dir: null, theme_dir: null });
    assert.deepEqual(result.limesurvey, {
      version: "6.5.11",
      db_version: "617",
      default_theme: "fruity_twentythree",
      permission_note: null,
    });
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("get_instance_info degrades gracefully without a superadmin account", async () => {
  const { server, mcpClient } = await connected(baseConfig, permissionDeniedFetch());
  try {
    const response = await mcpClient.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    const limesurvey = result.limesurvey as Record<string, unknown>;
    assert.equal(limesurvey.version, null);
    assert.match(String(limesurvey.permission_note), /superadmin/);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("list_installed_themes reports the current default theme when available", async () => {
  const mockFetch = siteSettingsFetch({ defaulttemplate: "kp_corporate_2026" });
  const { server, mcpClient } = await connected(baseConfig, mockFetch);
  try {
    const response = await mcpClient.callTool({ name: "limesurvey_list_installed_themes", arguments: {} });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    assert.equal(result.default_theme, "kp_corporate_2026");
    assert.equal(result.status, "partial");
    assert.match(String(result.documented_fallback), /Themes/);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("list_installed_themes degrades to unavailable without a superadmin account", async () => {
  const { server, mcpClient } = await connected(baseConfig, permissionDeniedFetch());
  try {
    const response = await mcpClient.callTool({ name: "limesurvey_list_installed_themes", arguments: {} });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    assert.equal(result.default_theme, null);
    assert.equal(result.status, "unavailable");
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("export_survey is disabled unless LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS is set", async () => {
  const rpcMethods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    rpcMethods.push(request.method);
    const result = request.method === "get_session_key" ? "session-1" : null;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected({ ...baseConfig, exportDir: "./exports" }, mockFetch);
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_export_survey",
      arguments: { survey_id: 123 },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /EXPORT_UNSUPPORTED/);
    assert.ok(!rpcMethods.includes("export_survey"));
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("export_survey reports EXPORT_UNSUPPORTED when the experimental RPC call fails", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    if (request.method === "get_session_key") {
      return new Response(JSON.stringify({ id: request.id, result: "session-1", error: null }));
    }
    return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
  };
  const { server, mcpClient } = await connected(
    { ...baseConfig, exportDir: "./exports", enableExperimentalMethods: true },
    mockFetch,
  );
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_export_survey",
      arguments: { survey_id: 123 },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /EXPORT_UNSUPPORTED/);
    assert.match(JSON.stringify(response.structuredContent), /list_groups/);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("export_survey writes the decoded structure to LIMESURVEY_EXPORT_DIR when the experimental RPC succeeds", async () => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-export-survey-"));
  try {
    const lssContents = "<survey>example</survey>";
    const mockFetch: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
      const result = request.method === "get_session_key"
        ? "session-1"
        : Buffer.from(lssContents).toString("base64");
      return new Response(JSON.stringify({ id: request.id, result, error: null }));
    };
    const { server, mcpClient } = await connected(
      { ...baseConfig, exportDir, enableExperimentalMethods: true },
      mockFetch,
    );
    try {
      const response = await mcpClient.callTool({
        name: "limesurvey_export_survey",
        arguments: { survey_id: 123, file_name: "survey.lss" },
      });
      assert.equal(response.isError, undefined);
      assert.equal(await readFile(path.join(exportDir, "survey.lss"), "utf8"), lssContents);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("export_survey is blocked in read-only mode", async () => {
  const rpcMethods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    rpcMethods.push(request.method);
    const result = request.method === "get_session_key" ? "session-1" : null;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(
    { ...baseConfig, exportDir: "./exports", enableExperimentalMethods: true, readOnly: true },
    mockFetch,
  );
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_export_survey",
      arguments: { survey_id: 123 },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /LIMESURVEY_READ_ONLY/);
    assert.deepEqual(rpcMethods, []);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("the theme and export directory errors mention that changing env requires a restart", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-1" : null;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(baseConfig, mockFetch);
  try {
    const exportResponse = await mcpClient.callTool({
      name: "limesurvey_export_responses_to_file",
      arguments: { survey_id: 1, document_type: "csv" },
    });
    assert.equal(exportResponse.isError, true);
    assert.match(JSON.stringify(exportResponse.structuredContent), /restart/i);

    const themeResponse = await mcpClient.callTool({
      name: "limesurvey_validate_survey_theme",
      arguments: { file_name: "theme.zip" },
    });
    assert.equal(themeResponse.isError, true);
    assert.match(JSON.stringify(themeResponse.structuredContent), /restart/i);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});
