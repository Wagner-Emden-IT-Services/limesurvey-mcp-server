import assert from "node:assert/strict";
import test from "node:test";
import { buildRpcParams, toolDefinitions } from "../src/tool-definitions.js";
import { prepareResult } from "../src/server.js";

test("exposes every public RemoteControl API method", () => {
  assert.equal(toolDefinitions.length, 56);
  assert.equal(new Set(toolDefinitions.map((definition) => definition.method)).size, 56);
  for (const required of [
    "get_session_key",
    "release_session_key",
    "list_surveys",
    "add_participants",
    "export_responses",
    "get_fieldmap",
    "cpd_importParticipants",
  ]) {
    assert.ok(toolDefinitions.some((definition) => definition.method === required), required);
  }
});

test("fills positional defaults when a later optional argument is supplied", () => {
  const definition = toolDefinitions.find((item) => item.method === "export_responses");
  assert.ok(definition);
  assert.deepEqual(
    buildRpcParams(definition, {
      survey_id: 123,
      document_type: "csv",
      to_response_id: 99,
    }),
    [123, "csv", null, "all", "code", "short", null, 99],
  );
});

test("marks large responses without returning unusable full payloads", () => {
  const output = prepareResult("export_responses", "A".repeat(5_000), 1_000);
  assert.equal(output.truncated, true);
  assert.equal(typeof output.result, "object");
  assert.match(output.truncation_message ?? "", /increase LIMESURVEY_MAX_RESPONSE_CHARS/);
});

test("requires explicit confirmation for destructive, email, and activation tools", () => {
  const deletion = toolDefinitions.find((item) => item.method === "delete_survey");
  const email = toolDefinitions.find((item) => item.method === "invite_participants");
  const activation = toolDefinitions.find((item) => item.method === "activate_survey");
  assert.ok(deletion);
  assert.ok(email);
  assert.ok(activation);
  assert.equal(deletion.inputSchema.safeParse({ survey_id: 123 }).success, false);
  assert.equal(deletion.inputSchema.safeParse({ survey_id: 123, confirm_destructive_action: true }).success, true);
  assert.equal(email.inputSchema.safeParse({ survey_id: 123 }).success, false);
  assert.equal(email.inputSchema.safeParse({ survey_id: 123, confirm_send_email: true }).success, true);
  assert.equal(activation.inputSchema.safeParse({ survey_id: 123 }).success, false);
  assert.equal(activation.inputSchema.safeParse({ survey_id: 123, confirm_activation: true }).success, true);
});
