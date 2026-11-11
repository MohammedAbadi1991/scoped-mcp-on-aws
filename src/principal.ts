import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

/** Who is calling, as established by the API Gateway JWT authorizer. */
export interface Principal {
  /** Cognito `sub`. For client-credentials tokens this equals the client ID. */
  subject: string;
  clientId: string;
  scopes: ReadonlySet<string>;
  /** Seconds since epoch. */
  expiresAt?: number;
}

export class UnauthorizedError extends Error {}

/**
 * Reads the caller from the claims API Gateway already verified.
 *
 * API Gateway has checked the signature, issuer, expiry and client ID before
 * Lambda runs. This function does not re-verify the JWT; it refuses to guess
 * when the authorizer context is missing or is not what we expect. That only
 * happens when the route is misconfigured, and then we want a 401, not an
 * anonymous caller.
 */
export function principalFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): Principal {
  const jwt = event.requestContext?.authorizer?.jwt;
  if (!jwt?.claims) {
    throw new UnauthorizedError("missing authorizer context");
  }
  const claims = jwt.claims;

  // A Cognito ID token has aud = client ID, so it can pass a JWT authorizer
  // that lists client IDs as audiences. Only access tokens carry scopes and
  // are meant for APIs, so reject everything else explicitly.
  if (claims.token_use !== "access") {
    throw new UnauthorizedError("not an access token");
  }

  const clientId = typeof claims.client_id === "string" ? claims.client_id : "";
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!clientId || !subject) {
    throw new UnauthorizedError("token is missing sub or client_id");
  }

  // API Gateway exposes scopes as an array when it can parse them. Fall back
  // to the raw space-delimited `scope` claim so we never depend on one shape.
  const fromAuthorizer = Array.isArray(jwt.scopes) ? jwt.scopes : [];
  const fromClaim = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  const scopes = new Set([...fromAuthorizer, ...fromClaim].filter(Boolean));

  const exp = Number(claims.exp);
  return {
    subject,
    clientId,
    scopes,
    expiresAt: Number.isFinite(exp) ? exp : undefined,
  };
}
