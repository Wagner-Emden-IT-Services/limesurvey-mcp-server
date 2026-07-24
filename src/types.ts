export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  id: number;
  method: string;
  params: JsonValue[];
}

export interface JsonRpcResponse {
  id: number | string | null;
  result?: JsonValue;
  error?: JsonValue;
}

export interface LimeSurveyConfig {
  url: URL;
  username: string;
  password: string;
  authPlugin: string;
  timeoutMs: number;
  maxResponseChars: number;
  readOnly?: boolean;
  enableExperimentalMethods?: boolean;
  exportDir?: string;
  maxExportBytes?: number;
  importDir?: string;
  maxImportBytes?: number;
  themeDir?: string;
  maxThemeAssetBytes?: number;
  transport?: "stdio" | "http";
  httpHost?: string;
  httpPort?: number;
  httpPath?: string;
  httpBearerToken?: string;
  httpAllowedHosts?: string[];
  httpAllowedOrigins?: string[];
}

export interface LimeSurveyToolResult {
  [key: string]: unknown;
  method: string;
  result: JsonValue;
  truncated?: boolean;
  truncation_message?: string;
}

export class LimeSurveyError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "LimeSurveyError";
  }
}
