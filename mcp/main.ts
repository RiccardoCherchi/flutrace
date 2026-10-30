import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CaptureSession } from "../src/vm/session.ts";
import { appSessionUrl } from "./app-session.ts";
import { createServer } from "./server.ts";

const session = new CaptureSession({ history: true });
const server = createServer(session, {
  showSecrets: process.env.FLUTRACE_MCP_SHOW_SECRETS === "1",
  defaultUrl: process.env.FLUTRACE_VM_URL,
  appUrl: () => appSessionUrl(),
});

let closing = false;
// Restore the app's profiling setting before exiting.
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.race([
    session.disconnect(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
