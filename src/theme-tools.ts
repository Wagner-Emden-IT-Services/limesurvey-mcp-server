import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { z } from "zod";
import type { LimeSurveyClient } from "./client.js";
import { jsonValueSchema } from "./tool-definitions.js";
import { LimeSurveyError, type JsonValue, type LimeSurveyConfig } from "./types.js";

const outputSchema = z.object({ workflow: z.string(), result: jsonValueSchema });
const themeNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,63}$/, "Use 3-64 lowercase ASCII letters, digits, and underscores; start with a letter.")
  .describe("Unique LimeSurvey theme and folder name, for example acme_feedback.");
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hexadecimal color such as #0B6B57.");

type WorkflowResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { workflow: string; result: JsonValue };
  isError?: true;
};

function response(workflow: string, result: JsonValue, isError = false): WorkflowResult {
  const structuredContent = { workflow, result };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
  };
}

async function run(
  config: LimeSurveyConfig,
  workflow: string,
  writes: boolean,
  operation: () => Promise<JsonValue>,
): Promise<WorkflowResult> {
  if (writes && config.readOnly) {
    return response(workflow, {
      status: "error",
      message: "This tool is disabled because LIMESURVEY_READ_ONLY=true.",
    }, true);
  }
  try {
    return response(workflow, await operation());
  } catch (value) {
    return response(workflow, {
      status: "error",
      message: value instanceof Error ? value.message : String(value),
      ...(value instanceof LimeSurveyError && value.code ? { code: value.code } : {}),
    }, true);
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(first: string, second: string): number {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

function foreground(background: string): string {
  return contrast(background, "#FFFFFF") >= contrast(background, "#111111") ? "#FFFFFF" : "#111111";
}

function darken(hex: string, factor = 0.82): string {
  return `#${rgb(hex).map((value) => Math.round(value * factor).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function safeThemeTarget(config: LimeSurveyConfig, fileName: string): { root: string; target: string } {
  if (!config.themeDir) {
    throw new LimeSurveyError(
      "LIMESURVEY_THEME_DIR is not configured. Set it to a dedicated directory for generated theme packages, then "
        + "fully restart the MCP client process; reconnecting alone does not reload environment variables.",
    );
  }
  if (
    fileName !== path.basename(fileName)
    || fileName.includes("/")
    || fileName.includes("\\")
    || fileName.includes("\0")
    || !fileName.toLowerCase().endsWith(".zip")
  ) {
    throw new LimeSurveyError("Theme package file names must be plain .zip names without directories.");
  }
  const root = path.resolve(config.themeDir);
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LimeSurveyError("The theme package path is outside LIMESURVEY_THEME_DIR.");
  }
  return { root, target };
}

function decodeLogo(base64: string, type: "png" | "jpeg", maxBytes: number): Buffer {
  const normalized = base64.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new LimeSurveyError("logo_base64 is not valid base64.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength > maxBytes) {
    throw new LimeSurveyError(`The logo exceeds LIMESURVEY_MAX_THEME_ASSET_BYTES (${maxBytes}).`);
  }
  const valid = type === "png"
    ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (!valid) throw new LimeSurveyError(`The logo content does not match logo_file_type=${type}.`);
  return buffer;
}

function imageMatchesType(buffer: Buffer, type: "png" | "jpg" | "jpeg"): boolean {
  if (type === "png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (type === "jpg" || type === "jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  }
  return false;
}

const generatedThemeLicenseNotice = `GNU GENERAL PUBLIC LICENSE
Version 2, June 1991, or (at your option) any later version

This generated LimeSurvey survey theme is licensed under GPL-2.0-or-later.
It is designed to inherit the GPL-licensed LimeSurvey vanilla theme.

License text and terms:
https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

SPDX-License-Identifier: GPL-2.0-or-later
`;

function manifest(input: {
  themeName: string;
  title: string;
  description: string;
  author: string;
  authorEmail?: string;
  authorUrl?: string;
  themeVersion: string;
  targetMajor: "7" | "6";
}): string {
  const date = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <metadata>
    <name>${xmlEscape(input.themeName)}</name>
    <title>${xmlEscape(input.title)}</title>
    <type>theme</type>
    <creationDate>${date}</creationDate>
    <author>${xmlEscape(input.author)}</author>
    <authorEmail>${xmlEscape(input.authorEmail ?? "")}</authorEmail>
    <authorUrl>${xmlEscape(input.authorUrl ?? "")}</authorUrl>
    <copyright>Copyright (C) ${new Date().getUTCFullYear()} ${xmlEscape(input.author)}</copyright>
    <license>GNU General Public License version 2 or later</license>
    <version>${xmlEscape(input.themeVersion)}</version>
    <apiVersion>3.0</apiVersion>
    <description>${xmlEscape(input.description)}</description>
    <lastUpdate>${date}</lastUpdate>
    <extends>vanilla</extends>
  </metadata>
  <compatibility>
    <version>${input.targetMajor}.0</version>
  </compatibility>
  <files>
    <css>
      <add>css/mcp-theme.css</add>
    </css>
  </files>
</config>
`;
}

function themeCss(input: {
  themeName: string;
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  focus: string;
  font: "system" | "humanist" | "serif";
  radius: number;
  maxWidth: number;
  density: "comfortable" | "compact";
}): string {
  const primaryRgb = rgb(input.primary).join(", ");
  const primaryText = foreground(input.primary);
  const border = contrast(input.surface, input.muted) > 3 ? input.muted : "#CBD2D9";
  const fonts = {
    system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    humanist: '"Trebuchet MS", "Segoe UI", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
  };
  const spacing = input.density === "compact" ? "1rem" : "1.5rem";
  return `/* SPDX-License-Identifier: GPL-2.0-or-later
 * Responsive LimeSurvey theme generated by limesurvey-mcp-server.
 * Inherits the official vanilla (Bootstrap Vanilla) Bootstrap 5 survey theme.
 */
:root {
  --bs-primary: ${input.primary};
  --bs-primary-rgb: ${primaryRgb};
  --bs-body-color: ${input.text};
  --bs-body-bg: ${input.background};
  --bs-body-font-family: ${fonts[input.font]};
  --mcp-theme-accent: ${input.accent};
  --mcp-theme-surface: ${input.surface};
  --mcp-theme-muted: ${input.muted};
  --mcp-theme-border: ${border};
  --mcp-theme-radius: ${input.radius}px;
  --mcp-theme-max-width: ${input.maxWidth}px;
  --mcp-theme-primary-text: ${primaryText};
}

html { font-size: 100%; }
body {
  color: var(--bs-body-color);
  background: var(--bs-body-bg);
  font-family: var(--bs-body-font-family);
  font-size: 1rem;
  line-height: 1.6;
  letter-spacing: 0;
}

#outerframeContainer {
  width: min(100%, var(--mcp-theme-max-width));
  margin-inline: auto;
  padding-inline: 1.25rem;
}

.survey-name { font-size: 2rem; line-height: 1.2; font-weight: 700; letter-spacing: 0; }
.group-title {
  padding-inline-start: 0.75rem;
  border-inline-start: 4px solid var(--mcp-theme-accent);
  font-size: 1.5rem;
  line-height: 1.3;
  font-weight: 650;
  letter-spacing: 0;
}
.question-title-container { font-size: 1.125rem; line-height: 1.45; }

.question-container {
  margin-block: 1rem;
  padding: ${spacing};
  color: var(--bs-body-color);
  background: var(--mcp-theme-surface);
  border: 1px solid var(--mcp-theme-border);
  border-radius: var(--mcp-theme-radius);
  box-shadow: 0 2px 8px rgb(31 41 51 / 8%);
}

.text-muted, .question-help-container, .ls-questionhelp { color: var(--mcp-theme-muted) !important; }
.asterisk, .required { color: #B42318; }

.btn, .form-control, .form-select, .input-group-text {
  min-height: 44px;
  border-radius: var(--mcp-theme-radius);
}
.btn-primary {
  color: var(--mcp-theme-primary-text);
  background-color: var(--bs-primary);
  border-color: var(--bs-primary);
}
.btn-primary:hover, .btn-primary:active {
  color: var(--mcp-theme-primary-text);
  background-color: ${darken(input.primary)};
  border-color: ${darken(input.primary)};
}
.btn-outline-secondary { color: var(--bs-body-color); border-color: var(--mcp-theme-muted); }
.form-check-input:checked { background-color: var(--bs-primary); border-color: var(--bs-primary); }

a { color: ${darken(input.primary, 0.68)}; text-underline-offset: 0.18em; }
a:hover { color: ${darken(input.primary, 0.5)}; }

:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 3px solid ${input.focus};
  outline-offset: 2px;
  box-shadow: none !important;
}

.progress { height: 0.75rem; background-color: #E4E7EB; border-radius: 999px; }
.progress-bar { background-color: var(--bs-primary); }

.table-responsive { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.ls-answers th, .ls-answers td { vertical-align: middle; }
img { max-width: 100%; height: auto; }

@media (max-width: 575.98px) {
  #outerframeContainer { padding-inline: 0.75rem; }
  .survey-name { font-size: 1.75rem; }
  .group-title { font-size: 1.3rem; }
  .question-container { padding: 1rem; box-shadow: none; }
  .navigator .btn { width: 100%; margin-block: 0.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}

@media print {
  body { background: #FFFFFF; color: #000000; }
  #outerframeContainer { width: 100%; max-width: none; padding: 0; }
  .question-container { border: 1px solid #777777; box-shadow: none; break-inside: avoid; }
}
`;
}

async function validateZip(config: LimeSurveyConfig, fileName: string): Promise<JsonValue> {
  const { target } = safeThemeTarget(config, fileName);
  const maxAssetBytes = config.maxThemeAssetBytes ?? 5 * 1024 * 1024;
  const archive = await readFile(target);
  if (archive.byteLength > maxAssetBytes * 3 + 1024 * 1024) {
    throw new LimeSurveyError("The compressed theme package is larger than the configured validation limit.");
  }
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  const entries = Object.values(zip.files);
  const errors: string[] = [];
  const warnings: string[] = [];
  let totalUncompressedBytes = 0;
  if (entries.length > 50) errors.push("Theme packages may contain at most 50 entries.");
  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    if (original.startsWith("/") || original.includes("\\") || original.split("/").includes("..")) {
      errors.push(`Unsafe archive path: ${original}`);
    }
    if (!entry.dir && !/^(config\.xml|LICENSE\.txt|css\/[a-zA-Z0-9_.-]+\.css|files\/[a-zA-Z0-9_.-]+\.(png|jpe?g))$/.test(entry.name)) {
      errors.push(`Unsupported theme file: ${entry.name}`);
    }
    const internal = entry as unknown as { _data?: { uncompressedSize?: number } };
    const uncompressedSize = internal._data?.uncompressedSize ?? 0;
    totalUncompressedBytes += uncompressedSize;
    if (!entry.dir && uncompressedSize > maxAssetBytes) {
      errors.push(`Theme entry exceeds LIMESURVEY_MAX_THEME_ASSET_BYTES: ${entry.name}`);
    }
  }
  if (totalUncompressedBytes > maxAssetBytes * 3) errors.push("The uncompressed theme package exceeds the configured limit.");
  const configEntry = zip.file("config.xml");
  const cssEntry = zip.file("css/mcp-theme.css");
  const licenseEntry = zip.file("LICENSE.txt");
  if (!configEntry) errors.push("config.xml must be at the archive root.");
  if (!cssEntry) errors.push("css/mcp-theme.css is missing.");
  if (!licenseEntry) errors.push("LICENSE.txt is missing.");

  let metadata: Record<string, JsonValue> = {};
  if (configEntry) {
    const xml = await configEntry.async("string");
    try {
      const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml) as {
        config?: { metadata?: Record<string, unknown>; compatibility?: { version?: string | string[] } };
      };
      const raw = parsed.config?.metadata ?? {};
      const name = String(raw.name ?? "");
      const parent = String(raw.extends ?? "");
      const type = String(raw.type ?? "");
      const license = String(raw.license ?? "");
      const versionsRaw = parsed.config?.compatibility?.version;
      const versions = Array.isArray(versionsRaw) ? versionsRaw.map(String) : versionsRaw ? [String(versionsRaw)] : [];
      if (!themeNameSchema.safeParse(name).success) errors.push("Manifest metadata.name is invalid.");
      if (parent !== "vanilla") errors.push("Manifest must extend vanilla.");
      if (type !== "theme") errors.push("Manifest metadata.type must be theme.");
      if (!license.toLowerCase().includes("general public license")) errors.push("Manifest must declare the GPL-compatible license.");
      if (!versions.some((version) => version === "7" || version.startsWith("7."))
        && !versions.some((version) => version === "6" || version.startsWith("6."))) {
        errors.push("Manifest compatibility must target LimeSurvey 7.x or 6.x.");
      }
      metadata = { name, parent, type, license, compatibility: versions };
    } catch (value) {
      errors.push(`config.xml cannot be parsed: ${value instanceof Error ? value.message : String(value)}`);
    }
  }
  if (cssEntry) {
    const css = await cssEntry.async("string");
    if (css.length > 200_000) errors.push("Theme CSS exceeds 200,000 characters.");
    if (/@import\b|javascript\s*:|expression\s*\(|url\s*\(\s*['"]?(?:https?:|\/\/|data:)/i.test(css)) {
      errors.push("Theme CSS contains an external import, executable expression, or embedded/external URL.");
    }
    if (!css.includes("@media (max-width: 575.98px)")) errors.push("Responsive small-screen rules are missing.");
    if (!css.includes("prefers-reduced-motion")) warnings.push("Reduced-motion handling is missing.");
    if (!css.includes(":focus-visible")) warnings.push("Visible keyboard focus styling is missing.");
  }
  for (const entry of entries.filter((item) => !item.dir && /^files\/.*\.(png|jpe?g)$/.test(item.name))) {
    const extension = path.extname(entry.name).slice(1).toLowerCase() as "png" | "jpg" | "jpeg";
    const internal = entry as unknown as { _data?: { uncompressedSize?: number } };
    if ((internal._data?.uncompressedSize ?? 0) <= maxAssetBytes) {
      const image = await entry.async("nodebuffer");
      if (!imageMatchesType(image, extension)) errors.push(`Image content does not match its extension: ${entry.name}`);
    }
  }
  if (!entries.some((entry) => /^files\/logo\.(png|jpe?g)$/.test(entry.name))) {
    warnings.push("No logo is bundled. This is valid; the parent theme or a later Theme Options upload can provide one.");
  }
  return {
    valid: errors.length === 0,
    file_name: fileName,
    path: target,
    entries: entries.filter((entry) => !entry.dir).map((entry) => entry.name),
    metadata,
    errors,
    warnings,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Part A of limesurvey_list_installed_themes: local ZIPs/folders already generated in LIMESURVEY_THEME_DIR. */
async function listGeneratedThemePackages(themeDir: string | undefined): Promise<{ packages: JsonValue; note: JsonValue }> {
  if (!themeDir) {
    return { packages: [], note: "LIMESURVEY_THEME_DIR is not configured; no locally generated theme packages to list." };
  }
  let entries;
  try {
    entries = await readdir(themeDir, { withFileTypes: true });
  } catch (value) {
    return {
      packages: [],
      note: `LIMESURVEY_THEME_DIR (${themeDir}) could not be read: ${value instanceof Error ? value.message : String(value)}`,
    };
  }
  const packages = entries
    .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")))
    .map((entry) => ({ name: entry.name, path: path.join(themeDir, entry.name) }));
  return { packages, note: null };
}

/**
 * Part B of limesurvey_list_installed_themes: RemoteControl2 cannot enumerate installed themes, but
 * get_survey_properties(["template"]) works without a superadmin account, so this reports the distinct
 * templates actually assigned to visible surveys instead. Never throws; degrades to empty results with
 * scanError on failure, and skips (rather than fails on) individual surveys it cannot read.
 */
async function scanThemesInUse(client: LimeSurveyClient, scanLimit: number): Promise<{
  themesInUse: string[];
  inheritCount: number;
  scannedSurveys: number;
  totalSurveys: number;
  scanError: string | null;
}> {
  try {
    const surveysValue = await client.call("list_surveys", [null, null]);
    const surveys = Array.isArray(surveysValue) ? surveysValue : [];
    const totalSurveys = surveys.length;
    const scanned = surveys.slice(0, scanLimit);
    const templates = new Set<string>();
    let inheritCount = 0;
    for (const survey of scanned) {
      const object = objectValue(survey);
      const sidValue = object ? object.sid ?? object.survey_id : undefined;
      const sid = typeof sidValue === "number" ? sidValue : typeof sidValue === "string" ? Number(sidValue) : NaN;
      if (!Number.isFinite(sid)) continue;
      try {
        const properties = await client.call("get_survey_properties", [sid, ["template"]]);
        const propsObject = objectValue(properties);
        const template = propsObject && typeof propsObject.template === "string" ? propsObject.template : undefined;
        if (!template) continue;
        if (template === "inherit") inheritCount += 1;
        else templates.add(template);
      } catch {
        // One survey's properties failing to read must not fail the whole scan.
      }
    }
    return { themesInUse: [...templates], inheritCount, scannedSurveys: scanned.length, totalSurveys, scanError: null };
  } catch (value) {
    return {
      themesInUse: [],
      inheritCount: 0,
      scannedSurveys: 0,
      totalSurveys: 0,
      scanError: value instanceof Error ? value.message : String(value),
    };
  }
}

export function registerThemeTools(server: McpServer, client: LimeSurveyClient, config: LimeSurveyConfig): void {
  const generateSchema = z.object({
    theme_name: themeNameSchema,
    title: z.string().min(3).max(100).describe("Human-readable title shown in LimeSurvey."),
    description: z.string().min(3).max(500).default("Responsive survey theme generated with LimeSurvey MCP."),
    author: z.string().min(2).max(100).default("LimeSurvey MCP user"),
    author_email: z.string().email().optional(),
    author_url: z.string().url().optional(),
    theme_version: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
    target_limesurvey_major: z.enum(["7", "6"]).default("7"),
    primary_color: colorSchema.default("#0B6B57"),
    accent_color: colorSchema.default("#C84B31"),
    background_color: colorSchema.default("#F5F7F6"),
    surface_color: colorSchema.default("#FFFFFF"),
    text_color: colorSchema.default("#1F2933"),
    muted_text_color: colorSchema.default("#52606D"),
    focus_color: colorSchema.default("#005FCC"),
    font_style: z.enum(["system", "humanist", "serif"]).default("system"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    corner_radius_px: z.number().int().min(0).max(8).default(6),
    content_max_width_px: z.number().int().min(720).max(1440).default(960),
    logo_base64: z.string().optional().describe("Optional base64 PNG or JPEG logo without a data URL prefix."),
    logo_file_type: z.enum(["png", "jpeg"]).optional(),
    overwrite: z.boolean().default(false),
    confirm_overwrite: z.boolean().default(false),
  }).strict().superRefine((value, context) => {
    if ((value.logo_base64 && !value.logo_file_type) || (!value.logo_base64 && value.logo_file_type)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "logo_base64 and logo_file_type must be supplied together." });
    }
  });

  server.registerTool(
    "limesurvey_generate_survey_theme",
    {
      title: "Generate a responsive LimeSurvey survey theme",
      description: "Create a validated GPL-2.0-or-later ZIP theme that inherits the official Bootstrap 5 vanilla theme for LimeSurvey 7 or 6.",
      inputSchema: generateSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => run(config, "generate_survey_theme", true, async () => {
      if (contrast(input.text_color, input.background_color) < 4.5) {
        throw new LimeSurveyError("text_color and background_color must have a WCAG contrast ratio of at least 4.5:1.");
      }
      if (contrast(input.text_color, input.surface_color) < 4.5) {
        throw new LimeSurveyError("text_color and surface_color must have a WCAG contrast ratio of at least 4.5:1.");
      }
      if (contrast(input.muted_text_color, input.background_color) < 4.5
        || contrast(input.muted_text_color, input.surface_color) < 4.5) {
        throw new LimeSurveyError("muted_text_color must have a WCAG contrast ratio of at least 4.5:1 on both backgrounds.");
      }
      if (contrast(input.focus_color, input.background_color) < 3
        || contrast(input.focus_color, input.surface_color) < 3) {
        throw new LimeSurveyError("focus_color must have a contrast ratio of at least 3:1 on both backgrounds.");
      }
      if (input.overwrite && !input.confirm_overwrite) {
        throw new LimeSurveyError("confirm_overwrite=true is required when overwrite=true.");
      }
      const fileName = `${input.theme_name}-${input.theme_version}-ls${input.target_limesurvey_major}.zip`;
      const { root, target } = safeThemeTarget(config, fileName);
      const zip = new JSZip();
      zip.file("config.xml", manifest({
        themeName: input.theme_name,
        title: input.title,
        description: input.description,
        author: input.author,
        ...(input.author_email ? { authorEmail: input.author_email } : {}),
        ...(input.author_url ? { authorUrl: input.author_url } : {}),
        themeVersion: input.theme_version,
        targetMajor: input.target_limesurvey_major,
      }));
      zip.file("css/mcp-theme.css", themeCss({
        themeName: input.theme_name,
        primary: input.primary_color.toUpperCase(),
        accent: input.accent_color.toUpperCase(),
        background: input.background_color.toUpperCase(),
        surface: input.surface_color.toUpperCase(),
        text: input.text_color.toUpperCase(),
        muted: input.muted_text_color.toUpperCase(),
        focus: input.focus_color.toUpperCase(),
        font: input.font_style,
        radius: input.corner_radius_px,
        maxWidth: input.content_max_width_px,
        density: input.density,
      }));
      zip.file("LICENSE.txt", generatedThemeLicenseNotice);
      if (input.logo_base64 && input.logo_file_type) {
        const logo = decodeLogo(
          input.logo_base64,
          input.logo_file_type,
          config.maxThemeAssetBytes ?? 5 * 1024 * 1024,
        );
        const extension = input.logo_file_type === "jpeg" ? "jpg" : input.logo_file_type;
        zip.file(`files/logo.${extension}`, logo);
      }
      const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
      await mkdir(root, { recursive: true });
      try {
        await writeFile(target, archive, { flag: input.overwrite ? "w" : "wx", mode: 0o600 });
        await chmod(target, 0o600);
      } catch (value) {
        const code = value && typeof value === "object" && "code" in value ? String(value.code) : undefined;
        if (code === "EEXIST") {
          throw new LimeSurveyError("The theme package already exists. Increase theme_version or confirm an overwrite.");
        }
        throw value;
      }
      return {
        status: "generated",
        theme_name: input.theme_name,
        title: input.title,
        file_name: fileName,
        path: target,
        bytes: archive.byteLength,
        sha256: createHash("sha256").update(archive).digest("hex"),
        license: "GPL-2.0-or-later",
        parent_theme: "vanilla",
        compatibility: [`${input.target_limesurvey_major}.0`],
        tested_reference: "LimeSurvey CE 7.0.5 / vanilla 3.0.1 manifest checked 2026-07-24",
        contrast: {
          text_on_background: Number(contrast(input.text_color, input.background_color).toFixed(2)),
          text_on_surface: Number(contrast(input.text_color, input.surface_color).toFixed(2)),
          button_text_on_primary: Number(contrast(foreground(input.primary_color), input.primary_color).toFixed(2)),
        },
        next_tools: ["limesurvey_validate_survey_theme", "limesurvey_get_theme_publication_guide"],
      };
    }),
  );

  server.registerTool(
    "limesurvey_validate_survey_theme",
    {
      title: "Validate a generated LimeSurvey survey theme",
      description: "Validate a ZIP inside LIMESURVEY_THEME_DIR for manifest, licensing, archive paths, safe assets, responsive CSS, and LimeSurvey 6/7 compatibility.",
      inputSchema: z.object({ file_name: z.string().min(5) }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ file_name }) => run(config, "validate_survey_theme", false, () => validateZip(config, file_name)),
  );

  server.registerTool(
    "limesurvey_get_theme_publication_guide",
    {
      title: "Get LimeSurvey theme publication instructions",
      description: "Return version-aware installation, preview, assignment, accessibility, rollback, and optional community-publication steps for a survey theme.",
      inputSchema: z.object({
        theme_name: themeNameSchema,
        package_file_name: z.string().min(5).describe("Generated ZIP file name."),
        installed_limesurvey_version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).describe("Version shown in the LimeSurvey administration footer."),
        hosting: z.enum(["self_hosted", "limesurvey_cloud"]),
        publication_scope: z.enum(["instance", "community"]).default("instance"),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => run(config, "get_theme_publication_guide", false, async () => {
      const major = Number(input.installed_limesurvey_version.split(".")[0]);
      const packageMajor = /-ls([67])\.zip$/i.exec(input.package_file_name)?.[1];
      const compatibility = (major === 7 || major === 6) && (!packageMajor || packageMajor === String(major))
        ? "supported"
        : "unsupported";
      const steps: JsonValue[] = [
        "Run limesurvey_validate_survey_theme and continue only when valid=true.",
        `Confirm that the installed LimeSurvey version is ${input.installed_limesurvey_version} and that the generated package targets major version ${major}.`,
        "Sign in with a trusted account that has the global Templates import permission. Theme import can execute presentation code and must not be delegated broadly.",
        "Open Configuration > Advanced > Themes and select the Survey themes section.",
        `Choose Import, select ${input.package_file_name}, and review every imported file. config.xml must be at the ZIP root.`,
        `Confirm that the parent theme vanilla is installed. The imported theme should appear as ${input.theme_name} and extend vanilla.`,
        "Open the Theme Editor preview and check welcome, question, completion, token, error, print-answers, and public-statistics screens at phone, tablet, and desktop widths.",
        "Create or use an inactive test survey. Run limesurvey_assign_survey_theme for that survey, then preview every language before activation.",
        "Test keyboard-only navigation, visible focus, validation errors, 200% zoom, long labels, matrix questions, right-to-left languages where applicable, reduced motion, and print output.",
        "Publish to production only after acceptance. Keep the ZIP and previous theme name so rollback only requires assigning the previous theme again.",
      ];
      if (input.hosting === "limesurvey_cloud") {
        steps.splice(3, 0, "If the Themes import control is unavailable in LimeSurvey Cloud, verify that custom theme upload is included for the account or contact LimeSurvey support; do not attempt filesystem installation.");
      }
      if (input.publication_scope === "community") {
        steps.push(
          "For public distribution, keep GPL-2.0-or-later, remove all customer logos and confidential assets, document supported LimeSurvey majors, and test on a clean current LimeSurvey installation.",
          "Publish source and reproducible ZIP checksums, then use the Templates contribution/upload area linked from the official LimeSurvey Community downloads page. Include screenshots and installation/rollback instructions.",
        );
      }
      return {
        compatibility,
        installed_version: input.installed_limesurvey_version,
        current_reference: {
          checked_on: "2026-07-22",
          current_ce_release: "7.0.5",
          supported_generator_majors: ["7", "6"],
          parent_theme: "vanilla",
          documentation: [
            "https://www.limesurvey.org/manual/Themes/en",
            "https://www.limesurvey.org/manual/Extension_compatibility",
            "https://community.limesurvey.org/downloads/",
          ],
        },
        steps,
        stop_conditions: [
          "Validation reports errors.",
          "The installed major version does not match the package compatibility entry.",
          "vanilla is unavailable.",
          "The preview has inaccessible contrast, hidden focus, clipped content, or broken question layouts.",
        ],
        ...(packageMajor ? { package_major: packageMajor } : {}),
      };
    }),
  );

  server.registerTool(
    "limesurvey_assign_survey_theme",
    {
      title: "Assign an installed theme to a survey",
      description: "Assign an already imported LimeSurvey survey theme through set_survey_properties. This does not upload or install the theme package.",
      inputSchema: z.object({
        survey_id: z.number().int().positive(),
        theme_name: themeNameSchema,
        confirm_theme_assignment: z.literal(true).describe("Required acknowledgement that the survey appearance will change."),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ survey_id, theme_name }) => run(config, "assign_survey_theme", true, async () => {
      const rpcResult = await client.call("set_survey_properties", [survey_id, { template: theme_name }]);
      return {
        survey_id,
        theme_name,
        rpc_result: rpcResult,
        verification: "Preview the survey in LimeSurvey and call limesurvey_get_survey_properties for the template property.",
        rollback: "Assign the previous installed theme name with this same tool.",
      };
    }),
  );

  server.registerTool(
    "limesurvey_list_installed_themes",
    {
      title: "List installed LimeSurvey themes (best effort)",
      description: "LimeSurvey RemoteControl2 has no official method to enumerate installed survey themes "
        + "(verified 2026-07-24 against api.limesurvey.org and the LimeSurvey source). This tool combines two "
        + "best-effort signals instead: generated_packages lists ZIPs/folders already generated locally in "
        + "LIMESURVEY_THEME_DIR, and themes_in_use lists the distinct template names actually assigned to surveys "
        + "visible to this account (via list_surveys + get_survey_properties), which works without a superadmin "
        + "account. Always includes the documented admin-UI fallback for the complete installed-theme list.",
      inputSchema: z.object({
        survey_scan_limit: z.number().int().min(1).max(100).default(25)
          .describe("Maximum number of visible surveys to inspect for their assigned theme."),
      }).strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ survey_scan_limit }) => run(config, "list_installed_themes", false, async () => {
      const local = await listGeneratedThemePackages(config.themeDir);
      const remote = await scanThemesInUse(client, survey_scan_limit);
      return {
        generated_packages: local.packages,
        generated_packages_note: local.note,
        themes_in_use: remote.themesInUse,
        inherit_count: remote.inheritCount,
        scanned_surveys: remote.scannedSurveys,
        total_surveys: remote.totalSurveys,
        ...(remote.scanError ? { themes_in_use_error: remote.scanError } : {}),
        limitations: "The LimeSurvey RemoteControl API cannot enumerate installed themes; themes_in_use only "
          + "covers templates referenced by surveys visible to this account.",
        admin_fallback: "Admin UI: Configuration > Themes; or read the name from the survey admin URL segment "
          + "templatename/<name>.",
      };
    }),
  );
}
