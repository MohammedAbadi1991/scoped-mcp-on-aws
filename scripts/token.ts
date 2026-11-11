// Prints an access token for one caller, for curl, MCP Inspector or Claude Code.
// Usage: npm run token -- reader|editor|admin
import { getAccessToken, type Caller } from "./lib.js";

const caller = (process.argv[2] ?? "reader") as Caller;
if (!["reader", "editor", "admin"].includes(caller)) {
  console.error("usage: npm run token -- reader|editor|admin");
  process.exit(1);
}
process.stdout.write((await getAccessToken(caller)) + "\n");
