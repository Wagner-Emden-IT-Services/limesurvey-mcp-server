import {
  LimeSurveyError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonValue,
  type LimeSurveyConfig,
} from "./types.js";

export type FetchImplementation = typeof fetch;

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusMessage(value: JsonValue | undefined): string | undefined {
  if (!isObject(value)) return undefined;
  const status = value.status;
  return typeof status === "string" ? status : undefined;
}

function errorCode(value: JsonValue | undefined): string | undefined {
  if (!isObject(value)) return undefined;
  const code = value.error_code;
  return typeof code === "string" ? code : undefined;
}

export class LimeSurveyClient {
  private requestId = 0;
  private sessionKey: string | undefined;
  private sessionPromise: Promise<string> | undefined;

  constructor(
    private readonly config: LimeSurveyConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {}

  async openSession(): Promise<{ status: "connected"; auth_plugin: string }> {
    await this.getSessionKey();
    return { status: "connected", auth_plugin: this.config.authPlugin };
  }

  async releaseSession(): Promise<JsonValue> {
    if (!this.sessionKey) return { status: "not_connected" };
    const key = this.sessionKey;
    this.sessionKey = undefined;
    this.sessionPromise = undefined;
    return this.rpc("release_session_key", [key]);
  }

  async call(method: string, params: JsonValue[] = []): Promise<JsonValue> {
    if (method === "get_session_key") return this.openSession();
    if (method === "release_session_key") return this.releaseSession();

    let key = await this.getSessionKey();
    let result = await this.rpc(method, [key, ...params]);
    if (errorCode(result) === "ERR_INVALID_SESSION" || statusMessage(result) === "Invalid session key") {
      this.sessionKey = undefined;
      this.sessionPromise = undefined;
      key = await this.getSessionKey();
      result = await this.rpc(method, [key, ...params]);
    }
    this.throwForApiError(method, result);
    return result;
  }

  private async getSessionKey(): Promise<string> {
    if (this.sessionKey) return this.sessionKey;
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().finally(() => {
        this.sessionPromise = undefined;
      });
    }
    return this.sessionPromise;
  }

  private async createSession(): Promise<string> {
    const result = await this.rpc("get_session_key", [
      this.config.username,
      this.config.password,
      this.config.authPlugin,
    ]);
    this.throwForApiError("get_session_key", result);
    if (typeof result !== "string" || result.length === 0) {
      throw new LimeSurveyError(
        "LimeSurvey did not return a session key. Verify the URL, credentials, auth plugin, and that JSON-RPC is enabled.",
      );
    }
    this.sessionKey = result;
    return result;
  }

  private async rpc(method: string, params: JsonValue[]): Promise<JsonValue> {
    const request: JsonRpcRequest = { method, params, id: ++this.requestId };
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new LimeSurveyError(`Could not reach LimeSurvey for ${method}: ${reason}`);
    }

    if (!response.ok) {
      throw new LimeSurveyError(
        `LimeSurvey HTTP request for ${method} failed with ${response.status} ${response.statusText}.`,
      );
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await response.json()) as JsonRpcResponse;
    } catch {
      throw new LimeSurveyError(
        `LimeSurvey returned a non-JSON response for ${method}. Confirm that the RemoteControl endpoint and JSON-RPC interface are enabled.`,
      );
    }

    if (payload.id !== request.id) {
      throw new LimeSurveyError(`LimeSurvey returned an unexpected JSON-RPC response id for ${method}.`);
    }
    if (payload.error !== undefined && payload.error !== null) {
      throw new LimeSurveyError(`LimeSurvey JSON-RPC error while calling ${method}.`, undefined, payload.error);
    }
    if (payload.result === undefined) {
      throw new LimeSurveyError(`LimeSurvey returned no result for ${method}.`);
    }
    return payload.result;
  }

  private throwForApiError(method: string, result: JsonValue): void {
    const code = errorCode(result);
    if (!code) return;
    const message = statusMessage(result) ?? "Unknown LimeSurvey error";
    throw new LimeSurveyError(`${method} failed: ${message}`, code, result);
  }
}
