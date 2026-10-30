import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { toCurl } from "../src/curl.ts";
import { matchesStatus } from "../src/request-list.ts";
import type { Body, RequestDetail } from "../src/vm/body.ts";
import type { CaptureSession } from "../src/vm/session.ts";
import { durationMs, mimeType } from "../src/vm/types.ts";
import type { RequestRow } from "../src/vm/types.ts";
import { redactHeaders, redactText } from "./redact.ts";

const instructions = `Flutrace reads the HTTP traffic of a Flutter app running in debug mode, through its local Dart VM Service.
When the Flutrace desktop app is connected to an app, the tools attach to the same VM Service automatically and include the requests it already recorded. Otherwise call connect with the VM Service URL printed by \`flutter run\` (for example http://127.0.0.1:50300/abc=/).
Typical loop: trigger the app action, wait_for_request or list_requests, then get_request for headers, bodies, and timing.
Credentials, cookies, and JWTs are redacted unless the user started the server with FLUTRACE_MCP_SHOW_SECRETS=1.`;

type Result = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
const ok = (value: unknown): Result => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const fail = (text: string): Result => ({
  content: [{ type: "text", text }],
  isError: true,
});

const done = (row: RequestRow) =>
  row.response?.endTime !== undefined ||
  !!row.request?.error ||
  !!row.response?.error;
const statusOf = (row: RequestRow) =>
  row.request?.error || row.response?.error
    ? "failed"
    : (row.response?.statusCode ?? "pending");

export function createServer(
  session: CaptureSession,
  options: {
    showSecrets?: boolean;
    defaultUrl?: string;
    /** URL of the VM the Flutrace desktop app is connected to, if any. */
    appUrl?: () => string | undefined;
  } = {},
) {
  const show = !!options.showSecrets;
  const text = (value: string) => (show ? value : redactText(value));
  const headers = (value: Parameters<typeof redactHeaders>[0]) =>
    show ? (value ?? {}) : redactHeaders(value);
  const summary = (row: RequestRow) => ({
    id: row.key,
    method: row.method,
    url: text(row.uri),
    status: statusOf(row),
    type: mimeType(row) || undefined,
    size: row.response?.contentLength,
    durationMs: durationMs(row),
    startedAt: new Date(row.startTime / 1000).toISOString(),
  });
  const decode = (body: Body) => {
    if (body.text !== undefined) return body.text;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
    } catch {
      return undefined;
    }
  };
  const body = (value: Body, max: number) => {
    if (value.state === "omitted") return { state: "omitted (over 2 MiB)" };
    if (value.state !== "ready") return { state: value.state };
    const size = value.bytes?.length ?? 0;
    if (!size) return { size };
    if (value.imageMime) return { size, image: value.imageMime };
    const raw = decode(value);
    if (raw === undefined) return { size, binary: true };
    const shown = text(raw);
    return shown.length > max
      ? { size, text: shown.slice(0, max), truncated: true }
      : { size, text: shown };
  };
  const connected = () => session.getSnapshot().status === "connected";
  const fallbackUrl = () => options.defaultUrl ?? options.appUrl?.();
  /** Connects to the configured URL or the Flutrace app's session when idle. */
  async function ready() {
    if (connected()) return true;
    const url = fallbackUrl();
    if (!url || session.getSnapshot().status !== "disconnected") return false;
    await session.connect(url);
    return connected();
  }
  const notConnected = () =>
    fail(
      "Not connected. Connect the Flutrace app to your Flutter app, or call connect with the VM Service URL from flutter run.",
    );
  const find = (id: string) =>
    session.getSnapshot().rows.find((row) => row.key === id);
  async function detailOf(id: string) {
    if (!find(id))
      return fail(`No captured request with id ${id}. Use list_requests.`);
    const detail = await session.fetchDetail(id);
    return (
      detail ??
      fail("Details unavailable: the request expired or its isolate restarted.")
    );
  }

  const server = new McpServer(
    { name: "flutrace", version: "0.2.0" },
    { instructions },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "connect",
    {
      description:
        "Connect to a Flutter app's local Dart VM Service and start capturing its HTTP requests. Only localhost URLs are accepted.",
      inputSchema: z.object({
        vm_url: z
          .string()
          .optional()
          .describe(
            "VM Service URL from `flutter run`, or a DevTools link containing it. Defaults to FLUTRACE_VM_URL, then to the app the Flutrace desktop app is connected to.",
          ),
      }),
    },
    async ({ vm_url }) => {
      const url = vm_url ?? fallbackUrl();
      if (!url)
        return fail(
          "Pass vm_url, the VM Service URL from flutter run, or connect the Flutrace app first.",
        );
      await session.connect(url);
      const snapshot = session.getSnapshot();
      if (snapshot.status !== "connected")
        return fail(snapshot.message || "Could not connect.");
      return ok({
        connected: true,
        isolates: snapshot.isolateCount,
        capturing: snapshot.supportedCount,
        message: snapshot.message || undefined,
      });
    },
  );

  server.registerTool(
    "disconnect",
    {
      description:
        "Stop capturing and restore the app's original HTTP profiling setting.",
      inputSchema: z.object({}),
    },
    async () => {
      await session.disconnect();
      return ok({
        connected: false,
        message: session.getSnapshot().message || undefined,
      });
    },
  );

  server.registerTool(
    "status",
    {
      description: "Connection state, recording state, and captured count.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => {
      await ready();
      const snapshot = session.getSnapshot();
      return ok({
        status: snapshot.status,
        recording: snapshot.recording,
        requests: snapshot.rows.length,
        isolates: snapshot.isolateCount,
        capturing: snapshot.supportedCount,
        message: snapshot.message || undefined,
      });
    },
  );

  server.registerTool(
    "list_requests",
    {
      description:
        "List captured requests, oldest first, returning the most recent matches.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the URL."),
        method: z.string().optional().describe("HTTP method, e.g. POST."),
        status: z
          .enum(["all", "2xx", "3xx", "4xx", "5xx", "failed", "pending"])
          .optional()
          .describe("failed means a 4xx/5xx status or a transport error."),
        type: z.enum(["all", "json", "image"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: readOnly,
    },
    async ({ url, method, status = "all", type = "all", limit = 50 }) => {
      if (!(await ready()) && !session.getSnapshot().rows.length)
        return notConnected();
      const rows = session.getSnapshot().rows.filter((row) => {
        const mime = mimeType(row);
        return (
          (!url || row.uri.toLowerCase().includes(url.toLowerCase())) &&
          (!method || row.method.toUpperCase() === method.toUpperCase()) &&
          matchesStatus(row, status) &&
          (type === "all" ||
            (type === "json"
              ? mime.includes("json")
              : mime.startsWith("image/")))
        );
      });
      return ok({
        total: rows.length,
        requests: rows.slice(-limit).map(summary),
      });
    },
  );

  server.registerTool(
    "get_request",
    {
      description:
        "Headers, query, bodies, timing events, and errors of one captured request.",
      inputSchema: z.object({
        id: z.string().describe("Request id from list_requests."),
        max_body_chars: z
          .number()
          .int()
          .min(0)
          .max(200_000)
          .optional()
          .describe(
            "Truncate each body to this many characters. Default 20000.",
          ),
      }),
      annotations: readOnly,
    },
    async ({ id, max_body_chars = 20_000 }) => {
      const detail = await detailOf(id);
      if ("content" in detail) return detail;
      const { metadata } = detail;
      const row = find(id)!;
      return ok({
        ...summary(row),
        error: metadata.request?.error ?? metadata.response?.error,
        requestHeaders: headers(metadata.request?.headers),
        responseHeaders: headers(metadata.response?.headers),
        requestBody: body(detail.request, max_body_chars),
        responseBody: body(detail.response, max_body_chars),
        events: metadata.events?.map((event) => ({
          event: event.event,
          atMs: (event.timestamp - metadata.startTime) / 1000,
        })),
      });
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Find text in the URLs, headers, and bodies of every captured request.",
      inputSchema: z.object({
        text: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: readOnly,
    },
    async ({ text: query, limit = 20 }) => {
      if (!(await ready()) && !session.getSnapshot().rows.length)
        return notConnected();
      const needle = query.toLowerCase();
      const hits = [];
      for (const row of [...session.getSnapshot().rows].reverse()) {
        if (hits.length >= limit) break;
        const detail: RequestDetail | undefined = await session.fetchDetail(
          row.key,
        );
        const fields: [string, string | undefined][] = [
          ["url", row.uri],
          ["request headers", flatten(detail?.metadata.request?.headers, show)],
          [
            "response headers",
            flatten(detail?.metadata.response?.headers, show),
          ],
          ["request body", detail && decode(detail.request)],
          ["response body", detail && decode(detail.response)],
        ];
        const matches = [];
        for (const [where, raw] of fields) {
          if (!raw?.toLowerCase().includes(needle)) continue;
          const shown = text(raw);
          const at = shown.toLowerCase().indexOf(needle);
          matches.push(
            at < 0
              ? { in: where, snippet: "(match inside a redacted value)" }
              : {
                  in: where,
                  snippet: shown
                    .slice(Math.max(0, at - 60), at + needle.length + 60)
                    .replace(/\s+/g, " "),
                },
          );
        }
        if (matches.length) hits.push({ ...summary(row), matches });
      }
      return ok({ hits });
    },
  );

  server.registerTool(
    "wait_for_request",
    {
      description:
        "Wait until a matching request finishes, then return it. Use after triggering an action in the app.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the URL."),
        method: z.string().optional(),
        timeout_ms: z.number().int().min(100).max(300_000).optional(),
      }),
      annotations: readOnly,
    },
    async ({ url, method, timeout_ms = 30_000 }) => {
      if (!(await ready())) return notConnected();
      const finished = new Set(
        session
          .getSnapshot()
          .rows.filter(done)
          .map((row) => row.key),
      );
      return new Promise<Result>((resolve) => {
        const check = () => {
          const snapshot = session.getSnapshot();
          if (snapshot.status !== "connected")
            return finish(fail("Disconnected while waiting."));
          const row = snapshot.rows.find(
            (row) =>
              !finished.has(row.key) &&
              done(row) &&
              (!url || row.uri.toLowerCase().includes(url.toLowerCase())) &&
              (!method || row.method.toUpperCase() === method.toUpperCase()),
          );
          if (row) finish(ok({ matched: true, request: summary(row) }));
        };
        const unsubscribe = session.subscribe(check);
        const timer = setTimeout(
          () =>
            finish(
              ok({
                matched: false,
                message: `No matching request finished within ${timeout_ms} ms.`,
              }),
            ),
          timeout_ms,
        );
        function finish(result: Result) {
          clearTimeout(timer);
          unsubscribe();
          resolve(result);
        }
        check();
      });
    },
  );

  server.registerTool(
    "as_curl",
    {
      description:
        "A cURL command that replays a captured request. Redacted values stay redacted.",
      inputSchema: z.object({ id: z.string() }),
      annotations: readOnly,
    },
    async ({ id }) => {
      const detail = await detailOf(id);
      if ("content" in detail) return detail;
      const curl = toCurl(show ? detail : redactDetail(detail, text));
      return curl
        ? { content: [{ type: "text", text: curl }] }
        : fail("cURL is unavailable until the complete request body loads.");
    },
  );

  server.registerTool(
    "clear",
    {
      description: "Clear the captured requests.",
      inputSchema: z.object({}),
    },
    async () => {
      await session.clear();
      return ok({ cleared: true });
    },
  );

  for (const [name, recording] of [
    ["pause", false],
    ["resume", true],
  ] as const)
    server.registerTool(
      name,
      {
        description: recording
          ? "Resume recording. Requests made while paused are not imported."
          : "Pause recording and turn profiling off if Flutrace turned it on.",
        inputSchema: z.object({}),
      },
      async () => {
        if (!(await ready())) return notConnected();
        await session.setRecording(recording);
        return ok({ recording: session.getSnapshot().recording });
      },
    );

  return server;
}

function flatten(headers: Record<string, string[]> | undefined, show: boolean) {
  const shown = show ? headers : redactHeaders(headers);
  return Object.entries(shown ?? {})
    .map(([name, values]) => `${name}: ${values.join(", ")}`)
    .join("\n");
}

function redactDetail(
  detail: RequestDetail,
  text: (value: string) => string,
): RequestDetail {
  const { metadata, request } = detail;
  let bytes = request.bytes;
  if (bytes?.length) {
    try {
      bytes = new TextEncoder().encode(
        text(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      /* Binary bodies are kept as captured. */
    }
  }
  return {
    ...detail,
    metadata: {
      ...metadata,
      uri: text(metadata.uri),
      request: metadata.request && {
        ...metadata.request,
        headers: redactHeaders(metadata.request.headers),
      },
    },
    request: { ...request, bytes },
  };
}
