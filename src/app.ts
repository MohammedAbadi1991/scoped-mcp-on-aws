import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { consoleAudit, type AuditSink } from "./audit.js";
import { allowedTools, canUseTool, isKnownTool } from "./policy.js";
import { principalFromEvent, UnauthorizedError, type Principal } from "./principal.js";
import { buildServer } from "./server.js";
import type { NotesStore } from "./store.js";

export interface AppDeps {
  store: NotesStore;
  audit?: AuditSink;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Lambda handler for a stateless MCP server behind an API Gateway HTTP API.
 *
 * Every request gets its own McpServer + transport, built for the caller's
 * scopes. Stateless means no session affinity is needed, which is what you
 * want when any Lambda instance can receive any request.
 */
export function createHandler(getDeps: () => AppDeps) {
  let deps: AppDeps | undefined;

  return async function handler(
    event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    deps ??= getDeps();
    const audit = deps.audit ?? consoleAudit;
    const requestId = event.requestContext.requestId;

    // Stateless server: no standalone SSE stream (GET) and no sessions to
    // terminate (DELETE). The spec says to answer 405 here.
    if (event.requestContext.http.method !== "POST") {
      return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
    }

    let principal: Principal;
    try {
      principal = principalFromEvent(event);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        console.warn({ type: "mcp.unauthorized", reason: err.message, requestId });
        return jsonRpcError(401, -32001, "Unauthorized.", { "WWW-Authenticate": "Bearer" });
      }
      throw err;
    }

    // An McpServer with zero tools does not advertise the tools capability, so
    // tools/list would fail with "Method not found". Say what is wrong instead.
    // (API Gateway's route scopes should stop these tokens before Lambda runs.)
    if (allowedTools(principal.scopes).length === 0) {
      return jsonRpcError(403, -32001, "Token has no scopes for this server.", {
        "WWW-Authenticate": 'Bearer error="insufficient_scope"',
      });
    }

    const raw = readBody(event);
    if (raw.length > MAX_BODY_BYTES) {
      return jsonRpcError(413, -32600, "Request body too large.");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return jsonRpcError(400, -32700, "Parse error.");
    }

    // Calls to tools outside the caller's scopes never reach a handler (the
    // tool is not registered), so record the denial here.
    for (const tool of requestedTools(body)) {
      if (!isKnownTool(tool) || !canUseTool(principal.scopes, tool)) {
        audit({ tool, decision: "deny", reason: isKnownTool(tool) ? "missing scope" : "unknown tool", principal, requestId });
      }
    }

    const server = buildServer(principal, { store: deps.store, audit, requestId });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(toWebRequest(event, raw), {
        parsedBody: body,
        authInfo: toAuthInfo(principal),
      });
      return await toLambdaResult(response);
    } finally {
      await server.close();
    }
  };
}

function readBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

/** Names of tools targeted by tools/call messages in a body (single or batch). */
function requestedTools(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((m) => {
    if (m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call") {
      const name = (m as { params?: { name?: unknown } }).params?.name;
      return typeof name === "string" ? [name] : ["<missing>"];
    }
    return [];
  });
}

function toWebRequest(event: APIGatewayProxyEventV2WithJWTAuthorizer, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  return new Request(url, { method: event.requestContext.http.method, headers, body: new Uint8Array(body) });
}

async function toLambdaResult(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { statusCode: response.status, headers, body: await response.text() };
}

function toAuthInfo(p: Principal): AuthInfo {
  return {
    // API Gateway has already validated the token; tool code never needs it,
    // so keep it out of memory that tool handlers can reach.
    token: "[validated-by-api-gateway]",
    clientId: p.clientId,
    scopes: [...p.scopes],
    expiresAt: p.expiresAt,
    extra: { sub: p.subject },
  };
}

function jsonRpcError(
  statusCode: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  };
}
