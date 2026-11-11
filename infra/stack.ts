import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, Validations, type StackProps } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import { HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { SCOPES } from "../src/policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The demo callers and the scopes each one is allowed to request. */
const CALLERS = {
  reader: ["read"],
  editor: ["read", "write"],
  admin: ["read", "write", "delete"],
} as const;

export class ScopedMcpStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Data ----------
    const table = new dynamodb.TableV2(this, "Notes", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, // demo stack: delete data on `cdk destroy`
    });

    // ---------- Identity: who can get which scopes ----------
    const userPool = new cognito.UserPool(this, "Pool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // No human users sign in to this pool; these settings keep it safe if
      // someone adds them later.
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const scopeDefs = {
      read: new cognito.ResourceServerScope({ scopeName: "read", scopeDescription: "Read notes" }),
      write: new cognito.ResourceServerScope({ scopeName: "write", scopeDescription: "Create notes" }),
      delete: new cognito.ResourceServerScope({ scopeName: "delete", scopeDescription: "Delete notes" }),
    };
    const resourceServer = userPool.addResourceServer("NotesResourceServer", {
      identifier: "notes",
      scopes: Object.values(scopeDefs),
    });

    // The token endpoint lives on a Cognito domain. The prefix must be
    // globally unique, so it includes the account ID.
    const domainPrefix = this.node.tryGetContext("domainPrefix") ?? `notes-mcp-${this.account}`;
    const domain = userPool.addDomain("Domain", { cognitoDomain: { domainPrefix } });

    // One confidential app client per caller, each limited to its scopes.
    // These use the OAuth client credentials grant (machine to machine).
    const clients = Object.entries(CALLERS).map(([name, scopes]) => {
      const client = userPool.addClient(`${name}-client`, {
        userPoolClientName: `notes-mcp-${name}`,
        generateSecret: true,
        authFlows: {},
        oAuth: {
          flows: { clientCredentials: true },
          scopes: scopes.map((s) => cognito.OAuthScope.resourceServer(resourceServer, scopeDefs[s])),
        },
        accessTokenValidity: Duration.minutes(15),
        enableTokenRevocation: true,
      });
      new CfnOutput(this, `${name}ClientId`, { value: client.userPoolClientId });
      return client;
    });

    // ---------- Compute ----------
    const fnLogs = new logs.LogGroup(this, "McpFunctionLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // A role with no AWS managed policies: it can write to its own log group
    // and (below) use four DynamoDB actions on one table. Nothing else.
    const role = new iam.Role(this, "McpFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    fnLogs.grantWrite(role);

    const fn = new NodejsFunction(this, "McpFunction", {
      role,
      entry: path.join(here, "../src/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
      loggingFormat: LoggingFormat.JSON,
      logGroup: fnLogs,
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourceMap: true,
        mainFields: ["module", "main"],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    // Exactly the four DynamoDB actions the tools use, on this table only.
    // Scopes decide what a caller may ask for; IAM decides what the code can
    // ever do, even if a bug skips the scope check.
    table.grant(fn, "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem");

    // ---------- Edge: API Gateway HTTP API with a JWT authorizer ----------
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    const authorizer = new HttpJwtAuthorizer("CognitoJwt", issuer, {
      // For Cognito access tokens, API Gateway checks the client_id claim
      // against this list (access tokens have no aud claim).
      jwtAudience: clients.map((c) => c.userPoolClientId),
    });

    const api = new HttpApi(this, "Api", {
      apiName: "notes-mcp",
      createDefaultStage: false,
    });

    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      // A leaked token can't run up the bill faster than this.
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            ip: "$context.identity.sourceIp",
            route: "$context.routeKey",
            status: "$context.status",
            clientId: "$context.authorizer.claims.client_id",
            authError: "$context.authorizer.error",
            latencyMs: "$context.responseLatency",
          }),
        ),
      },
    });

    // Coarse gate: the token must carry at least one of our scopes. API
    // Gateway can't see which tool is being called (it's inside the JSON-RPC
    // body), so the per-tool decision happens in Lambda.
    api.addRoutes({
      path: "/mcp",
      methods: [HttpMethod.POST, HttpMethod.GET, HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("McpIntegration", fn),
      authorizer,
      authorizationScopes: Object.values(SCOPES),
    });

    // ---------- Outputs ----------
    new CfnOutput(this, "McpUrl", { value: `${api.apiEndpoint}/mcp` });
    new CfnOutput(this, "TokenUrl", { value: `${domain.baseUrl()}/oauth2/token` });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "FunctionLogGroup", { value: fnLogs.logGroupName });

    // ---------- cdk-nag: findings we accept, with the reason ----------
    Validations.of(userPool).acknowledge({
      id: "AwsSolutions::AwsSolutions-COG8",
      reason:
        "Plus-tier threat protection targets end-user sign-in. This pool has no users; it only issues client-credentials tokens to machine callers.",
    });
  }
}
