import type { RequestDetail } from "./vm/body.ts";

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function toCurl(detail: RequestDetail): string | undefined {
  const { metadata: request, request: body } = detail;
  if (body.state !== "ready" || !body.bytes) return undefined;
  if (!/^https?:\/\//i.test(request.uri)) return undefined;
  if ([request.uri, request.method].some((value) => /[\0\r\n]/.test(value)))
    return undefined;
  const args = [
    "curl --globoff --path-as-is",
    `--request ${quote(request.method)}`,
    `--url ${quote(request.uri)}`,
  ];
  if (
    Object.keys(request.request?.headers ?? {}).some((name) =>
      /^accept-encoding$/i.test(name),
    )
  )
    args.push("--compressed");
  if (request.method === "HEAD") args.push("--head");
  for (const [name, values] of Object.entries(request.request?.headers ?? {})) {
    if (/^(content-length|transfer-encoding)$/i.test(name)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return undefined;
    for (const value of values) {
      if (/[\0\r\n]/.test(value)) return undefined;
      args.push(`--header ${quote(value ? `${name}: ${value}` : `${name};`)}`);
    }
  }
  if (body.bytes.length) {
    if (request.method === "HEAD") return undefined;
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        body.bytes,
      );
    } catch {
      /* Binary bodies use stdin. */
    }
    if (
      text !== undefined &&
      !text.includes("\0") &&
      body.bytes.length < 32768
    ) {
      args.push(`--data-raw ${quote(text)}`);
    } else {
      let binary = "";
      for (const byte of body.bytes) binary += String.fromCharCode(byte);
      const encoded = btoa(binary)
        .match(/.{1,76}/g)!
        .join("\n");
      args.push("--data-binary @-");
      return `base64 -d <<'FLUTRACE_BODY' | ${args.join(" \\\n  ")}\n${encoded}\nFLUTRACE_BODY`;
    }
  }
  return args.join(" \\\n  ");
}
