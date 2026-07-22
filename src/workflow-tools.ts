import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LimeSurveyClient } from "./client.js";
import { buildRpcParams, jsonValueSchema, toolDefinitions } from "./tool-definitions.js";
import { LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

const outputSchema = z.object({ workflow: z.string(), result: jsonValueSchema });
const surveyId = z.number().int().positive().describe("Numeric LimeSurvey survey ID.");
const optionalLanguage = z.string().min(1).nullable().optional().describe("Optional LimeSurvey language code.");

type WorkflowResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { workflow: string; result: JsonValue };
  isError?: true;
};

function text(workflow: string, result: JsonValue): WorkflowResult {
  const structuredContent = { workflow, result };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function error(workflow: string, value: unknown): WorkflowResult {
  const result: JsonValue = {
    status: "error",
    message: value instanceof Error ? value.message : String(value),
    ...(value instanceof LimeSurveyError && value.code ? { code: value.code } : {}),
  };
  return { ...text(workflow, result), isError: true };
}

async function run(
  config: LimeSurveyConfig,
  workflow: string,
  writes: boolean,
  operation: () => Promise<JsonValue>,
): Promise<WorkflowResult> {
  if (writes && config.readOnly) {
    return error(
      workflow,
      new LimeSurveyError(
        `The tool is disabled because LIMESURVEY_READ_ONLY=true. Use a read-only tool or explicitly disable read-only mode for this server.`,
      ),
    );
  }
  try {
    return text(workflow, await operation());
  } catch (value) {
    return error(workflow, value);
  }
}

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function findDefinition(method: string) {
  const definition = toolDefinitions.find((item) => item.method === method);
  if (!definition) throw new LimeSurveyError(`Internal tool definition for ${method} was not found.`);
  return definition;
}

function decodeBase64(value: JsonValue, maxBytes: number): Buffer {
  if (typeof value !== "string") {
    throw new LimeSurveyError("LimeSurvey did not return a base64 string for the export.");
  }
  const normalized = value.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new LimeSurveyError("LimeSurvey returned invalid base64 export data.");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.byteLength > maxBytes) {
    throw new LimeSurveyError(
      `The decoded export is ${decoded.byteLength} bytes and exceeds LIMESURVEY_MAX_EXPORT_BYTES (${maxBytes}).`,
    );
  }
  return decoded;
}

const mimeTypes: Record<string, string> = {
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  pdf: "application/pdf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function saveExport(
  config: LimeSurveyConfig,
  data: JsonValue,
  documentType: string,
  requestedName: string | undefined,
  overwrite: boolean,
  confirmOverwrite: boolean,
): Promise<JsonValue> {
  if (!config.exportDir) {
    throw new LimeSurveyError(
      "LIMESURVEY_EXPORT_DIR is not configured. Set it to a dedicated writable directory before using file export tools.",
    );
  }
  const extension = documentType.toLowerCase().replace(/[^a-z0-9]/g, "");
  let fileName = requestedName ?? `limesurvey-export-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  if (
    fileName !== path.basename(fileName)
    || fileName.includes("/")
    || fileName.includes("\\")
    || fileName === "."
    || fileName === ".."
    || fileName.includes("\0")
  ) {
    throw new LimeSurveyError("file_name must be a plain file name without directories or traversal segments.");
  }
  if (!path.extname(fileName)) fileName += `.${extension}`;
  if (overwrite && !confirmOverwrite) {
    throw new LimeSurveyError("confirm_overwrite=true is required when overwrite=true.");
  }

  const root = path.resolve(config.exportDir);
  const target = path.resolve(root, fileName);
  const relativeTarget = path.relative(root, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new LimeSurveyError("The requested export path is outside LIMESURVEY_EXPORT_DIR.");
  }
  const decoded = decodeBase64(data, config.maxExportBytes ?? 100 * 1024 * 1024);
  await mkdir(root, { recursive: true });
  try {
    await writeFile(target, decoded, { flag: overwrite ? "w" : "wx", mode: 0o600 });
    await chmod(target, 0o600);
  } catch (value) {
    const code = value && typeof value === "object" && "code" in value ? String(value.code) : undefined;
    if (code === "EEXIST") {
      throw new LimeSurveyError(
        "The export file already exists. Choose another file_name or set overwrite=true and confirm_overwrite=true.",
      );
    }
    throw value;
  }
  return {
    status: "saved",
    file_name: fileName,
    path: target,
    bytes: decoded.byteLength,
    sha256: createHash("sha256").update(decoded).digest("hex"),
    mime_type: mimeTypes[extension] ?? "application/octet-stream",
  };
}

const exportFileFields = {
  file_name: z.string().min(1).optional().describe("Optional output file name without a directory."),
  overwrite: z.boolean().default(false).describe("Allow replacing an existing file."),
  confirm_overwrite: z.boolean().default(false).describe("Required acknowledgement when overwrite is true."),
};

export function registerWorkflowTools(
  server: McpServer,
  client: LimeSurveyClient,
  config: LimeSurveyConfig,
): void {
  server.registerTool(
    "limesurvey_find_surveys",
    {
      title: "Find surveys",
      description: "Find visible surveys by ID or title with bounded client-side pagination.",
      inputSchema: z.object({
        query: z.string().default("").describe("Case-insensitive survey ID or title fragment."),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(100).default(20),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, offset, limit }) => run(config, "find_surveys", false, async () => {
      const value = await client.call("list_surveys", [null, null]);
      const surveys = Array.isArray(value) ? value : [];
      const needle = query.toLowerCase();
      const matches = surveys.filter((survey) => {
        const object = objectValue(survey);
        if (!object) return false;
        const id = String(object.sid ?? object.survey_id ?? "");
        const title = String(object.surveyls_title ?? object.title ?? "");
        return !needle || id.toLowerCase().includes(needle) || title.toLowerCase().includes(needle);
      });
      return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit };
    }),
  );

  server.registerTool(
    "limesurvey_get_survey_languages",
    {
      title: "Get survey languages",
      description: "Return the base and additional language codes configured for a survey.",
      inputSchema: z.object({ survey_id: surveyId }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ survey_id }) => run(config, "get_survey_languages", false, async () => {
      const value = await client.call("get_survey_properties", [survey_id, ["language", "additional_languages"]]);
      const properties = objectValue(value) ?? {};
      const languages = new Set<string>();
      if (typeof properties.language === "string" && properties.language) languages.add(properties.language);
      const additional = properties.additional_languages;
      if (typeof additional === "string") {
        for (const language of additional.split(/[\s,;]+/).filter(Boolean)) languages.add(language);
      } else if (Array.isArray(additional)) {
        for (const language of additional) if (typeof language === "string" && language) languages.add(language);
      }
      return { survey_id, languages: [...languages] };
    }),
  );

  server.registerTool(
    "limesurvey_add_participant",
    {
      title: "Add one survey participant",
      description: "Add one participant using a simple participant object.",
      inputSchema: z.object({
        survey_id: surveyId,
        participant: z.record(jsonValueSchema).describe("Participant fields such as email, firstname, lastname, token, and attributes."),
        create_token: z.boolean().default(true),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ survey_id, participant, create_token }) => run(
      config,
      "add_participant",
      true,
      () => client.call("add_participants", [survey_id, [participant], create_token]),
    ),
  );

  server.registerTool(
    "limesurvey_list_filtered_participants",
    {
      title: "List filtered participants",
      description: "List participant rows with explicit filters, selected fields, and bounded pagination.",
      inputSchema: z.object({
        survey_id: surveyId,
        conditions: z.record(jsonValueSchema).default({}),
        attributes: z.union([z.literal(false), z.array(z.string())]).default(false),
        unused: z.boolean().default(false),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().positive().max(1000).default(100),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ survey_id, conditions, attributes, unused, offset, limit }) => run(
      config,
      "list_filtered_participants",
      false,
      () => client.call("list_participants", [survey_id, offset, limit, unused, attributes, conditions]),
    ),
  );

  server.registerTool(
    "limesurvey_list_response_export_formats",
    {
      title: "List response export formats",
      description: "Call the optional list_response_exports LimeSurvey extension to discover plugin-aware export formats.",
      inputSchema: z.object({}).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => run(config, "list_response_export_formats", false, async () => {
      if (!config.enableExperimentalMethods) {
        throw new LimeSurveyError(
          "The non-standard list_response_exports method is disabled. Install the matching LimeSurvey extension and set LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS=true.",
        );
      }
      return client.call("list_response_exports");
    }),
  );

  server.registerTool(
    "limesurvey_export_responses_to_file",
    {
      title: "Export responses to a file",
      description: "Export responses and securely decode the base64 result inside LIMESURVEY_EXPORT_DIR.",
      inputSchema: z.object({
        survey_id: surveyId,
        document_type: z.string().min(1),
        language_code: optionalLanguage.default(null),
        completion_status: z.enum(["all", "complete", "incomplete"]).default("all"),
        heading_type: z.enum(["code", "full", "abbreviated"]).default("code"),
        response_type: z.enum(["short", "long"]).default("short"),
        from_response_id: z.number().int().nonnegative().nullable().default(null),
        to_response_id: z.number().int().nonnegative().nullable().default(null),
        fields: z.array(z.string()).nullable().default(null),
        additional_options: z.record(jsonValueSchema).nullable().default(null),
        ...exportFileFields,
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => run(config, "export_responses_to_file", true, async () => {
      const definition = findDefinition("export_responses");
      const data = await client.call("export_responses", buildRpcParams(definition, input));
      return saveExport(config, data, input.document_type, input.file_name, input.overwrite, input.confirm_overwrite);
    }),
  );

  server.registerTool(
    "limesurvey_export_responses_by_token_to_file",
    {
      title: "Export token responses to a file",
      description: "Export responses for selected tokens and securely decode the result inside LIMESURVEY_EXPORT_DIR.",
      inputSchema: z.object({
        survey_id: surveyId,
        document_type: z.string().min(1),
        tokens: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
        language_code: optionalLanguage.default(null),
        completion_status: z.enum(["all", "complete", "incomplete"]).default("all"),
        heading_type: z.enum(["code", "full", "abbreviated"]).default("code"),
        response_type: z.enum(["short", "long"]).default("short"),
        fields: z.array(z.string()).nullable().default(null),
        ...exportFileFields,
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => run(config, "export_responses_by_token_to_file", true, async () => {
      const definition = findDefinition("export_responses_by_token");
      const data = await client.call("export_responses_by_token", buildRpcParams(definition, input));
      return saveExport(config, data, input.document_type, input.file_name, input.overwrite, input.confirm_overwrite);
    }),
  );

  server.registerTool(
    "limesurvey_export_statistics_to_file",
    {
      title: "Export statistics to a file",
      description: "Export survey statistics and securely decode the result inside LIMESURVEY_EXPORT_DIR.",
      inputSchema: z.object({
        survey_id: surveyId,
        document_type: z.enum(["pdf", "xls", "html"]).default("pdf"),
        language: optionalLanguage.default(null),
        include_graphs: z.enum(["0", "1"]).default("0"),
        group_ids: z.union([z.number().int().positive(), z.array(z.number().int().positive())]).nullable().default(null),
        ...exportFileFields,
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => run(config, "export_statistics_to_file", true, async () => {
      const definition = findDefinition("export_statistics");
      const data = await client.call("export_statistics", buildRpcParams(definition, input));
      return saveExport(config, data, input.document_type, input.file_name, input.overwrite, input.confirm_overwrite);
    }),
  );
}
