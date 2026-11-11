/**
 * The single source of truth for "who may use which tool".
 *
 * Every tool the server can expose must appear here with the OAuth scope that
 * unlocks it. A tool with no entry can never be registered, so forgetting to
 * add a policy fails closed (the tool is invisible) instead of failing open.
 */
export const SCOPES = {
  read: "notes/read",
  write: "notes/write",
  delete: "notes/delete",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const TOOL_POLICY = {
  list_notes: SCOPES.read,
  get_note: SCOPES.read,
  create_note: SCOPES.write,
  delete_note: SCOPES.delete,
} as const satisfies Record<string, Scope>;

export type ToolName = keyof typeof TOOL_POLICY;

export function isKnownTool(name: string): name is ToolName {
  return Object.hasOwn(TOOL_POLICY, name);
}

export function canUseTool(scopes: ReadonlySet<string>, tool: ToolName): boolean {
  return scopes.has(TOOL_POLICY[tool]);
}

export function allowedTools(scopes: ReadonlySet<string>): ToolName[] {
  return (Object.keys(TOOL_POLICY) as ToolName[]).filter((t) => canUseTool(scopes, t));
}
