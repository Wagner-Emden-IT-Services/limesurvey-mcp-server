import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NextFunction, Request, Response } from "express";
import type { FetchImplementation, LimeSurveyClient } from "./client.js";
import { createServer } from "./server.js";
import { LimeSurveyError, type LimeSurveyConfig } from "./types.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>["server"];
  client: LimeSurveyClient;
}

export interface RunningHttpServer {
  server: HttpServer;
  url: string;
  close: () => Promise<void>;
}

function tokensMatch(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function jsonRpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

export async function startHttpServer(
  config: LimeSurveyConfig,
  fetchImpl?: FetchImplementation,
): Promise<RunningHttpServer> {
  const host = config.httpHost ?? "127.0.0.1";
  const port = config.httpPort ?? 3000;
  const mcpPath = config.httpPath ?? "/mcp";
  if (!mcpPath.startsWith("/")) throw new LimeSurveyError("MCP_HTTP_PATH must start with /.");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !config.httpBearerToken) {
    throw new LimeSurveyError("A bearer token is required for a non-loopback HTTP binding.");
  }

  const app = createMcpExpressApp({
    host,
    ...(config.httpAllowedHosts ? { allowedHosts: config.httpAllowedHosts } : {}),
  });
  const sessions = new Map<string, Session>();
  const closing = new Set<string>();

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", transport: "streamable-http", sessions: sessions.size });
  });

  app.use(mcpPath, (request: Request, response: Response, next: NextFunction) => {
    const origin = request.header("origin");
    if (origin && !(config.httpAllowedOrigins ?? []).includes(origin)) {
      jsonRpcError(response, 403, "Forbidden origin. Configure MCP_HTTP_ALLOWED_ORIGINS if browser access is required.");
      return;
    }
    if (config.httpBearerToken) {
      const authorization = request.header("authorization") ?? "";
      const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!tokensMatch(config.httpBearerToken, supplied)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        jsonRpcError(response, 401, "Missing or invalid bearer token.");
        return;
      }
    }
    next();
  });

  const cleanup = async (sessionId: string, closeTransport: boolean): Promise<void> => {
    if (closing.has(sessionId)) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    closing.add(sessionId);
    sessions.delete(sessionId);
    try {
      await session.client.releaseSession();
    } catch (value) {
      console.error("Failed to release LimeSurvey HTTP session:", value);
    }
    if (closeTransport) await session.transport.close();
    await session.server.close();
    closing.delete(sessionId);
  };

  app.post(mcpPath, async (request, response) => {
    try {
      const header = request.header("mcp-session-id");
      if (header) {
        const session = sessions.get(header);
        if (!session) {
          jsonRpcError(response, 404, "Unknown or expired MCP session ID.");
          return;
        }
        await session.transport.handleRequest(request, response, request.body);
        return;
      }
      if (!isInitializeRequest(request.body)) {
        jsonRpcError(response, 400, "An initialize request is required when no MCP session ID is provided.");
        return;
      }

      let session: Session;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, session);
        },
      });
      const created = createServer(config, fetchImpl);
      session = { transport, ...created };
      transport.onclose = () => {
        const sessionId = transport.sessionId;
        if (sessionId) void cleanup(sessionId, false);
      };
      // SDK 1.x transport declarations conflict with exactOptionalPropertyTypes despite runtime compatibility.
      await created.server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch (value) {
      console.error("Failed to handle MCP HTTP request:", value);
      if (!response.headersSent) jsonRpcError(response, 500, "Internal MCP server error.");
    }
  });

  const existingSession = (request: Request, response: Response): Session | undefined => {
    const sessionId = request.header("mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) jsonRpcError(response, 404, "Unknown or missing MCP session ID.");
    return session;
  };

  app.get(mcpPath, async (request, response) => {
    const session = existingSession(request, response);
    if (session) await session.transport.handleRequest(request, response);
  });

  app.delete(mcpPath, async (request, response) => {
    const session = existingSession(request, response);
    if (session) await session.transport.handleRequest(request, response);
  });

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const displayHost = host.includes(":") ? `[${host}]` : host;

  return {
    server,
    url: `http://${displayHost}:${actualPort}${mcpPath}`,
    close: async () => {
      await Promise.all([...sessions.keys()].map((sessionId) => cleanup(sessionId, true)));
      await new Promise<void>((resolve, reject) => server.close((value) => value ? reject(value) : resolve()));
    },
  };
}
