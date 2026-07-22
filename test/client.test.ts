import assert from "node:assert/strict";
import test from "node:test";
import { LimeSurveyClient } from "../src/client.js";
import type { JsonRpcRequest, LimeSurveyConfig } from "../src/types.js";

const config: LimeSurveyConfig = {
  url: new URL("https://survey.example.test/index.php/admin/remotecontrol"),
  username: "rpc-user",
  password: "secret",
  authPlugin: "Authdb",
  timeoutMs: 1_000,
  maxResponseChars: 50_000,
};

function jsonResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ id, result, error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("uses JSON-RPC 1.0 positional parameters and caches the session", async () => {
  const requests: JsonRpcRequest[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    requests.push(request);
    if (request.method === "get_session_key") return jsonResponse(request.id, "session-1");
    return jsonResponse(request.id, [{ sid: "123", active: "Y" }]);
  };
  const client = new LimeSurveyClient(config, mockFetch);

  await client.call("list_surveys", [null, null]);
  await client.call("get_summary", [123, "all"]);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    id: 1,
    method: "get_session_key",
    params: ["rpc-user", "secret", "Authdb"],
  });
  assert.deepEqual(requests[1]?.params, ["session-1", null, null]);
  assert.deepEqual(requests[2]?.params, ["session-1", 123, "all"]);
  assert.equal("jsonrpc" in (requests[0] ?? {}), false);
});

test("renews an invalid session once and retries the method", async () => {
  let sessionNumber = 0;
  const methods: string[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    methods.push(request.method);
    if (request.method === "get_session_key") {
      sessionNumber += 1;
      return jsonResponse(request.id, `session-${sessionNumber}`);
    }
    if (request.params[0] === "session-1") {
      return jsonResponse(request.id, { status: "Invalid session key", error_code: "ERR_INVALID_SESSION" });
    }
    return jsonResponse(request.id, { completed_responses: 7 });
  };
  const client = new LimeSurveyClient(config, mockFetch);

  const result = await client.call("get_summary", [123, "all"]);

  assert.deepEqual(result, { completed_responses: 7 });
  assert.deepEqual(methods, ["get_session_key", "get_summary", "get_session_key", "get_summary"]);
});

test("returns a sanitized connection status instead of the session key", async () => {
  const mockFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    return jsonResponse(request.id, "highly-sensitive-session-key");
  };
  const client = new LimeSurveyClient(config, mockFetch);
  assert.deepEqual(await client.call("get_session_key"), { status: "connected", auth_plugin: "Authdb" });
});
