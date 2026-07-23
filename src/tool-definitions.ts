import { z } from "zod";
import type { JsonValue } from "./types.js";

export type ResponseFormat = "json" | "markdown";

export interface ParameterDefinition {
  key: string;
  schema: z.ZodTypeAny;
  defaultValue?: JsonValue;
}

export interface ToolDefinition {
  method: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  parameters: ParameterDefinition[];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: true;
  };
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
) as z.ZodType<JsonValue>;

const responseFormatSchema = z
  .enum(["json", "markdown"])
  .default("json")
  .describe("Output format. JSON preserves the complete structured result; Markdown is optimized for reading.");

const string = (description: string) => z.string().min(1).describe(description);
const optionalString = (description: string) => z.string().min(1).nullable().optional().describe(description);
const integer = (description: string) => z.number().int().nonnegative().describe(description);
const positiveInteger = (description: string) => z.number().int().positive().describe(description);
const optionalInteger = (description: string) => z.number().int().nonnegative().nullable().optional().describe(description);
const jsonObject = (description: string) => z.record(z.string(), jsonValueSchema).describe(description);
const stringArray = (description: string) => z.array(z.string()).describe(description);
const optionalStringArray = (description: string) => z.array(z.string()).nullable().optional().describe(description);

function p(key: string, schema: z.ZodTypeAny, defaultValue?: JsonValue): ParameterDefinition {
  return defaultValue === undefined ? { key, schema } : { key, schema, defaultValue };
}

function define(
  method: string,
  title: string,
  summary: string,
  access: "read" | "write" | "delete",
  parameters: ParameterDefinition[] = [],
): ToolDefinition {
  const shape: Record<string, z.ZodTypeAny> = { response_format: responseFormatSchema };
  for (const parameter of parameters) shape[parameter.key] = parameter.schema;
  let confirmation = "";
  if (access === "delete") {
    shape.confirm_destructive_action = z.literal(true).describe("Required acknowledgement of the permanent deletion.");
    confirmation = " Requires confirm_destructive_action=true.";
  } else if (["mail_registered_participants", "invite_participants", "remind_participants"].includes(method)) {
    shape.confirm_send_email = z.literal(true).describe("Required acknowledgement that email may be sent to participants.");
    confirmation = " Requires confirm_send_email=true.";
  } else if (method === "activate_survey") {
    shape.confirm_activation = z.literal(true).describe("Required acknowledgement that survey activation changes its structure and behavior.");
    confirmation = " Requires confirm_activation=true.";
  }
  return {
    method,
    title,
    description: `${summary}${confirmation}\n\nCalls LimeSurvey RemoteControl method \`${method}\`. Authentication uses the configured service account; do not provide a session key.`,
    inputSchema: z.object(shape).strict(),
    parameters,
    annotations: {
      readOnlyHint: access === "read",
      destructiveHint: access === "delete",
      idempotentHint: access === "read",
      openWorldHint: true,
    },
  };
}

const surveyId = () => p("survey_id", positiveInteger("Numeric LimeSurvey survey ID."));
const groupId = () => p("group_id", positiveInteger("Numeric question-group ID."));
const questionId = () => p("question_id", positiveInteger("Numeric question ID."));
const language = (key = "language") => p(key, optionalString("LimeSurvey language code; null uses the survey default."), null);
const propertyNames = (key: string, resource: string) =>
  p(key, optionalStringArray(`Properties to return for the ${resource}; null returns all available properties.`), null);

export const toolDefinitions: ToolDefinition[] = [
  define("get_session_key", "Connect to LimeSurvey", "Open and cache an authenticated RemoteControl session without exposing its key.", "write"),
  define("release_session_key", "Disconnect from LimeSurvey", "Release the cached RemoteControl session.", "write"),
  define("get_available_site_settings", "List available site settings", "List global setting names available to a super administrator.", "read"),
  define("get_site_settings", "Get site setting", "Read one global LimeSurvey setting.", "read", [p("setting_name", string("Global setting name."))]),

  define("add_survey", "Create survey", "Create an empty survey with minimum settings.", "write", [
    p("survey_id", integer("Desired survey ID. Use 0 to let LimeSurvey choose.")),
    p("title", string("Title of the new survey.")),
    p("language", string("Base language code for the survey.")),
    p("format", z.enum(["A", "G", "S"]).optional().describe("Question display format: all, group-by-group, or single question."), "G"),
  ]),
  define("delete_survey", "Delete survey", "Permanently delete a survey.", "delete", [surveyId()]),
  define("import_survey", "Import survey", "Import a base64-encoded LSA, CSV, TXT, or LSS survey.", "write", [
    p("import_data", string("Base64-encoded survey file contents.")),
    p("import_data_type", z.enum(["lsa", "csv", "txt", "lss"]).describe("Import file type.")),
    p("new_survey_name", optionalString("Optional replacement survey name."), null),
    p("destination_survey_id", optionalInteger("Optional desired ID for the imported survey."), null),
  ]),
  define("copy_survey", "Copy survey", "Copy an existing survey under a new name.", "write", [
    p("source_survey_id", positiveInteger("ID of the survey to copy.")),
    p("new_name", string("Name for the copied survey.")),
    p("destination_survey_id", optionalInteger("Optional desired ID for the copy."), null),
  ]),
  define("get_survey_properties", "Get survey properties", "Read selected survey properties.", "read", [surveyId(), propertyNames("properties", "survey")]),
  define("set_survey_properties", "Set survey properties", "Update editable survey properties.", "write", [surveyId(), p("data", jsonObject("Survey property names mapped to new values."))]),
  define("activate_survey", "Activate survey", "Activate a survey after LimeSurvey consistency checks.", "write", [
    surveyId(),
    p("activation_settings", jsonObject("Optional activation settings such as anonymized, datestamp, ipaddr, ipanonymize, refurl, and savetimings.").optional(), {}),
  ]),
  define("export_statistics", "Export survey statistics", "Export survey statistics as a base64-encoded PDF, XLS, or HTML document.", "read", [
    surveyId(),
    p("document_type", z.enum(["pdf", "xls", "html"]).optional().describe("Statistics document type."), "pdf"),
    language(),
    p("include_graphs", z.enum(["0", "1"]).optional().describe("Whether to include graphs."), "0"),
    p("group_ids", z.union([positiveInteger("One group ID."), z.array(z.number().int().positive())]).nullable().optional().describe("Optional group ID or list of group IDs."), null),
  ]),
  define("export_timeline", "Export response timeline", "Return response counts by day or hour for a date range.", "read", [
    surveyId(),
    p("period", z.enum(["day", "hour"]).describe("Timeline aggregation period.")),
    p("start", string("Start date/time accepted by LimeSurvey.")),
    p("end", string("End date/time accepted by LimeSurvey.")),
  ]),
  define("get_summary", "Get survey summary", "Read response and participant summary counters.", "read", [
    surveyId(),
    p("statistic", z.enum(["all", "completed_responses", "incomplete_responses", "full_responses", "token_count", "token_invalid", "token_sent", "token_opted_out", "token_completed", "token_screenout"]).optional().describe("Summary statistic to return."), "all"),
  ]),

  define("add_language", "Add survey language", "Add a language to a survey.", "write", [surveyId(), p("language", string("Language code to add."))]),
  define("delete_language", "Delete survey language", "Remove a non-base language from a survey.", "delete", [surveyId(), p("language", string("Language code to remove."))]),
  define("get_language_properties", "Get language properties", "Read localized survey properties.", "read", [surveyId(), propertyNames("properties", "survey language"), language()]),
  define("set_language_properties", "Set language properties", "Update localized survey properties.", "write", [surveyId(), p("data", jsonObject("Localized property names mapped to new values.")), language()]),

  define("add_group", "Create question group", "Add an empty question group to a survey.", "write", [surveyId(), p("title", string("Question-group title.")), p("description", z.string().optional().describe("Question-group description."), "")]),
  define("delete_group", "Delete question group", "Delete a question group from a survey.", "delete", [surveyId(), groupId()]),
  define("import_group", "Import question group", "Import a base64-encoded question group into a survey.", "write", [
    surveyId(),
    p("import_data", string("Base64-encoded group file contents.")),
    p("import_data_type", string("Import type supported by the LimeSurvey instance, normally lsg.")),
    p("new_group_name", optionalString("Optional replacement group name."), null),
    p("new_group_description", optionalString("Optional replacement group description."), null),
  ]),
  define("get_group_properties", "Get group properties", "Read selected question-group properties.", "read", [groupId(), propertyNames("properties", "question group"), language()]),
  define("set_group_properties", "Set group properties", "Update question-group properties.", "write", [groupId(), p("data", jsonObject("Group property names mapped to new values."))]),

  define("delete_question", "Delete question", "Delete a question from its survey.", "delete", [questionId()]),
  define("import_question", "Import question", "Import a base64-encoded question into a survey group.", "write", [
    surveyId(), groupId(),
    p("import_data", string("Base64-encoded question file contents.")),
    p("import_data_type", string("Import type supported by the LimeSurvey instance, normally lsq.")),
    p("mandatory", z.enum(["Y", "N"]).optional().describe("Whether the imported question is mandatory."), "N"),
    p("new_question_title", optionalString("Optional replacement question code/title."), null),
    p("new_question_text", optionalString("Optional replacement question text."), null),
    p("new_question_help", optionalString("Optional replacement help text."), null),
  ]),
  define("get_question_properties", "Get question properties", "Read selected question properties.", "read", [questionId(), propertyNames("properties", "question"), language()]),
  define("set_question_properties", "Set question properties", "Update question properties.", "write", [questionId(), p("data", jsonObject("Question property names mapped to new values.")), language()]),

  define("activate_tokens", "Activate participant table", "Create the survey participant table and optional custom attributes.", "write", [surveyId(), p("attribute_fields", z.array(z.number().int().positive()).optional().describe("Additional participant attribute field numbers."), [])]),
  define("add_participants", "Add survey participants", "Add one or more participants to a survey.", "write", [
    surveyId(),
    p("participants", z.array(jsonObject("Participant data.")).min(1).describe("Participant records.")),
    p("create_token", z.boolean().optional().describe("Generate missing participant tokens."), true),
  ]),
  define("delete_participants", "Delete survey participants", "Delete participants by token-table row IDs.", "delete", [surveyId(), p("token_ids", z.array(z.number().int().positive()).min(1).describe("Participant token-table row IDs."))]),
  define("get_participant_properties", "Get participant properties", "Read selected properties for a participant matched by token or token-table ID.", "read", [
    surveyId(),
    p("query", jsonObject("Participant lookup properties, such as token or tid.")),
    propertyNames("properties", "participant"),
  ]),
  define("set_participant_properties", "Set participant properties", "Update a participant matched by token or token-table ID.", "write", [surveyId(), p("query", jsonObject("Participant lookup properties.")), p("data", jsonObject("Participant properties to update."))]),
  define("list_participants", "List survey participants", "List and filter survey participants with server-side pagination.", "read", [
    surveyId(),
    p("start", z.number().int().nonnegative().optional().describe("Zero-based result offset."), 0),
    p("limit", z.number().int().min(1).max(1000).optional().describe("Maximum participants to return."), 10),
    p("unused", z.boolean().optional().describe("Return only unused participants."), false),
    p("attributes", z.union([z.literal(false), stringArray("Participant fields to return.")]).optional().describe("Fields to return, or false for defaults."), false),
    p("conditions", z.union([jsonObject("Participant filter conditions."), z.array(jsonValueSchema)]).optional().describe("Participant filter conditions as an object or positional condition list."), {}),
  ]),
  define("mail_registered_participants", "Email registered participants", "Send registration emails to survey participants.", "write", [surveyId(), p("override_conditions", z.union([jsonObject("Email selection/override conditions."), z.array(jsonValueSchema)]).optional().describe("Replacement email conditions as an object or positional condition list."), {})]),
  define("invite_participants", "Invite survey participants", "Send survey invitation emails to selected or eligible participants.", "write", [
    surveyId(),
    p("token_ids", z.array(z.number().int().positive()).nullable().optional().describe("Optional participant row IDs; null selects eligible participants."), null),
    p("send_email", z.boolean().optional().describe("Actually send invitation emails."), true),
    p("continue_on_error", z.boolean().optional().describe("Continue after individual email errors."), false),
  ]),
  define("remind_participants", "Remind survey participants", "Send reminder emails to selected or eligible participants.", "write", [
    surveyId(),
    p("minimum_days_between", optionalInteger("Minimum days since the previous reminder."), null),
    p("maximum_reminders", optionalInteger("Maximum reminders per participant."), null),
    p("token_ids", z.union([z.literal(false), z.array(z.number().int().positive())]).optional().describe("Participant row IDs, or false for eligible participants."), false),
    p("continue_on_error", z.boolean().optional().describe("Continue after individual email errors."), false),
  ]),

  define("list_groups", "List question groups", "List question groups in a survey.", "read", [surveyId(), language()]),
  define("list_questions", "List questions", "List questions and subquestions in a survey or group.", "read", [surveyId(), p("group_id", optionalInteger("Optional question-group ID."), null), language()]),
  define("list_quotas", "List quotas", "List quotas configured for a survey.", "read", [surveyId()]),
  define("add_quota", "Create quota", "Create a quota with minimum details.", "write", [
    surveyId(), p("name", string("Quota name.")), p("limit", z.number().int().positive().describe("Maximum responses allowed.")),
    p("active", z.boolean().optional().describe("Activate the quota immediately."), true),
    p("action", z.enum(["terminate", "confirm_terminate"]).optional().describe("Quota action."), "terminate"),
    p("autoload_url", z.boolean().optional().describe("Automatically load the quota URL."), false),
    p("message", z.string().optional().describe("Quota message."), ""),
    p("url", z.string().optional().describe("Quota redirect URL."), ""),
    p("url_description", z.string().optional().describe("Quota URL label."), ""),
  ]),
  define("delete_quota", "Delete quota", "Delete a survey quota.", "delete", [p("quota_id", positiveInteger("Numeric quota ID."))]),
  define("get_quota_properties", "Get quota properties", "Read selected quota properties.", "read", [p("quota_id", positiveInteger("Numeric quota ID.")), propertyNames("properties", "quota"), language()]),
  define("set_quota_properties", "Set quota properties", "Update quota properties.", "write", [p("quota_id", positiveInteger("Numeric quota ID.")), p("data", jsonObject("Quota properties to update."))]),

  define("list_surveys", "List surveys", "List surveys visible to a user, optionally filtered by survey group.", "read", [
    p("username", optionalString("Optional administration username; null uses the current service account."), null),
    p("survey_group_id", optionalInteger("Optional survey-group ID."), null),
  ]),
  define("list_survey_groups", "List survey groups", "List survey groups visible to a user.", "read", [p("username", optionalString("Optional administration username; null uses the current service account."), null)]),
  define("list_users", "List administration users", "List administration users, optionally filtered by ID or username.", "read", [
    p("user_id", optionalInteger("Optional administration user ID."), null),
    p("username", optionalString("Optional administration username."), null),
  ]),

  define("add_response", "Add survey response", "Insert a response into a survey response table.", "write", [surveyId(), p("response", jsonObject("Response fields mapped to values."))]),
  define("update_response", "Update survey response", "Update a response; include its response ID in the data.", "write", [surveyId(), p("response", jsonObject("Response fields, including the response ID, mapped to new values."))]),
  define("delete_response", "Delete survey response", "Permanently delete a response.", "delete", [surveyId(), p("response_id", positiveInteger("Numeric response ID."))]),
  define("upload_file", "Upload response file", "Upload a base64-encoded file for a file-upload question.", "write", [
    surveyId(), p("field_name", string("Survey response field name.")), p("file_name", string("Original file name.")), p("file_content", string("Base64-encoded file contents.")),
  ]),
  define("export_responses", "Export survey responses", "Export responses as a base64-encoded document.", "read", [
    surveyId(), p("document_type", string("Export type such as csv, html, pdf, xls, or json.")), language("language_code"),
    p("completion_status", z.enum(["all", "complete", "incomplete"]).optional().describe("Completion filter."), "all"),
    p("heading_type", z.enum(["code", "full", "abbreviated"]).optional().describe("Column heading style."), "code"),
    p("response_type", z.enum(["short", "long"]).optional().describe("Answer text format."), "short"),
    p("from_response_id", optionalInteger("Optional first response ID."), null),
    p("to_response_id", optionalInteger("Optional last response ID."), null),
    p("fields", optionalStringArray("Optional response fields to export."), null),
    p("additional_options", jsonObject("Additional exporter options.").nullable().optional(), null),
  ]),
  define("export_responses_by_token", "Export responses by token", "Export responses for selected participant tokens as a base64-encoded document.", "read", [
    surveyId(), p("document_type", string("Export type such as csv, html, pdf, xls, or json.")), p("tokens", z.union([string("One participant token."), z.array(z.string()).min(1)]).describe("One participant token or a list of tokens to export.")), language("language_code"),
    p("completion_status", z.enum(["all", "complete", "incomplete"]).optional().describe("Completion filter."), "all"),
    p("heading_type", z.enum(["code", "full", "abbreviated"]).optional().describe("Column heading style."), "code"),
    p("response_type", z.enum(["short", "long"]).optional().describe("Answer text format."), "short"),
    p("fields", optionalStringArray("Optional response fields to export."), null),
  ]),
  define("get_response_ids", "Find response IDs", "Find response IDs for a participant token.", "read", [surveyId(), p("token", string("Participant token."))]),
  define("get_uploaded_files", "Get uploaded response files", "Return uploaded file metadata and base64 content for a token or response.", "read", [surveyId(), p("token", string("Participant token.")), p("response_id", optionalInteger("Optional response ID."), null)]),
  define("get_fieldmap", "Get survey field map", "Return the survey response field map.", "read", [surveyId(), language()]),
  define("cpd_importParticipants", "Import central participants", "Import records into the central participant database.", "write", [
    p("participants", z.array(jsonObject("Central participant record.")).min(1).describe("Central participant records.")),
    p("update_existing", z.boolean().optional().describe("Update matching existing records."), false),
  ]),
];

export function buildRpcParams(
  definition: ToolDefinition,
  input: Record<string, unknown>,
): JsonValue[] {
  let lastIndex = -1;
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const parameter = definition.parameters[index];
    if (parameter && input[parameter.key] !== undefined) lastIndex = index;
  }

  const result: JsonValue[] = [];
  for (let index = 0; index <= lastIndex; index += 1) {
    const parameter = definition.parameters[index];
    if (!parameter) continue;
    const value = input[parameter.key] ?? parameter.defaultValue;
    if (value === undefined) {
      throw new Error(`Missing positional parameter ${parameter.key} for ${definition.method}.`);
    }
    result.push(value as JsonValue);
  }
  return result;
}
