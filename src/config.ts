import { LimeSurveyError, type LimeSurveyConfig } from "./types.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new LimeSurveyError(`Missing required environment variable ${name}.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LimeSurveyError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new LimeSurveyError(`${name} must be true or false.`);
}

function commaSeparated(value: string | undefined): string[] | undefined {
  const values = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return values && values.length > 0 ? values : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LimeSurveyConfig {
  const rawUrl = required(env, "LIMESURVEY_URL");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LimeSurveyError("LIMESURVEY_URL must be a valid absolute URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LimeSurveyError("LIMESURVEY_URL must use HTTP or HTTPS.");
  }
  const allowInsecure = env.LIMESURVEY_ALLOW_INSECURE_HTTP?.toLowerCase() === "true";
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
  if (url.protocol === "http:" && !allowInsecure && !localHostnames.has(url.hostname)) {
    throw new LimeSurveyError(
      "Plain HTTP is disabled. Use HTTPS or set LIMESURVEY_ALLOW_INSECURE_HTTP=true for a trusted development instance.",
    );
  }

  const transport = (env.MCP_TRANSPORT?.trim().toLowerCase() || "stdio") as "stdio" | "http";
  if (transport !== "stdio" && transport !== "http") {
    throw new LimeSurveyError("MCP_TRANSPORT must be stdio or http.");
  }
  const httpHost = env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const bearerToken = env.MCP_HTTP_BEARER_TOKEN?.trim();
  if (transport === "http" && !localHostnames.has(httpHost) && !bearerToken) {
    throw new LimeSurveyError(
      "MCP_HTTP_BEARER_TOKEN is required when MCP_HTTP_HOST is not a loopback address.",
    );
  }

  url.hash = "";
  const config: LimeSurveyConfig = {
    url,
    username: required(env, "LIMESURVEY_USERNAME"),
    password: required(env, "LIMESURVEY_PASSWORD"),
    authPlugin: env.LIMESURVEY_AUTH_PLUGIN?.trim() || "Authdb",
    timeoutMs: positiveInteger(env.LIMESURVEY_TIMEOUT_MS, 30_000, "LIMESURVEY_TIMEOUT_MS"),
    maxResponseChars: positiveInteger(
      env.LIMESURVEY_MAX_RESPONSE_CHARS,
      50_000,
      "LIMESURVEY_MAX_RESPONSE_CHARS",
    ),
    readOnly: booleanValue(env.LIMESURVEY_READ_ONLY ?? env.READONLY_MODE, false, "LIMESURVEY_READ_ONLY"),
    enableExperimentalMethods: booleanValue(
      env.LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS,
      false,
      "LIMESURVEY_ENABLE_EXPERIMENTAL_METHODS",
    ),
    maxExportBytes: positiveInteger(
      env.LIMESURVEY_MAX_EXPORT_BYTES,
      100 * 1024 * 1024,
      "LIMESURVEY_MAX_EXPORT_BYTES",
    ),
    maxThemeAssetBytes: positiveInteger(
      env.LIMESURVEY_MAX_THEME_ASSET_BYTES,
      5 * 1024 * 1024,
      "LIMESURVEY_MAX_THEME_ASSET_BYTES",
    ),
    transport,
    httpHost,
    httpPort: positiveInteger(env.MCP_HTTP_PORT, 3000, "MCP_HTTP_PORT"),
    httpPath: env.MCP_HTTP_PATH?.trim() || "/mcp",
  };
  const exportDir = env.LIMESURVEY_EXPORT_DIR?.trim();
  if (exportDir) config.exportDir = exportDir;
  const themeDir = env.LIMESURVEY_THEME_DIR?.trim();
  if (themeDir) config.themeDir = themeDir;
  if (bearerToken) config.httpBearerToken = bearerToken;
  const allowedHosts = commaSeparated(env.MCP_HTTP_ALLOWED_HOSTS);
  if (allowedHosts) config.httpAllowedHosts = allowedHosts;
  const allowedOrigins = commaSeparated(env.MCP_HTTP_ALLOWED_ORIGINS);
  if (allowedOrigins) config.httpAllowedOrigins = allowedOrigins;
  return config;
}
