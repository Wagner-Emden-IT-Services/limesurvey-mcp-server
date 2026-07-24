import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_VERSION } from "../src/server.js";
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
  const requests: JsonRpcRequest[] = [];
  const wrapped: typeof fetch = async (input, init) => {
    if (init?.body) requests.push(JSON.parse(String(init.body)) as JsonRpcRequest);
    return mockFetch(input, init);
  };
  const created = createServer(config, wrapped);
  const client = new Client({ name: "instance-capabilities-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, mcpClient: client, requests };
}

function resultOf(structuredContent: unknown): Record<string, unknown> {
  return (structuredContent as { result: Record<string, unknown> }).result;
}

function sessionOnlyFetch(): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-1" : null;
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

test("get_instance_info without probe makes no RemoteControl calls and reports directory/capability state", async () => {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-export-"));
  try {
    const { server, mcpClient, requests } = await connected(
      { ...baseConfig, exportDir, enableExperimentalMethods: true },
      sessionOnlyFetch(),
    );
    try {
      const response = await mcpClient.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
      assert.equal(response.isError, undefined);
      assert.deepEqual(requests, []);
      const result = resultOf(response.structuredContent);
      assert.equal(result.server_version, SERVER_VERSION);
      assert.equal(result.instance_host, "survey.example.test");
      assert.equal(result.transport, "stdio");
      assert.equal(result.read_only, false);
      assert.equal(result.experimental_methods_enabled, true);
      const directories = result.directories as Record<string, unknown>;
      const exportDirInfo = directories.export_dir as Record<string, unknown>;
      assert.equal(exportDirInfo.configured, true);
      assert.equal(exportDirInfo.exists, true);
      assert.equal(exportDirInfo.writable, true);
      const importDirInfo = directories.import_dir as Record<string, unknown>;
      assert.equal(importDirInfo.configured, false);
      assert.equal(importDirInfo.exists, false);
      const capabilities = result.capabilities as Record<string, unknown>;
      assert.deepEqual(capabilities, {
        import_via_path: true,
        export_survey_to_file: true,
        list_installed_themes: true,
        theme_generation: false,
      });
      assert.match(String(result.restart_hint), /restart/i);
      assert.equal(result.instance_version, undefined);
      assert.equal(result.permission_level, undefined);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("get_instance_info with probe_instance reports superadmin version access", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    let result: JsonValue;
    if (request.method === "get_session_key") result = "session-1";
    else if (request.method === "list_surveys") result = [{ sid: "1" }, { sid: "2" }];
    else if (request.method === "get_site_settings" && request.params[1] === "versionnumber") result = "6.5.11";
    else result = null;
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(baseConfig, mockFetch);
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_get_instance_info",
      arguments: { probe_instance: true },
    });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    assert.equal(result.survey_count, 2);
    assert.equal(result.instance_version, "6.5.11");
    assert.equal(result.permission_level, "superadmin");
    assert.equal(result.version_note, undefined);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("get_instance_info with probe_instance degrades gracefully without a superadmin account", async () => {
  const { server, mcpClient } = await connected(baseConfig, permissionDeniedFetch());
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_get_instance_info",
      arguments: { probe_instance: true },
    });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    assert.equal(result.instance_version, null);
    assert.equal(result.permission_level, "standard");
    assert.match(String(result.version_note), /superadmin/);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("list_installed_themes lists generated packages, dedupes themes in use, and respects survey_scan_limit", async () => {
  const themeDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-themes-"));
  try {
    await writeFile(path.join(themeDir, "acme_feedback-1.0.0-ls7.zip"), "zip");
    await mkdir(path.join(themeDir, "unpacked_theme"));

    const surveys = [{ sid: "1" }, { sid: "2" }, { sid: "3" }];
    const templates: Record<string, string> = { "1": "kp_corporate_2026", "2": "kp_corporate_2026", "3": "inherit" };
    const mockFetch: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
      let result: JsonValue;
      if (request.method === "get_session_key") result = "session-1";
      else if (request.method === "list_surveys") result = surveys;
      else if (request.method === "get_survey_properties") {
        const sid = String(request.params[1]);
        result = { template: templates[sid] ?? "inherit" };
      } else result = null;
      return new Response(JSON.stringify({ id: request.id, result, error: null }));
    };
    const { server, mcpClient } = await connected({ ...baseConfig, themeDir }, mockFetch);
    try {
      const response = await mcpClient.callTool({
        name: "limesurvey_list_installed_themes",
        arguments: { survey_scan_limit: 2 },
      });
      assert.equal(response.isError, undefined);
      const result = resultOf(response.structuredContent);
      const generatedPackages = result.generated_packages as Array<{ name: string }>;
      assert.equal(generatedPackages.length, 2);
      assert.ok(generatedPackages.some((item) => item.name === "acme_feedback-1.0.0-ls7.zip"));
      assert.ok(generatedPackages.some((item) => item.name === "unpacked_theme"));
      assert.deepEqual(result.themes_in_use, ["kp_corporate_2026"]);
      assert.equal(result.inherit_count, 0);
      assert.equal(result.scanned_surveys, 2);
      assert.equal(result.total_surveys, 3);
      assert.match(String(result.admin_fallback), /Configuration/);
      assert.match(String(result.limitations), /RemoteControl/);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(themeDir, { recursive: true, force: true });
  }
});

test("list_installed_themes works without a configured theme directory", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    const result = request.method === "get_session_key" ? "session-1" : [];
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(baseConfig, mockFetch);
  try {
    const response = await mcpClient.callTool({ name: "limesurvey_list_installed_themes", arguments: {} });
    assert.equal(response.isError, undefined);
    const result = resultOf(response.structuredContent);
    assert.deepEqual(result.generated_packages, []);
    assert.match(String(result.generated_packages_note), /LIMESURVEY_THEME_DIR/);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("export_survey_to_file is disabled unless LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS is set", async () => {
  const { server, mcpClient, requests } = await connected({ ...baseConfig, exportDir: "./exports" }, sessionOnlyFetch());
  try {
    const response = await mcpClient.callTool({
      name: "limesurvey_export_survey_to_file",
      arguments: { survey_id: 123 },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /EXPORT_UNSUPPORTED/);
    assert.ok(!requests.some((request) => request.method === "export_survey"));
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("export_survey_to_file reports EXPORT_UNSUPPORTED when the experimental RPC call fails", async () => {
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
      name: "limesurvey_export_survey_to_file",
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

test("export_survey_to_file writes the decoded structure to LIMESURVEY_EXPORT_DIR when the experimental RPC succeeds", async () => {
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
        name: "limesurvey_export_survey_to_file",
        arguments: { survey_id: 123, file_name: "survey.lss" },
      });
      assert.equal(response.isError, undefined);
      assert.equal(await readFile(path.join(exportDir, "survey.lss"), "utf8"), lssContents);
      const result = resultOf(response.structuredContent);
      assert.equal(typeof result.sha256, "string");
      assert.equal(JSON.stringify(result).includes(Buffer.from(lssContents).toString("base64")), false);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
});

test("get_instance_info and list_installed_themes stay usable in read-only mode, but export_survey_to_file is blocked", async () => {
  const rpcMethods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    rpcMethods.push(request.method);
    const result = request.method === "get_session_key" ? "session-1" : [];
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(
    { ...baseConfig, exportDir: "./exports", enableExperimentalMethods: true, readOnly: true },
    mockFetch,
  );
  try {
    const infoResponse = await mcpClient.callTool({ name: "limesurvey_get_instance_info", arguments: {} });
    assert.equal(infoResponse.isError, undefined);

    const themesResponse = await mcpClient.callTool({ name: "limesurvey_list_installed_themes", arguments: {} });
    assert.equal(themesResponse.isError, undefined);

    const exportResponse = await mcpClient.callTool({
      name: "limesurvey_export_survey_to_file",
      arguments: { survey_id: 123 },
    });
    assert.equal(exportResponse.isError, true);
    assert.match(JSON.stringify(exportResponse.structuredContent), /LIMESURVEY_READ_ONLY/);
    assert.ok(!rpcMethods.includes("export_survey"));
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

test("the theme and export directory errors mention that changing env requires a restart", async () => {
  const { server, mcpClient } = await connected(baseConfig, sessionOnlyFetch());
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
