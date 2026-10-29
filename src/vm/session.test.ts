import { afterEach, expect, it } from "vitest";
import { CaptureSession } from "./session.ts";
import type { RpcTransport } from "./rpc.ts";

import { Vm, request } from "../test/fake-vm.ts";
const prefix = "ext.dart.io.";
const sessions: CaptureSession[] = [];
function setup(vm = new Vm()) {
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  sessions.push(session);
  return { session, vm };
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.disconnect()));
});

it("captures incremental updates with VM cursors and disambiguates isolates", async () => {
  const { vm, session } = setup();
  vm.isolates = ["i", "j"];
  await session.connect("unused");
  vm.timestamp = 200;
  vm.profiles.set("i", [request()]);
  vm.profiles.set("j", [request("r", "j")]);
  await session.refresh();
  expect(session.getSnapshot().rows).toHaveLength(2);
  expect(new Set(session.getSnapshot().rows.map((row) => row.key)).size).toBe(
    2,
  );
  expect(
    vm.calls
      .filter((call) => call.method === prefix + "getHttpProfile")
      .slice(-2)
      .map((call) => call.params.updatedSince),
  ).toEqual(["100", "100"]);
  vm.profiles.set("i", [
    { ...request(), response: { statusCode: 500, endTime: 201 } },
  ]);
  await session.refresh();
  expect(
    session.getSnapshot().rows.find((row) => row.isolateId === "i")?.response
      ?.statusCode,
  ).toBe(500);
});
it("ignores pre-connect traffic but retains request failures", async () => {
  const { vm, session } = setup();
  vm.profiles.set("i", [request("old", "i", 50)]);
  await session.connect("unused");
  vm.profiles.set("i", [
    request("old", "i", 50),
    { ...request("failed"), response: undefined, request: { error: "failed" } },
  ]);
  await session.refresh();
  expect(session.getSnapshot().rows.map((row) => row.id)).toEqual(["failed"]);
});
it("pauses and clears locally without resurrecting old updates", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.timestamp = 200;
  vm.profiles.set("i", [request()]);
  await session.refresh();
  await session.clear();
  await session.refresh();
  expect(session.getSnapshot().rows).toHaveLength(0);
  await session.setRecording(false);
  expect(vm.enabled.get("i")).toBe(false);
  vm.timestamp = 300;
  vm.profiles.set("i", [request("paused", "i", 250)]);
  await session.setRecording(true);
  await session.refresh();
  expect(session.getSnapshot().rows).toHaveLength(0);
  expect(
    vm.calls.some((call) => call.method.endsWith("clearHttpProfile")),
  ).toBe(false);
});
it("restores original profiler state on disconnect", async () => {
  const { vm, session } = setup();
  vm.isolates = ["i", "j"];
  vm.enabled.set("j", true);
  await session.connect("unused");
  expect(vm.enabled.get("i")).toBe(true);
  await session.disconnect();
  expect(vm.enabled.get("i")).toBe(false);
  expect(vm.enabled.get("j")).toBe(true);
  expect(vm.closed).toBe(true);
});
it("detects unsupported isolates without failing the connection", async () => {
  const { vm, session } = setup();
  vm.supported = false;
  await session.connect("unused");
  expect(session.getSnapshot().status).toBe("connected");
  expect(session.getSnapshot().supportedCount).toBe(0);
  expect(session.getSnapshot().message).toMatch(/HTTP profiling/);
});
it.each([true, false])(
  "handles isolate replacement with preserve log = %s",
  async (preserve) => {
    const { vm, session } = setup();
    session.setPreserveLog(preserve);
    await session.connect("unused");
    vm.profiles.set("i", [request()]);
    await session.refresh();
    vm.isolates = ["j"];
    await session.refresh();
    expect(session.getSnapshot().rows.length).toBe(preserve ? 1 : 0);
    expect(vm.enabled.get("j")).toBe(true);
  },
);
it("bounds retention without resurrecting evicted requests", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.profiles.set(
    "i",
    Array.from({ length: 2005 }, (_, n) => request(String(n), "i", 101 + n)),
  );
  await session.refresh();
  expect(session.getSnapshot().rows).toHaveLength(2000);
  expect(session.getSnapshot().rows[0].id).toBe("5");
  vm.profiles.set("i", [request("0")]);
  await session.refresh();
  expect(session.getSnapshot().rows[0].id).toBe("5");
});
it("loads selected bodies and clears selection with the log", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.profiles.set("i", [request()]);
  await session.refresh();
  await session.loadDetail(session.getSnapshot().rows[0].key);
  expect(session.getSnapshot().detail?.response.text).toBe("{}");
  await session.clear();
  expect(session.getSnapshot().selectedKey).toBeUndefined();
  expect(session.getSnapshot().detail).toBeUndefined();
});

it("continues existing requests after resume without importing paused traffic", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.profiles.set("i", [
    { ...request(), endTime: undefined, response: undefined },
  ]);
  await session.refresh();
  await session.setRecording(false);
  vm.timestamp = 200;
  await session.setRecording(true);
  vm.profiles.set("i", [request(), request("paused", "i", 150)]);
  await session.refresh();
  expect(session.getSnapshot().rows).toHaveLength(1);
  expect(session.getSnapshot().rows[0].response?.statusCode).toBe(200);
});
it("retries enabling profiling after a transient RPC failure", async () => {
  const { vm, session } = setup();
  const call = vm.call.bind(vm);
  let fail = true;
  vm.call = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (
      method.endsWith("httpEnableTimelineLogging") &&
      params.enabled === "true" &&
      fail
    ) {
      fail = false;
      throw new Error("Temporary failure");
    }
    return call<T>(method, params);
  };
  await session.connect("unused");
  await session.refresh();
  expect(vm.enabled.get("i")).toBe(true);
});
it("does not retain late body results after clear", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.profiles.set("i", [request()]);
  await session.refresh();
  const call = vm.call.bind(vm);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  vm.call = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method.endsWith("getHttpProfileRequest")) {
      started();
      await pending;
    }
    return call<T>(method, params);
  };
  const loading = session.loadDetail(session.getSnapshot().rows[0].key);
  await received;
  const clearing = session.clear();
  release();
  await Promise.all([loading, clearing]);
  expect(session.getSnapshot().detail).toBeUndefined();
  expect(session.getSnapshot().rows).toHaveLength(0);
});
it("skips body RPC when known size exceeds inspection limit", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.profiles.set("i", [
    {
      ...request(),
      response: { statusCode: 200, endTime: 103, contentLength: 3000000 },
    },
  ]);
  await session.refresh();
  await session.loadDetail(session.getSnapshot().rows[0].key);
  expect(session.getSnapshot().detail?.response.state).toBe("omitted");
  expect(
    vm.calls.some((call) => call.method.endsWith("getHttpProfileRequest")),
  ).toBe(false);
});
it("closes a stale connection that arrives after cancellation", async () => {
  const vm = new Vm();
  let release!: (rpc: RpcTransport) => void;
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  const session = new CaptureSession({
    connect: () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  sessions.push(session);
  const connecting = session.connect("unused");
  await received;
  await session.disconnect();
  release(vm);
  await connecting;
  expect(vm.closed).toBe(true);
  expect(session.getSnapshot().status).toBe("disconnected");
});

it("does not flash old rows when clear races an in-flight poll", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.profiles.set("i", [request()]);
  const call = vm.call.bind(vm);
  let release!: () => void;
  let started!: () => void;
  let once = true;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  vm.call = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method.endsWith("getHttpProfile") && once) {
      once = false;
      started();
      await pending;
    }
    return call<T>(method, params);
  };
  const polling = session.refresh();
  await received;
  const clearing = session.clear();
  const counts: number[] = [];
  const unsubscribe = session.subscribe(() =>
    counts.push(session.getSnapshot().rows.length),
  );
  release();
  await Promise.all([polling, clearing]);
  unsubscribe();
  expect(counts.every((count) => count === 0)).toBe(true);
});
