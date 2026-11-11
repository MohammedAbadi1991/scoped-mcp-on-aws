import { App, Validations } from "aws-cdk-lib";
import nag from "cdk-nag"; // CommonJS (jsii) package: use the default import under ESM
import { ScopedMcpStack } from "./stack.js";

const app = new App();
new ScopedMcpStack(app, "ScopedMcpStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: "Remote MCP server with per-tool OAuth scopes (Cognito + API Gateway + Lambda)",
});

// Fail synth on any AWS Solutions finding that isn't fixed or explicitly
// acknowledged with a reason.
Validations.of(app).addPlugins(new nag.AwsSolutionsChecks(app, { verbose: true }));
