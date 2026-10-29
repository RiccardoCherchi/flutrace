import { expect, it } from "vitest";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { toCurl } from "./curl.ts";
import { makeDetail } from "./vm/body.ts";
import { request } from "./test/fake-vm.ts";

function captured(bytes: number[]) {
  return makeDetail({
    ...request(),
    method: "POST",
    requestBody: bytes,
    uri: "https://example.test/a[1]?q='$(printf injected)'",
    request: {
      headers: {
        authorization: ["Bearer '$(printf injected)'"],
        "content-length": [String(bytes.length)],
        "x-repeat": ["one", "two"],
      },
    },
  });
}
function shell(command: string) {
  return execFileSync(
    "/bin/sh",
    ["-c", `curl() { printf '%s\\0' "$@"; printf '\\0'; cat; }\n${command}`],
    { input: Buffer.alloc(0), maxBuffer: 8 * 1024 * 1024 },
  );
}
it("quotes shell syntax literally and preserves URL, method, repeated headers and text body", () => {
  const body = '@file\n{"text":"it\'s $(printf injected) `printf bad`"}';
  const detail = captured([...new TextEncoder().encode(body)]);
  const args = shell(toCurl(detail)!).toString().split("\0");
  expect(args).toContain(detail.metadata.uri);
  expect(args).toContain("authorization: Bearer '$(printf injected)'");
  expect(args).toContain("x-repeat: one");
  expect(args).toContain("x-repeat: two");
  expect(args).toContain(body);
  expect(args).not.toContain("content-length");
  expect(args).toContain("--data-raw");
});
it("passes binary and large bodies byte-for-byte through stdin", () => {
  for (const bytes of [[0, 255, 13, 10, 128], Array(40000).fill(65)]) {
    const output = shell(toCurl(captured(bytes))!);
    const separator = output.indexOf(Buffer.from([0, 0]));
    expect(output.subarray(separator + 2)).toEqual(Buffer.from(bytes));
    expect(output.subarray(0, separator).toString()).toContain(
      "--data-binary\0@-",
    );
  }
});
it("refuses missing, oversized or unsafe request data", () => {
  const detail = captured([]);
  for (const state of ["pending", "unavailable", "omitted"] as const)
    expect(toCurl({ ...detail, request: { state } })).toBeUndefined();
  detail.metadata.request!.headers!.test = ["ok\r\nInjected: value"];
  expect(toCurl(detail)).toBeUndefined();
  delete detail.metadata.request!.headers!.test;
  detail.metadata.request!.headers!["@local-file"] = ["value"];
  expect(toCurl(detail)).toBeUndefined();
});
it("exports bodyless GET and HEAD without adding data", () => {
  for (const method of ["GET", "HEAD"]) {
    const detail = makeDetail({ ...request(), method, requestBody: [] });
    const command = toCurl(detail)!;
    expect(command).not.toContain("--data");
    expect(command.includes("--head")).toBe(method === "HEAD");
  }
});

it("decodes gzip responses when replaying a captured Accept-Encoding header", async () => {
  const payload = '{"message":"risposta leggibile è"}';
  let encoding: string | undefined;
  const server = createServer((req, res) => {
    encoding = req.headers["accept-encoding"];
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    });
    res.end(gzipSync(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    const detail = makeDetail({
      ...request(),
      requestBody: [],
      uri: `http://127.0.0.1:${address.port}/`,
      request: { headers: { "Accept-Encoding": ["gzip"] } },
    });
    const { stdout } = await promisify(execFile)(
      "/bin/sh",
      ["-c", toCurl(detail)!],
      {
        timeout: 5000,
        env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
      },
    );
    expect(encoding).toBe("gzip");
    expect(stdout).toBe(payload);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
