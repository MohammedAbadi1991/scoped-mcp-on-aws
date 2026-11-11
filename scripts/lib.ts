import { readFileSync } from "node:fs";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export type Caller = "reader" | "editor" | "admin";

interface Outputs {
  McpUrl: string;
  TokenUrl: string;
  UserPoolId: string;
  FunctionLogGroup: string;
  readerClientId: string;
  editorClientId: string;
  adminClientId: string;
}

/** Stack outputs written by `npm run deploy` (cdk deploy --outputs-file). */
export function outputs(): Outputs {
  const all = JSON.parse(readFileSync("cdk-outputs.json", "utf8"));
  return all.ScopedMcpStack as Outputs;
}

/**
 * Gets an access token with the OAuth client credentials grant. The client
 * secret is read from Cognito at run time, so it never sits in a file.
 */
export async function getAccessToken(caller: Caller): Promise<string> {
  const out = outputs();
  const clientId = out[`${caller}ClientId`];
  const cognito = new CognitoIdentityProviderClient({});
  const { UserPoolClient } = await cognito.send(
    new DescribeUserPoolClientCommand({ UserPoolId: out.UserPoolId, ClientId: clientId }),
  );
  const secret = UserPoolClient?.ClientSecret;
  if (!secret) throw new Error(`no secret for ${caller} client`);

  const res = await fetch(out.TokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
    },
    // No scope parameter: Cognito issues every scope this client is allowed.
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/** Decodes a JWT payload for display. Does not verify anything. */
export function peek(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}
