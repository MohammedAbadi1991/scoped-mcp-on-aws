import { createHandler } from "./app.js";
import { DynamoNotesStore } from "./store.js";

// Lambda entry point. Dependencies are created once per execution environment
// and reused across invocations.
export const handler = createHandler(() => {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error("TABLE_NAME is not set");
  return { store: new DynamoNotesStore(tableName) };
});
