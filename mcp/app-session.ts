import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Written by the Flutrace desktop app while it is connected (src-tauri/src/main.rs). */
export const sessionFile =
  process.env.FLUTRACE_SESSION_FILE ??
  join(
    homedir(),
    "Library/Application Support/com.riccardocherchi.flutrace/session.json",
  );

/** The VM Service URL the running Flutrace app is connected to, if any. */
export function appSessionUrl(file = sessionFile): string | undefined {
  try {
    const { vmServiceUri, pid } = JSON.parse(readFileSync(file, "utf8"));
    // A crashed app can leave the file behind.
    process.kill(pid, 0);
    return typeof vmServiceUri === "string" ? vmServiceUri : undefined;
  } catch {
    return undefined;
  }
}
