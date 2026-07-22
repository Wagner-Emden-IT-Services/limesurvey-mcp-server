import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import JSZip from "jszip";
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

async function connected(config: LimeSurveyConfig, mockFetch: typeof fetch = fetch) {
  const created = createServer(config, mockFetch);
  const client = new Client({ name: "theme-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  return { ...created, mcpClient: client };
}

test("generates and validates a responsive LimeSurvey 7 theme package", async () => {
  const themeDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-theme-"));
  const { server, mcpClient } = await connected({ ...baseConfig, themeDir });
  try {
    const generated = await mcpClient.callTool({
      name: "limesurvey_generate_survey_theme",
      arguments: {
        theme_name: "weit_feedback",
        title: "WEIT Feedback",
        target_limesurvey_major: "7",
        primary_color: "#0B6B57",
        accent_color: "#C84B31",
      },
    });
    assert.equal(generated.isError, undefined);
    const generatedContent = generated.structuredContent as {
      result: { file_name: string; license: string; parent_theme: string };
    };
    assert.equal(generatedContent.result.license, "GPL-2.0-or-later");
    assert.equal(generatedContent.result.parent_theme, "fruity_twentythree");

    const archivePath = path.join(themeDir, generatedContent.result.file_name);
    const zip = await JSZip.loadAsync(await readFile(archivePath));
    assert.ok(zip.file("config.xml"));
    assert.ok(zip.file("css/mcp-theme.css"));
    assert.ok(zip.file("LICENSE.txt"));
    assert.equal(Object.keys(zip.files).some((name) => name.endsWith(".js")), false);
    const manifest = await zip.file("config.xml")?.async("string");
    const css = await zip.file("css/mcp-theme.css")?.async("string");
    const license = await zip.file("LICENSE.txt")?.async("string");
    assert.match(manifest ?? "", /<extends>fruity_twentythree<\/extends>/);
    assert.match(manifest ?? "", /<version>7\.0<\/version>/);
    assert.match(css ?? "", /@media \(max-width: 575\.98px\)/);
    assert.match(css ?? "", /prefers-reduced-motion/);
    assert.match(license ?? "", /SPDX-License-Identifier: GPL-2\.0-or-later/);

    const validated = await mcpClient.callTool({
      name: "limesurvey_validate_survey_theme",
      arguments: { file_name: generatedContent.result.file_name },
    });
    assert.equal(validated.isError, undefined);
    const validationContent = validated.structuredContent as { result: { valid: boolean; errors: string[] } };
    assert.equal(validationContent.result.valid, true);
    assert.deepEqual(validationContent.result.errors, []);
  } finally {
    await mcpClient.close();
    await server.close();
    await rm(themeDir, { recursive: true, force: true });
  }
});

test("blocks theme generation in read-only mode but keeps publication guidance available", async () => {
  const themeDir = await mkdtemp(path.join(os.tmpdir(), "limesurvey-mcp-theme-readonly-"));
  const { server, mcpClient } = await connected({ ...baseConfig, themeDir, readOnly: true });
  try {
    const generated = await mcpClient.callTool({
      name: "limesurvey_generate_survey_theme",
      arguments: { theme_name: "readonly_theme", title: "Read-only theme" },
    });
    assert.equal(generated.isError, true);
    assert.match(JSON.stringify(generated.structuredContent), /LIMESURVEY_READ_ONLY/);

    const guide = await mcpClient.callTool({
      name: "limesurvey_get_theme_publication_guide",
      arguments: {
        theme_name: "readonly_theme",
        package_file_name: "readonly_theme-1.0.0-ls7.zip",
        installed_limesurvey_version: "7.0.5",
        hosting: "self_hosted",
      },
    });
    assert.equal(guide.isError, undefined);
    assert.match(JSON.stringify(guide.structuredContent), /Configuration > Advanced > Themes/);
  } finally {
    await mcpClient.close();
    await server.close();
    await rm(themeDir, { recursive: true, force: true });
  }
});

test("assigns an installed theme through set_survey_properties", async () => {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    const result = request.method === "get_session_key" ? "session-theme" : { template: true };
    return new Response(JSON.stringify({ id: request.id, result, error: null }));
  };
  const { server, mcpClient } = await connected(baseConfig, mockFetch);
  try {
    const assigned = await mcpClient.callTool({
      name: "limesurvey_assign_survey_theme",
      arguments: { survey_id: 123, theme_name: "weit_feedback", confirm_theme_assignment: true },
    });
    assert.equal(assigned.isError, undefined);
    assert.equal(requests[1]?.method, "set_survey_properties");
    assert.deepEqual(requests[1]?.params, ["session-theme", 123, { template: "weit_feedback" }]);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});
