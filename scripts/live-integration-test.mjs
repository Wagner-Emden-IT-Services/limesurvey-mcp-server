import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/src/config.js";
import { createServer } from "../dist/src/server.js";

const REQUIRED_CONFIRMATION = "I_UNDERSTAND_THIS_CREATES_AND_DELETES_TEST_DATA";
if (process.env.LIMESURVEY_LIVE_TEST_CONFIRM !== REQUIRED_CONFIRMATION) {
  throw new Error(`Set LIMESURVEY_LIVE_TEST_CONFIRM=${REQUIRED_CONFIRMATION} to run this destructive live test.`);
}
if (process.env.LIMESURVEY_READ_ONLY === "true") {
  throw new Error("LIMESURVEY_READ_ONLY must be false for the live integration test.");
}

const fixtureRoot = process.env.LIMESURVEY_LIVE_FIXTURE_ROOT;
if (!fixtureRoot) throw new Error("LIMESURVEY_LIVE_FIXTURE_ROOT must point to an official LimeSurvey source checkout.");

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const prefix = `MCP_LIVE_TEST_${stamp}`;
const recipient = process.env.LIMESURVEY_LIVE_TEST_EMAIL ?? "mcp-live-test@example.invalid";
const results = [];
const cleanup = [];
const testedTools = new Set();
const manualCleanup = [];

function compact(value) {
  if (Array.isArray(value)) return { kind: "array", count: value.length };
  if (value && typeof value === "object") {
    const object = value;
    return {
      kind: "object",
      keys: Object.keys(object).slice(0, 12),
      ...(typeof object.status === "string" ? { status: object.status } : {}),
    };
  }
  if (typeof value === "string") return { kind: "string", length: value.length };
  return value;
}

function errorText(response) {
  const result = response?.structuredContent?.result;
  if (result && typeof result === "object" && typeof result.message === "string") return result.message;
  return JSON.stringify(response?.structuredContent ?? response);
}

async function invoke(client, name, args = {}, options = {}) {
  const started = Date.now();
  testedTools.add(name);
  const response = await client.callTool({ name, arguments: args });
  const failed = response.isError === true;
  const expected = options.expectedError && failed && options.expectedError.test(errorText(response));
  results.push({
    tool: name,
    status: expected ? "expected_error" : failed ? "failed" : "passed",
    duration_ms: Date.now() - started,
    ...(failed ? { error: errorText(response) } : { result: compact(response.structuredContent?.result) }),
  });
  if (failed && !expected) throw new Error(`${name}: ${errorText(response)}`);
  if (!failed && options.expectedError) throw new Error(`${name}: expected an error but the tool succeeded`);
  return response.structuredContent?.result;
}

async function attempt(client, name, args = {}, options = {}) {
  try {
    return await invoke(client, name, args, options);
  } catch (error) {
    if (!results.some((item) => item.tool === name && item.status === "failed")) {
      results.push({ tool: name, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    return undefined;
  }
}

function numericId(value, keys = []) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value && typeof value === "object") {
    for (const key of keys) {
      const found = value[key];
      if (typeof found === "number" && found > 0) return found;
      if (typeof found === "string" && /^\d+$/.test(found)) return Number(found);
    }
  }
  return undefined;
}

function firstParticipant(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === "object");
  if (value && typeof value === "object") return value;
  return undefined;
}

async function fixture(relativePath) {
  return (await readFile(path.join(fixtureRoot, relativePath))).toString("base64");
}

const config = loadConfig(process.env);
const { server } = createServer(config);
const mcpClient = new Client({ name: "limesurvey-live-integration-test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

let primarySurveyId;
let importedSurveyId;
let copiedSurveyId;
let participantIds = [];
let responseId;
let generatedThemePath;
const generatedExportPaths = [];

try {
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  const listed = await mcpClient.listTools();
  if (listed.tools.length !== 68) throw new Error(`Expected 68 tools, received ${listed.tools.length}.`);

  await invoke(mcpClient, "limesurvey_get_session_key");
  await attempt(mcpClient, "limesurvey_get_available_site_settings");
  await attempt(mcpClient, "limesurvey_get_site_settings", { setting_name: "sitename" });
  await attempt(mcpClient, "limesurvey_list_surveys");
  await attempt(mcpClient, "limesurvey_list_survey_groups");
  await attempt(mcpClient, "limesurvey_list_users", { username: process.env.LIMESURVEY_USERNAME });

  const created = await invoke(mcpClient, "limesurvey_add_survey", {
    survey_id: 0,
    title: `${prefix} Primary`,
    language: "en",
    format: "G",
  });
  primarySurveyId = numericId(created, ["sid", "survey_id"]);
  if (!primarySurveyId) throw new Error(`Could not obtain the primary survey ID from ${JSON.stringify(created)}.`);
  cleanup.push(() => attempt(mcpClient, "limesurvey_delete_survey", {
    survey_id: primarySurveyId,
    confirm_destructive_action: true,
  }));

  await attempt(mcpClient, "limesurvey_get_survey_properties", {
    survey_id: primarySurveyId,
    properties: ["sid", "admin", "adminemail", "active", "language", "additional_languages", "template"],
  });
  await attempt(mcpClient, "limesurvey_set_survey_properties", {
    survey_id: primarySurveyId,
    data: { admin: "MCP Live Test", adminemail: recipient, alloweditaftercompletion: "Y" },
  });
  await attempt(mcpClient, "limesurvey_find_surveys", { query: prefix, limit: 20 });
  await attempt(mcpClient, "limesurvey_assign_survey_theme", {
    survey_id: primarySurveyId,
    theme_name: "fruity_twentythree",
    confirm_theme_assignment: true,
  });

  const copied = await attempt(mcpClient, "limesurvey_copy_survey", {
    source_survey_id: primarySurveyId,
    new_name: `${prefix} Copy`,
  });
  copiedSurveyId = numericId(copied, ["newsid", "sid", "survey_id"]);
  if (copiedSurveyId) {
    const copyId = copiedSurveyId;
    cleanup.push(() => attempt(mcpClient, "limesurvey_delete_survey", {
      survey_id: copyId,
      confirm_destructive_action: true,
    }));
    await attempt(mcpClient, "limesurvey_delete_survey", {
      survey_id: copyId,
      confirm_destructive_action: true,
    });
    cleanup.pop();
    copiedSurveyId = undefined;
  }

  const surveyFixture = await fixture("docs/demosurveys/ls7_Samplesurvey_en_de.lss");
  const imported = await attempt(mcpClient, "limesurvey_import_survey", {
    import_data: surveyFixture,
    import_data_type: "lss",
    new_survey_name: `${prefix} Imported`,
  });
  importedSurveyId = numericId(imported, ["sid", "survey_id"]);
  if (importedSurveyId) {
    cleanup.push(() => attempt(mcpClient, "limesurvey_delete_survey", {
      survey_id: importedSurveyId,
      confirm_destructive_action: true,
    }));
  }

  await attempt(mcpClient, "limesurvey_add_language", { survey_id: primarySurveyId, language: "de" });
  await attempt(mcpClient, "limesurvey_get_survey_languages", { survey_id: primarySurveyId });
  await attempt(mcpClient, "limesurvey_get_language_properties", {
    survey_id: primarySurveyId,
    properties: ["surveyls_title", "surveyls_description"],
    language: "de",
  });
  await attempt(mcpClient, "limesurvey_set_language_properties", {
    survey_id: primarySurveyId,
    data: { surveyls_title: `${prefix} Deutsch` },
    language: "de",
  });
  await attempt(mcpClient, "limesurvey_delete_language", {
    survey_id: primarySurveyId,
    language: "de",
    confirm_destructive_action: true,
  });

  const group = await invoke(mcpClient, "limesurvey_add_group", {
    survey_id: primarySurveyId,
    title: `${prefix} Group`,
    description: "Created by the isolated MCP live test.",
  });
  const groupId = numericId(group, ["gid", "group_id"]);
  if (!groupId) throw new Error(`Could not obtain group ID from ${JSON.stringify(group)}.`);
  await attempt(mcpClient, "limesurvey_list_groups", { survey_id: primarySurveyId, language: "en" });
  await attempt(mcpClient, "limesurvey_get_group_properties", { group_id: groupId, language: "en" });
  await attempt(mcpClient, "limesurvey_set_group_properties", {
    group_id: groupId,
    data: { randomization_group: `${prefix}_RANDOM` },
  });

  const questionFixturePath = path.join(
    fixtureRoot,
    "tests/data/surveys/limesurvey_question_import_question_test.lsq",
  );
  const questionXml = await readFile(questionFixturePath, "utf8");
  const importedQuestion = await invoke(mcpClient, "limesurvey_import_question", {
    survey_id: primarySurveyId,
    group_id: groupId,
    import_data: Buffer.from(questionXml).toString("base64"),
    import_data_type: "lsq",
    mandatory: "N",
    new_question_title: "MCPTEXT",
    new_question_text: "MCP live integration text question",
  });
  const questionId = numericId(importedQuestion, ["qid", "question_id"]);
  if (!questionId) throw new Error(`Could not obtain question ID from ${JSON.stringify(importedQuestion)}.`);
  await attempt(mcpClient, "limesurvey_list_questions", {
    survey_id: primarySurveyId,
    group_id: groupId,
    language: "en",
  });
  await attempt(mcpClient, "limesurvey_get_question_properties", { question_id: questionId, language: "en" });
  await attempt(mcpClient, "limesurvey_set_question_properties", {
    question_id: questionId,
    data: { mandatory: "N" },
    language: "en",
  });

  const disposableQuestion = await attempt(mcpClient, "limesurvey_import_question", {
    survey_id: primarySurveyId,
    group_id: groupId,
    import_data: Buffer.from(questionXml).toString("base64"),
    import_data_type: "lsq",
    mandatory: "N",
    new_question_title: "MCPDELETE",
    new_question_text: "Disposable MCP live-test question",
  });
  const disposableQuestionId = numericId(disposableQuestion, ["qid", "question_id"]);
  if (disposableQuestionId) {
    await attempt(mcpClient, "limesurvey_delete_question", {
      question_id: disposableQuestionId,
      confirm_destructive_action: true,
    });
  }

  const uploadXml = questionXml
    .replace("<type><![CDATA[T]]></type>", "<type><![CDATA[|]]></type>")
    .replace("<title><![CDATA[Q00]]></title>", "<title><![CDATA[MCPUPLOAD]]></title>");
  await attempt(mcpClient, "limesurvey_import_question", {
    survey_id: primarySurveyId,
    group_id: groupId,
    import_data: Buffer.from(uploadXml).toString("base64"),
    import_data_type: "lsq",
    mandatory: "N",
    new_question_title: "MCPUPLOAD",
    new_question_text: "MCP live integration upload question",
  });

  const groupFixture = await fixture("tests/data/file_upload/limesurvey_group_472.lsg");
  const importedGroup = await attempt(mcpClient, "limesurvey_import_group", {
    survey_id: primarySurveyId,
    import_data: groupFixture,
    import_data_type: "lsg",
    new_group_name: `${prefix} Imported Group`,
    new_group_description: "Disposable imported group.",
  });
  const importedGroupId = numericId(importedGroup, ["gid", "group_id"]);
  if (importedGroupId) {
    await attempt(mcpClient, "limesurvey_delete_group", {
      survey_id: primarySurveyId,
      group_id: importedGroupId,
      confirm_destructive_action: true,
    });
  }

  const quota = await attempt(mcpClient, "limesurvey_add_quota", {
    survey_id: primarySurveyId,
    name: `${prefix} Quota`,
    limit: 2,
    active: false,
    action: "terminate",
    message: "MCP live test quota",
  });
  const quotaId = numericId(quota, ["id", "qid", "quota_id"]);
  await attempt(mcpClient, "limesurvey_list_quotas", { survey_id: primarySurveyId });
  if (quotaId) {
    await attempt(mcpClient, "limesurvey_get_quota_properties", { quota_id: quotaId, language: "en" });
    await attempt(mcpClient, "limesurvey_set_quota_properties", {
      quota_id: quotaId,
      data: { qlimit: 3 },
    });
    await attempt(mcpClient, "limesurvey_delete_quota", {
      quota_id: quotaId,
      confirm_destructive_action: true,
    });
  }

  await invoke(mcpClient, "limesurvey_activate_tokens", { survey_id: primarySurveyId });
  const participants = await invoke(mcpClient, "limesurvey_add_participants", {
    survey_id: primarySurveyId,
    participants: [
      { firstname: "MCP", lastname: "Response", email: recipient, token: `${stamp}R` },
      { firstname: "MCP", lastname: "Email", email: recipient, token: `${stamp}E` },
    ],
    create_token: false,
  });
  if (Array.isArray(participants)) {
    participantIds = participants
      .map((item) => numericId(item, ["tid", "id"]))
      .filter((id) => id !== undefined);
  }
  const workflowParticipant = await attempt(mcpClient, "limesurvey_add_participant", {
    survey_id: primarySurveyId,
    participant: {
      firstname: "MCP",
      lastname: "Delete",
      email: "mcp-delete@example.invalid",
      token: `${stamp}D`,
    },
    create_token: false,
  });
  const workflowParticipantRow = firstParticipant(workflowParticipant);
  const workflowParticipantId = numericId(workflowParticipantRow, ["tid", "id"]);
  if (workflowParticipantId) participantIds.push(workflowParticipantId);

  await attempt(mcpClient, "limesurvey_list_participants", {
    survey_id: primarySurveyId,
    limit: 100,
    attributes: ["tid", "firstname", "lastname", "email", "token"],
  });
  await attempt(mcpClient, "limesurvey_list_filtered_participants", {
    survey_id: primarySurveyId,
    conditions: { firstname: "MCP" },
    attributes: ["tid", "firstname", "lastname", "email", "token"],
    limit: 100,
  });
  await attempt(mcpClient, "limesurvey_get_participant_properties", {
    survey_id: primarySurveyId,
    query: { token: `${stamp}R` },
    properties: ["tid", "firstname", "lastname", "email", "token"],
  });
  await attempt(mcpClient, "limesurvey_set_participant_properties", {
    survey_id: primarySurveyId,
    query: { token: `${stamp}R` },
    data: { lastname: "Response Updated" },
  });
  if (workflowParticipantId) {
    await attempt(mcpClient, "limesurvey_delete_participants", {
      survey_id: primarySurveyId,
      token_ids: [workflowParticipantId],
      confirm_destructive_action: true,
    });
    participantIds = participantIds.filter((id) => id !== workflowParticipantId);
  }

  await invoke(mcpClient, "limesurvey_activate_survey", {
    survey_id: primarySurveyId,
    activation_settings: { anonymized: "N", datestamp: "Y" },
    confirm_activation: true,
  });
  const fieldMap = await invoke(mcpClient, "limesurvey_get_fieldmap", {
    survey_id: primarySurveyId,
    language: "en",
  });
  const fieldEntries = fieldMap && typeof fieldMap === "object" ? Object.entries(fieldMap) : [];
  const uploadField = fieldEntries.find(([, value]) => value && typeof value === "object" && value.type === "|")?.[0];
  const textField = fieldEntries.find(([, value]) => value && typeof value === "object" && value.type === "T")?.[0];

  let uploadMetadata;
  if (uploadField) {
    uploadMetadata = await attempt(mcpClient, "limesurvey_upload_file", {
      survey_id: primarySurveyId,
      field_name: uploadField,
      file_name: "mcp-live-test.png",
      file_content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    });
  }

  const response = { token: `${stamp}R`, ...(textField ? { [textField]: "MCP live response" } : {}) };
  if (uploadField && uploadMetadata && typeof uploadMetadata === "object") {
    response[uploadField] = JSON.stringify([{
      title: "MCP live test file",
      comment: "Created by integration test",
      size: uploadMetadata.size,
      name: uploadMetadata.name,
      filename: uploadMetadata.filename,
      ext: uploadMetadata.ext,
    }]);
  }
  const addedResponse = await invoke(mcpClient, "limesurvey_add_response", {
    survey_id: primarySurveyId,
    response,
  });
  responseId = numericId(addedResponse, ["id", "response_id"]);
  if (responseId) {
    await attempt(mcpClient, "limesurvey_update_response", {
      survey_id: primarySurveyId,
      response: { id: responseId, ...(textField ? { [textField]: "MCP live response updated" } : {}) },
    });
  }

  await attempt(mcpClient, "limesurvey_get_response_ids", {
    survey_id: primarySurveyId,
    token: `${stamp}R`,
  });
  await attempt(mcpClient, "limesurvey_get_uploaded_files", {
    survey_id: primarySurveyId,
    token: `${stamp}R`,
    response_id: responseId ?? null,
  });
  await attempt(mcpClient, "limesurvey_get_summary", { survey_id: primarySurveyId, statistic: "all" });
  await attempt(mcpClient, "limesurvey_export_timeline", {
    survey_id: primarySurveyId,
    period: "day",
    start: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    end: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  });
  await attempt(mcpClient, "limesurvey_export_responses", {
    survey_id: primarySurveyId,
    document_type: "csv",
    language_code: "en",
    completion_status: "all",
  });
  await attempt(mcpClient, "limesurvey_export_responses_by_token", {
    survey_id: primarySurveyId,
    document_type: "csv",
    tokens: `${stamp}R`,
    language_code: "en",
    completion_status: "all",
  });
  await attempt(mcpClient, "limesurvey_export_statistics", {
    survey_id: primarySurveyId,
    document_type: "html",
    language: "en",
    include_graphs: "0",
  });

  const responseExport = await attempt(mcpClient, "limesurvey_export_responses_to_file", {
    survey_id: primarySurveyId,
    document_type: "csv",
    language_code: "en",
    file_name: `${prefix}-responses.csv`,
  });
  if (responseExport && typeof responseExport === "object" && typeof responseExport.path === "string") {
    generatedExportPaths.push(responseExport.path);
  }
  const tokenExport = await attempt(mcpClient, "limesurvey_export_responses_by_token_to_file", {
    survey_id: primarySurveyId,
    document_type: "csv",
    tokens: `${stamp}R`,
    language_code: "en",
    file_name: `${prefix}-token-responses.csv`,
  });
  if (tokenExport && typeof tokenExport === "object" && typeof tokenExport.path === "string") {
    generatedExportPaths.push(tokenExport.path);
  }
  const statisticsExport = await attempt(mcpClient, "limesurvey_export_statistics_to_file", {
    survey_id: primarySurveyId,
    document_type: "html",
    language: "en",
    file_name: `${prefix}-statistics.html`,
  });
  if (statisticsExport && typeof statisticsExport === "object" && typeof statisticsExport.path === "string") {
    generatedExportPaths.push(statisticsExport.path);
  }

  const emailParticipantId = participantIds[1];
  await attempt(mcpClient, "limesurvey_invite_participants", {
    survey_id: primarySurveyId,
    token_ids: emailParticipantId ? [emailParticipantId] : null,
    send_email: true,
    continue_on_error: true,
    confirm_send_email: true,
  });
  await attempt(mcpClient, "limesurvey_set_participant_properties", {
    survey_id: primarySurveyId,
    query: { token: `${stamp}E` },
    data: { sent: new Date(Date.now() - 86_400_000).toISOString().replace("T", " ").slice(0, 19) },
  });
  await attempt(mcpClient, "limesurvey_remind_participants", {
    survey_id: primarySurveyId,
    minimum_days_between: 0,
    maximum_reminders: 1,
    token_ids: emailParticipantId ? [emailParticipantId] : false,
    continue_on_error: true,
    confirm_send_email: true,
  });
  await attempt(mcpClient, "limesurvey_mail_registered_participants", {
    survey_id: primarySurveyId,
    override_conditions: emailParticipantId ? { tid: emailParticipantId } : {},
    confirm_send_email: true,
  });

  const cpdEmail = `mcp-live-test-${stamp}@example.invalid`;
  const cpdImport = await attempt(mcpClient, "limesurvey_cpd_importParticipants", {
    participants: [{ firstname: "MCP", lastname: `Live Test ${stamp}`, email: cpdEmail }],
    update_existing: false,
  });
  if (
    cpdImport
    && typeof cpdImport === "object"
    && Number(cpdImport.ImportCount ?? 0) > 0
  ) {
    manualCleanup.push({
      type: "central_participant",
      email: cpdEmail,
      reason: "RemoteControl provides cpd_importParticipants but no matching CPD delete method.",
    });
  }

  await attempt(mcpClient, "limesurvey_list_response_export_formats", {}, {
    expectedError: /disabled|extension/i,
  });

  const generated = await attempt(mcpClient, "limesurvey_generate_survey_theme", {
    theme_name: `mcp_live_${stamp}`,
    title: `${prefix} Theme`,
    author: "Wagner-Emden IT Services",
    target_limesurvey_major: "7",
  });
  if (generated && typeof generated === "object" && typeof generated.file_name === "string") {
    generatedThemePath = generated.path;
    await attempt(mcpClient, "limesurvey_validate_survey_theme", { file_name: generated.file_name });
    await attempt(mcpClient, "limesurvey_get_theme_publication_guide", {
      theme_name: `mcp_live_${stamp}`,
      package_file_name: generated.file_name,
      installed_limesurvey_version: "7.0.5",
      hosting: "self_hosted",
      publication_scope: "instance",
    });
  }

  if (responseId) {
    await attempt(mcpClient, "limesurvey_delete_response", {
      survey_id: primarySurveyId,
      response_id: responseId,
      confirm_destructive_action: true,
    });
    responseId = undefined;
  }
  if (participantIds.length > 0) {
    await attempt(mcpClient, "limesurvey_delete_participants", {
      survey_id: primarySurveyId,
      token_ids: participantIds,
      confirm_destructive_action: true,
    });
    participantIds = [];
  }
  await attempt(mcpClient, "limesurvey_release_session_key");
} finally {
  for (const action of cleanup.reverse()) {
    try {
      await action();
    } catch {
      // Cleanup failures are already recorded by attempt().
    }
  }
  for (const exportPath of generatedExportPaths) await rm(exportPath, { force: true });
  if (generatedThemePath) await rm(generatedThemePath, { force: true });
  await mcpClient.close().catch(() => {});
  await server.close().catch(() => {});
}

const allTools = 68;
const failed = results.filter((item) => item.status === "failed");
const passed = results.filter((item) => item.status === "passed" || item.status === "expected_error");
console.log(JSON.stringify({
  run: prefix,
  total_server_tools: allTools,
  unique_tools_exercised: testedTools.size,
  passed: passed.length,
  failed: failed.length,
  untested_tools: allTools - testedTools.size,
  manual_cleanup: manualCleanup,
  results,
}, null, 2));

if (failed.length > 0 || testedTools.size !== allTools) process.exitCode = 1;
