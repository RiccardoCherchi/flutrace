import { expect, it } from "vitest";
import {
  connectionForRequest,
  connectionForSocket,
  helperSocketRows,
  labelSockets,
  socketBuckets,
  socketRate,
} from "./sockets.ts";
import type { RequestRow, SocketRow } from "./vm/types.ts";

const socket = (key: string, port: number, extra: Partial<SocketRow> = {}) =>
  ({
    key,
    id: key,
    isolateId: "i",
    session: 1,
    address: "13.159.10.113",
    port,
    socketType: "tcp",
    startTime: 1,
    readBytes: 0,
    writeBytes: 0,
    activity: [],
    ...extra,
  }) as SocketRow;
const request = (key: string, uri: string, status = 200) =>
  ({
    key,
    id: key,
    isolateId: "i",
    session: 1,
    method: "GET",
    uri,
    startTime: 1,
    response: { statusCode: status },
  }) as RequestRow;

it("names WebSockets from their 101 upgrade and leaves shared ports unnamed", () => {
  const labels = labelSockets(
    [socket("ws", 9443), socket("api", 443), socket("other", 8080)],
    [
      request("up", "https://stream.binance.com:9443/ws/ethusdt@trade", 101),
      request("t", "https://api.binance.com/api/v3/ticker"),
    ],
  );
  expect(labels.get("ws")).toEqual({
    host: "stream.binance.com",
    webSocket: true,
    requestKey: "up",
  });
  expect(labels.get("api")).toMatchObject({
    host: "api.binance.com",
    webSocket: false,
  });
  expect(labels.has("other")).toBe(false);
  const shared = labelSockets(
    [socket("s", 443)],
    [request("a", "https://a.test/"), request("b", "https://b.test/")],
  );
  expect(shared.has("s")).toBe(false);
});

it("labels only the socket nearest each handshake as a WebSocket", () => {
  // HTTPS keep-alive sockets and a WSS socket share api.example.com:443.
  const sockets = [
    socket("https-1", 443, { startTime: 1_000_000 }),
    socket("wss", 443, { startTime: 5_000_000 }),
    socket("https-2", 443, { startTime: 9_000_000 }),
    socket("wss-2", 443, { startTime: 20_000_000 }),
  ];
  const handshake = request("up", "wss://api.example.com/ws", 101);
  handshake.startTime = 5_010_000;
  const requests = [
    request("get", "https://api.example.com/items"),
    handshake,
    request("post", "https://api.example.com/orders"),
  ];
  const one = labelSockets(sockets, requests);
  expect(one.get("wss")).toEqual({
    host: "api.example.com",
    webSocket: true,
    requestKey: "up",
  });
  for (const key of ["https-1", "https-2", "wss-2"])
    expect(one.get(key)).toEqual({ host: "api.example.com", webSocket: false });
  // A second WebSocket on the same port claims its own nearest socket.
  const second = request("up-2", "wss://api.example.com/feed", 101);
  second.startTime = 19_990_000;
  const two = labelSockets(sockets, [...requests, second]);
  expect(two.get("wss")?.requestKey).toBe("up");
  expect(two.get("wss-2")).toMatchObject({
    webSocket: true,
    requestKey: "up-2",
  });
  expect(two.get("https-1")?.webSocket).toBe(false);
  expect(two.get("https-2")?.webSocket).toBe(false);
});

it("computes live rates and per-second buckets from activity", () => {
  const now = 10_000;
  const row = socket("s", 443, {
    activity: [
      { at: 1_000, read: 999, write: 999 },
      { at: 8_000, read: 300, write: 30 },
      { at: 9_500, read: 600, write: 60 },
    ],
  });
  expect(socketRate(row, now)).toEqual({ read: 300, write: 30 });
  const buckets = socketBuckets(row, now, 5);
  expect(buckets).toEqual([0, 0, 330, 0, 660]);
});

it("matches a handshake request to the connection it opened", () => {
  const connection = (id: string, openedAt: number) => ({
    key: id,
    id,
    isolateId: "i",
    session: 1,
    url: "wss://stream.binance.com:9443/ws/ethusdt@trade",
    openedAt,
    messages: [],
    total: 0,
    bytesIn: 0,
    bytesOut: 0,
    activity: [],
  });
  const handshake = request(
    "up",
    "https://stream.binance.com:9443/ws/ethusdt@trade",
    101,
  );
  handshake.startTime = 5_000_000; // microseconds
  const match = connectionForRequest(handshake, [
    connection("old", 1_000),
    connection("new", 5_200),
  ]);
  expect(match?.id).toBe("new");
  expect(
    connectionForRequest(request("x", "https://other.test/ws", 101), [
      connection("a", 1),
    ]),
  ).toBeUndefined();
});

it("matches a WS socket to its open app-reported connection", () => {
  const ws = (id: string, closedAt?: number) => ({
    key: id,
    id,
    isolateId: "i",
    session: 1,
    url: "wss://stream.binance.com:9443/ws/ethusdt@trade",
    openedAt: 1,
    closedAt,
    messages: [],
    total: 0,
    bytesIn: 0,
    bytesOut: 0,
    activity: [],
  });
  const label = { host: "stream.binance.com", webSocket: true };
  const connections = [ws("closed", 5), ws("live")];
  expect(connectionForSocket(socket("s", 9443), label, connections)?.id).toBe(
    "live",
  );
  expect(
    connectionForSocket(socket("s", 9443, { endTime: 9 }), label, connections)
      ?.id,
  ).toBe("closed");
  expect(
    connectionForSocket(socket("s", 443), label, connections),
  ).toBeUndefined();
});

it("builds live rows for app-reported WebSockets no profiled socket carries", () => {
  const message = (at: number, direction: "in" | "out", size: number) => ({
    seq: at,
    at,
    direction,
    size,
    binary: false,
    truncated: false,
  });
  const live = {
    key: "c1",
    id: "1",
    isolateId: "i",
    session: 1,
    url: "wss://stream.binance.com:9443/ws/ethusdt@trade",
    openedAt: 1_000,
    messages: [
      message(2_100, "in", 100),
      message(2_900, "in", 50),
      message(3_200, "out", 10),
    ],
    total: 3,
    bytesIn: 150,
    bytesOut: 10,
    activity: [
      { at: 2_000, read: 150, write: 0 },
      { at: 3_000, read: 0, write: 10 },
    ],
    lastActive: 3_200,
  };
  const { rows, labels } = helperSocketRows(
    [live, { ...live, key: "c2" }],
    new Set(["c2"]),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    address: "stream.binance.com",
    port: 9443,
    readBytes: 150,
    writeBytes: 10,
    lastActive: 3_200,
    endTime: undefined,
  });
  expect(rows[0].activity).toEqual([
    { at: 2_000, read: 150, write: 0 },
    { at: 3_000, read: 0, write: 10 },
  ]);
  expect(labels.get("c1")).toEqual({
    host: "stream.binance.com",
    webSocket: true,
  });
});
