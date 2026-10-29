import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Body } from "./vm/body.ts";

export async function copyText(text: string) {
  if (isTauri()) await writeText(text);
  else await navigator.clipboard.writeText(text);
}
/** Text bodies as shown in Response: JSON pretty-printed, anything else verbatim. */
export function bodyText(body: Body | undefined): string | undefined {
  if (body?.state !== "ready" || body.text === undefined) return undefined;
  try {
    return JSON.stringify(JSON.parse(body.text), null, 2) ?? body.text;
  } catch {
    return body.text;
  }
}
