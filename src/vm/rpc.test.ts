import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RpcClient, normalizeVmUrl } from "./rpc.ts";

describe("VM endpoint", () => {
  it("preserves authentication and accepts HTTP, WS, and DevTools URI links", () => {
    expect(normalizeVmUrl(" http://127.0.0.1:8181/example=/ ")).toBe(
      "ws://127.0.0.1:8181/example=/ws",
    );
    expect(normalizeVmUrl("ws://localhost:8181/example=/ws")).toBe(
      "ws://localhost:8181/example=/ws",
    );
    expect(normalizeVmUrl("https://[::1]:8181/example=/")).toBe(
      "wss://[::1]:8181/example=/ws",
    );
    expect(
      normalizeVmUrl(
        "http://127.0.0.1:9100/?uri=ws%3A%2F%2Flocalhost%3A8181%2Fa%3D%2Fws",
      ),
    ).toBe("ws://localhost:8181/a=/ws");
  });
  it.each([
    "file:///etc/passwd",
    "https://example.com/token",
    "ws://localhost.example.com/",
    "http://user:password@localhost/",
    "garbage",
    "ws://127.0.0.1:8181/?secret=x",
  ])("rejects unsafe or invalid input without echoing it: %s", (value) => {
    expect(() => normalizeVmUrl(value)).toThrow(/local VM Service URL/);
    try {
      normalizeVmUrl(value);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
});

const clients: RpcClient[] = [];
const servers: WebSocketServer[] = [];
async function server(
  handler: (method: string, id: string, send: (value: unknown) => void) => void,
) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw));
      handler(method, id, (value) =>
        socket.send(typeof value === "string" ? value : JSON.stringify(value)),
      );
    }),
  );
  const address = wss.address();
  if (typeof address === "string" || !address) throw new Error("No port");
  const client = await RpcClient.connect(
    `ws://127.0.0.1:${address.port}/ws`,
    150,
  );
  clients.push(client);
  return client;
}
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(
    servers.splice(0).map(
      (wss) =>
        new Promise<void>((resolve) => {
          wss.clients.forEach((socket) => socket.terminate());
          wss.close(() => resolve());
        }),
    ),
  );
});

it("correlates out-of-order replies and ignores notifications", async () => {
  const client = await server((method, id, send) => {
    send({ jsonrpc: "2.0", method: "streamNotify", params: {} });
    setTimeout(
      () => send({ jsonrpc: "2.0", id, result: { method } }),
      method === "first" ? 25 : 0,
    );
  });
  expect(
    await Promise.all([client.call("first"), client.call("second")]),
  ).toEqual([{ method: "first" }, { method: "second" }]);
});
it("sanitizes service errors instead of exposing captured data", async () => {
  const client = await server((_method, id, send) =>
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "private token" },
    }),
  );
  await expect(client.call("unknown")).rejects.toThrow("RPC error (-32601)");
});
it("times out unanswered calls", async () => {
  const client = await server(() => {});
  await expect(client.call("ignored")).rejects.toThrow(/timed out/);
});
it("rejects pending and future calls on disconnect", async () => {
  const client = await server(() => {});
  const pending = expect(client.call("ignored")).rejects.toThrow(/closed/);
  client.close();
  await pending;
  await expect(client.call("afterClose")).rejects.toThrow(/closed/);
});
it("closes cleanly on invalid JSON", async () => {
  const client = await server((_method, _id, send) => send("not json"));
  await expect(client.call("invalid")).rejects.toThrow(/Invalid VM response/);
});

it("preserves the DTD websocket path and rejects wrapped remote endpoints", async () => {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    path: "/dtd-token=",
  });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const client = await RpcClient.connect(
    `ws://127.0.0.1:${address.port}/dtd-token=`,
    1000,
    true,
  );
  clients.push(client);
  await expect(
    RpcClient.connect("ws://example.com/?uri=ws://localhost:123/a", 100, true),
  ).rejects.toThrow("Invalid DTD endpoint");
});
