import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test } from "vitest";
import { request, Vm } from "../src/test/fake-vm.ts";
import { CaptureSession } from "../src/vm/session.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSessionUrl } from "./app-session.ts";
import { redactText } from "./redact.ts";
import { createServer } from "./server.ts";

// {"alg":"HS256"}.{"sub":"1"}.signature
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
const bytes = (text: string) => [...new TextEncoder().encode(text)];
let session: CaptureSession;

/** Without a fake VM, the session dials for real, so URL validation applies. */
async function setup(
  vm?: Vm,
  showSecrets = false,
  appUrl?: () => string | undefined,
) {
  session = new CaptureSession(
    vm ? { connect: async () => vm, intervalMs: 10 } : {},
  );
  const server = createServer(session, { showSecrets, appUrl });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientEnd);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0].text;
    return { error: !!result.isError, text, json: () => JSON.parse(text) };
  };
}
function secretVm() {
  const vm = new Vm();
  const secret = {
    ...request("r1"),
    uri: "https://example.test/login?api_key=k1&page=2",
    method: "POST",
    request: {
      headers: {
        authorization: [`Bearer ${jwt}`],
        "content-type": ["application/json"],
      },
    },
  };
  vm.profiles.set("i", [secret]);
  vm.detail = {
    ...secret,
    requestBody: bytes(`{"user":"ada","password":"hunter2"}`),
    responseBody: bytes(`{"token":"${jwt}","token_type":"Bearer"}`),
  };
  return vm;
}
afterEach(() => session?.disconnect());

test("redacts credentials in lists, details, search, and cURL", async () => {
  const call = await setup(secretVm());
  expect(
    (await call("connect", { vm_url: "http://127.0.0.1:1/x=/" })).json(),
  ).toMatchObject({ connected: true, capturing: 1 });
  const [row] = (await call("list_requests")).json().requests;
  expect(row).toMatchObject({
    method: "POST",
    status: 200,
    url: "https://example.test/login?api_key=<redacted>&page=2",
  });
  const detail = (await call("get_request", { id: row.id })).text;
  expect(detail).not.toContain("hunter2");
  expect(detail).not.toContain(jwt);
  expect(detail).toContain(`"authorization":["<redacted>"]`);
  expect(detail).toContain(String.raw`\"token_type\":\"Bearer\"`);
  const search = (await call("search", { text: "hunter2" })).json();
  expect(search.hits[0].matches).toEqual([
    { in: "request body", snippet: "(match inside a redacted value)" },
  ]);
  const curl = (await call("as_curl", { id: row.id })).text;
  expect(curl).toContain("--header 'authorization: <redacted>'");
  expect(curl).not.toContain("hunter2");
});

test("shows secrets only when the server is started with them on", async () => {
  const call = await setup(secretVm(), true);
  await call("connect", { vm_url: "http://127.0.0.1:1/x=/" });
  const [row] = (await call("list_requests")).json().requests;
  expect((await call("get_request", { id: row.id })).text).toContain("hunter2");
});

test("waits for a request that finishes after the call", async () => {
  const vm = new Vm();
  vm.profiles.set("i", [request("old")]);
  const call = await setup(vm);
  await call("connect", { vm_url: "http://127.0.0.1:1/x=/" });
  const waiting = call("wait_for_request", {
    url: "/orders",
    timeout_ms: 2000,
  });
  vm.timestamp = 200;
  vm.profiles.set("i", [
    request("old"),
    { ...request("new", "i", 201), uri: "https://example.test/orders" },
  ]);
  expect((await waiting).json()).toMatchObject({
    matched: true,
    request: { url: "https://example.test/orders" },
  });
  expect(
    (await call("wait_for_request", { url: "/none", timeout_ms: 100 })).json(),
  ).toMatchObject({ matched: false });
});

test("refuses remote VM URLs and calls before connecting", async () => {
  const call = await setup();
  expect((await call("list_requests")).error).toBe(true);
  const remote = await call("connect", {
    vm_url: "http://example.com:8181/abc=/",
  });
  expect(remote.error).toBe(true);
  expect(remote.text).toMatch(/local VM Service URL/);
});

test("redactText keeps ordinary values", () => {
  expect(redactText(`{"session_id":"s1","name":"x"}`)).toBe(
    `{"session_id":"<redacted>","name":"x"}`,
  );
  expect(redactText("a=1&access_token=t&b=2")).toBe(
    "a=1&access_token=<redacted>&b=2",
  );
});

test("attaches to the Flutrace app's session without connect", async () => {
  const vm = new Vm();
  vm.profiles.set("i", [request("r1")]);
  const call = await setup(vm, false, () => "http://127.0.0.1:1/x=/");
  expect((await call("list_requests")).json().total).toBe(1);
  expect((await call("status")).json().status).toBe("connected");
});

test("reads the app's session file only while the app is running", () => {
  const file = join(mkdtempSync(join(tmpdir(), "flutrace-")), "session.json");
  expect(appSessionUrl(file)).toBeUndefined();
  const url = "ws://127.0.0.1:1/x=/ws";
  writeFileSync(file, JSON.stringify({ vmServiceUri: url, pid: process.pid }));
  expect(appSessionUrl(file)).toBe(url);
  // Above the macOS pid range, so no process has it.
  writeFileSync(file, JSON.stringify({ vmServiceUri: url, pid: 99999999 }));
  expect(appSessionUrl(file)).toBeUndefined();
});
