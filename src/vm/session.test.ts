import { afterEach, expect, it } from "vitest";
import { CaptureSession } from "./session.ts";
import type { RpcTransport } from "./rpc.ts";

import { Vm, request, socket } from "../test/fake-vm.ts";
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

it("imports requests recorded before connecting only when asked", async () => {
  const earlier = request("old", "i", 50);
  for (const history of [false, true]) {
    const vm = new Vm();
    vm.profiles.set("i", [earlier]);
    const session = new CaptureSession({
      connect: async () => vm,
      intervalMs: 60000,
      history,
    });
    sessions.push(session);
    await session.connect("unused");
    expect(session.getSnapshot().rows.map((row) => row.id)).toEqual(
      history ? ["old"] : [],
    );
  }
});

it("captures sockets opened after connecting and keeps their counters current", async () => {
  const { vm, session } = setup();
  // Real VMs use wall-clock time for the HTTP profile and the monotonic
  // timeline clock for sockets, so socket times are far below the HTTP cursor.
  vm.timestamp = 1_700_000_000_000_000;
  vm.socketProfiles.set("i", [socket("old", 50)]);
  await session.connect("unused");
  expect(vm.socketEnabled.get("i")).toBe(true);
  vm.socketProfiles.set("i", [
    socket("old", 50),
    socket("ws", 150, { readBytes: 10, writeBytes: 4 }),
  ]);
  await session.refresh();
  expect(session.getSnapshot().sockets.map((row) => row.id)).toEqual(["ws"]);
  vm.socketProfiles.set("i", [
    socket("ws", 150, { readBytes: 900, writeBytes: 40, endTime: 400 }),
  ]);
  await session.refresh();
  const [row] = session.getSnapshot().sockets;
  expect(row).toMatchObject({ readBytes: 900, writeBytes: 40, endTime: 400 });
  // Each poll that moved bytes adds an activity entry with the delta.
  expect(row.activity.map(({ read, write }) => [read, write])).toEqual([
    [10, 4],
    [890, 36],
  ]);
  expect(row.lastActive).toBeTypeOf("number");
  await session.refresh();
  expect(session.getSnapshot().sockets[0].activity).toHaveLength(2);
  await session.clear();
  expect(session.getSnapshot().sockets).toEqual([]);
  vm.socketProfiles.set("i", [
    socket("ws", 150, { endTime: 400 }),
    socket("after-clear", 120),
  ]);
  await session.refresh();
  expect(session.getSnapshot().sockets.map((row) => row.id)).toEqual([
    "after-clear",
  ]);
});
it("normalizes numeric socket ids from older VMs", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.socketProfiles.set("i", [
    { ...socket("x", 150), id: 7 as unknown as string },
  ]);
  await session.refresh();
  expect(session.getSnapshot().sockets[0].id).toBe("7");
});
it("pauses socket profiling with recording and restores it on disconnect", async () => {
  const { vm, session } = setup();
  vm.isolates = ["i", "j"];
  vm.socketEnabled.set("j", true);
  await session.connect("unused");
  await session.setRecording(false);
  expect(vm.socketEnabled.get("i")).toBe(false);
  expect(vm.socketEnabled.get("j")).toBe(true);
  await session.setRecording(true);
  expect(vm.socketEnabled.get("i")).toBe(true);
  await session.disconnect();
  expect(vm.socketEnabled.get("i")).toBe(false);
  expect(vm.socketEnabled.get("j")).toBe(true);
});
it("keeps capturing HTTP when sockets are unsupported", async () => {
  const vm = new Vm();
  vm.socketsSupported = false;
  const { session } = setup(vm);
  await session.connect("unused");
  vm.timestamp = 200;
  vm.profiles.set("i", [request()]);
  await session.refresh();
  expect(session.getSnapshot().rows).toHaveLength(1);
  expect(session.getSnapshot().sockets).toEqual([]);
  expect(
    vm.calls.some((call) => call.method.endsWith("getSocketProfile")),
  ).toBe(false);
});

it("collects app-reported WebSocket messages per connection", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  const base = Date.now();
  expect(
    vm.calls.some(
      (call) =>
        call.method === "streamListen" && call.params.streamId === "Extension",
    ),
  ).toBe(true);
  vm.ws({ type: "open", id: "1", url: "wss://x.test:9443/ws", at: base });
  vm.ws({
    type: "message",
    id: "1",
    direction: "in",
    size: 9,
    text: '{"p":"1"}',
    at: base + 100,
  });
  vm.ws({
    type: "message",
    id: "1",
    direction: "out",
    size: 2,
    text: "hi",
    at: base + 200,
  });
  // Unrelated extension events are ignored.
  vm.onEvent?.("Extension", { extensionKind: "other", extensionData: {} });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const [connection] = session.getSnapshot().webSockets;
  expect(connection).toMatchObject({
    url: "wss://x.test:9443/ws",
    total: 2,
  });
  expect(connection.messages.map((m) => [m.direction, m.text])).toEqual([
    ["in", '{"p":"1"}'],
    ["out", "hi"],
  ]);
  // Per-second activity is kept as messages arrive.
  const second = Math.floor((base + 100) / 1000) * 1000;
  const split = Math.floor((base + 200) / 1000) * 1000 !== second;
  expect(connection.activity).toEqual(
    split
      ? [
          { at: second, read: 9, write: 0 },
          { at: second + 1000, read: 0, write: 2 },
        ]
      : [{ at: second, read: 9, write: 2 }],
  );
  expect(connection.lastActive).toBe(base + 200);
  vm.ws({ type: "close", id: "1", code: 1000, at: base + 1000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(session.getSnapshot().webSockets[0]).toMatchObject({
    closedAt: base + 1000,
    closeCode: 1000,
  });
  await session.clear();
  expect(session.getSnapshot().webSockets).toEqual([]);
});
it("picks up a WebSocket that opened before Flutrace attached", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  // No "open" event: the app connected first. Messages carry the URL.
  vm.ws({
    type: "message",
    id: "7",
    url: "wss://x.test/live",
    direction: "in",
    size: 2,
    text: "{}",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(session.getSnapshot().webSockets[0]).toMatchObject({
    url: "wss://x.test/live",
    total: 1,
  });
});
it("ignores WebSocket events replayed from before connecting", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  const old = Date.now() - 10 * 60_000;
  vm.ws({ type: "open", id: "1", url: "wss://x.test/old", at: old });
  vm.ws({ type: "message", id: "1", url: "wss://x.test/old", at: old + 1 });
  vm.ws({ type: "message", id: "2", url: "wss://x.test/new", at: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(session.getSnapshot().webSockets.map((c) => c.url)).toEqual([
    "wss://x.test/new",
  ]);
});
it("copies a connection once per burst and leaves earlier snapshots intact", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  const at = Math.floor(Date.now() / 1000) * 1000;
  vm.ws({ type: "open", id: "1", url: "wss://x.test/ws", at });
  vm.ws({ type: "message", id: "1", direction: "in", size: 1, at });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const before = session.getSnapshot().webSockets[0];
  for (let n = 0; n < 1005; n++)
    vm.ws({ type: "message", id: "1", direction: "in", size: 1, at });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = session.getSnapshot().webSockets[0];
  expect(before.messages).toHaveLength(1);
  expect(before.activity).toEqual([{ at, read: 1, write: 0 }]);
  expect(after.total).toBe(1006);
  expect(after.messages).toHaveLength(1000);
  expect(after.messages[0].seq).toBe(6);
  expect(after.bytesIn).toBe(1006);
  expect(after.activity).toEqual([{ at, read: 1006, write: 0 }]);
});
it("applies WebSocket close events while recording is paused", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  const base = Date.now();
  vm.ws({ type: "open", id: "1", url: "wss://x.test/ws", at: base });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await session.setRecording(false);
  vm.ws({ type: "message", id: "1", direction: "in", size: 3, at: base + 1 });
  vm.ws({ type: "close", id: "1", code: 1001, at: base + 2 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(session.getSnapshot().webSockets[0]).toMatchObject({
    total: 0,
    closedAt: base + 2,
    closeCode: 1001,
  });
});
it("does not report connected when the VM closes during streamListen", async () => {
  const vm = new Vm();
  let release!: () => void;
  const listening = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = vm.call.bind(vm);
  vm.call = (async (method: string, params?: Record<string, unknown>) => {
    if (method === "streamListen") await listening;
    return call(method, params);
  }) as Vm["call"];
  const { session } = setup(vm);
  const connecting = session.connect("unused");
  await new Promise((resolve) => setTimeout(resolve, 0));
  vm.close();
  release();
  await connecting;
  expect(session.getSnapshot().status).toBe("disconnected");
});
it("keeps the newest 2000 sockets across polls", async () => {
  const { vm, session } = setup();
  await session.connect("unused");
  vm.socketProfiles.set(
    "i",
    Array.from({ length: 2005 }, (_, n) =>
      socket(String(n), 101 + n, { readBytes: 10 }),
    ),
  );
  await session.refresh();
  expect(session.getSnapshot().sockets).toHaveLength(2000);
  expect(session.getSnapshot().sockets[0].id).toBe("5");
  await session.refresh();
  const sockets = session.getSnapshot().sockets;
  expect(sockets).toHaveLength(2000);
  expect(sockets[0].id).toBe("5");
  expect(sockets.some((row) => row.id === "0")).toBe(false);
});
