import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

export const CLIENTS = {
  reader: { clientId: "reader-client", scopes: ["notes/read"] },
  editor: { clientId: "editor-client", scopes: ["notes/read", "notes/write"] },
  admin: { clientId: "admin-client", scopes: ["notes/read", "notes/write", "notes/delete"] },
  none: { clientId: "no-scope-client", scopes: [] as string[] },
} as const;

export type ClientName = keyof typeof CLIENTS;

let counter = 0;

/**
 * Builds the event API Gateway (HTTP API, payload v2) sends to Lambda after
 * its JWT authorizer accepted a Cognito access token.
 */
export function apiEvent(opts: {
  client?: ClientName;
  body?: unknown;
  method?: string;
  tokenUse?: string;
  noAuthorizer?: boolean;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const { clientId, scopes } = CLIENTS[opts.client ?? "reader"];
  const method = opts.method ?? "POST";
  const requestId = `req-${++counter}`;
  const event = {
    version: "2.0",
    routeKey: `${method} /mcp`,
    rawPath: "/mcp",
    rawQueryString: "",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      host: "abc123.execute-api.us-east-1.amazonaws.com",
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "abc123",
      domainName: "abc123.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "abc123",
      http: { method, path: "/mcp", protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "test" },
      requestId,
      routeKey: `${method} /mcp`,
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      authorizer: {
        principalId: "",
        integrationLatency: 0,
        jwt: {
          claims: {
            sub: clientId,
            client_id: clientId,
            token_use: opts.tokenUse ?? "access",
            scope: scopes.join(" "),
            iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
            exp: Math.floor(Date.now() / 1000) + 900,
          },
          scopes: [...scopes],
        },
      },
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  };
  if (opts.noAuthorizer) {
    delete (event.requestContext as { authorizer?: unknown }).authorizer;
  }
  return event as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

export function rpc(method: string, params?: unknown, id: number | null = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}
