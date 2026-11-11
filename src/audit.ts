import type { Principal } from "./principal.js";

export type AuditDecision = "allow" | "deny";

export interface AuditEvent {
  tool: string;
  decision: AuditDecision;
  reason?: string;
  principal: Principal;
  requestId?: string;
  outcome?: "ok" | "error";
}

export type AuditSink = (event: AuditEvent) => void;

/**
 * One structured log record per tool decision. Log the object, not a JSON
 * string: with the Lambda JSON log format, an object becomes nested fields
 * (message.tool, message.decision, ...) that Logs Insights can filter on,
 * while a string stays one opaque field.
 */
export const consoleAudit: AuditSink = (e) => {
  console.log(
    {
      type: "mcp.audit",
      tool: e.tool,
      decision: e.decision,
      reason: e.reason,
      outcome: e.outcome,
      clientId: e.principal.clientId,
      sub: e.principal.subject,
      scopes: [...e.principal.scopes].sort(),
      requestId: e.requestId,
    },
  );
};
