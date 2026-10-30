import { findJwts } from "../src/jwt.ts";
import type { Headers } from "../src/vm/types.ts";

export const HIDDEN = "<redacted>";
const sensitiveName =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|password|passwd|api[-_]?key|session|credential/i;
const keyPart = String.raw`[^"=&#\s]*(?:token|secret|password|passwd|api[-_]?key|session|credential|authorization)[^"=&#\s]*`;
const jsonPair = new RegExp(
  String.raw`("${keyPart}"\s*:\s*)"(?:[^"\\]|\\.)*"`,
  "gi",
);
const queryPair = new RegExp(String.raw`(^|[?&;])(${keyPart}=)[^&#\s"]*`, "gi");

export function redactHeaders(headers: Headers | undefined): Headers {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, values]) => [
      name,
      sensitiveName.test(name) ? values.map(() => HIDDEN) : values,
    ]),
  );
}

/** Hides JWTs and credential-like fields in URLs, JSON, and form bodies. */
export function redactText(text: string): string {
  let result = text;
  for (const { start, end } of findJwts(text).reverse())
    result = result.slice(0, start) + HIDDEN + result.slice(end);
  return result
    .replace(jsonPair, (match, key: string) =>
      // Fields such as token_type describe a credential rather than hold one.
      /type"/i.test(key) ? match : `${key}"${HIDDEN}"`,
    )
    .replace(queryPair, `$1$2${HIDDEN}`);
}
