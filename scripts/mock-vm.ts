import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import type { HttpRequest } from "../src/vm/types.ts";

const server = new WebSocketServer({ host: "127.0.0.1", port: 8189 });
const image = [
  ...readFileSync(new URL("../src-tauri/icons/icon.png", import.meta.url)),
];
let isolateId = "isolates/1";
let enabled = false;
let requests: HttpRequest[] = [];
let revision = 1;
const encode = (value: unknown) => [
  ...new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ),
];
const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// Unsigned demo token so the JWT decoder has something to show.
const token = [
  base64url({ alg: "HS256", typ: "JWT" }),
  base64url({
    sub: "user_8f3a21",
    name: "Ada Lovelace",
    scope: "catalog cart orders",
    iat: 1767225600,
    exp: 1767229200,
  }),
  "demo-signature-not-valid",
].join(".");
type Fixture = {
  method?: string;
  url: string;
  status?: number;
  at: number;
  ms?: number;
  type?: string;
  body?: unknown;
  sent?: unknown;
  error?: string;
};
const fixtures: Fixture[] = [
  {
    url: "https://api.shop.example/v2/config",
    at: 0,
    ms: 86,
    body: { minVersion: "4.2.0", features: { wishlist: true, applePay: true } },
  },
  {
    method: "POST",
    url: "https://auth.shop.example/oauth/token",
    at: 40,
    ms: 212,
    sent: { grant_type: "refresh_token", refresh_token: "rt_demo" },
    body: { access_token: token, token_type: "Bearer", expires_in: 3600 },
  },
  {
    url: "https://api.shop.example/v2/me",
    at: 270,
    ms: 64,
    body: {
      id: "user_8f3a21",
      name: "Ada Lovelace",
      tier: "gold",
      locale: "en_GB",
    },
  },
  {
    url: "https://api.shop.example/v2/products?category=sneakers&page=1&limit=20",
    at: 300,
    ms: 348,
    body: {
      page: 1,
      total: 142,
      items: Array.from({ length: 6 }, (_, n) => ({
        id: 1840 + n,
        name: [
          "Runner Pro",
          "Court Classic",
          "Trail X",
          "Air Lite",
          "Street 90",
          "Canvas Low",
        ][n],
        price: { amount: 8900 + n * 1250, currency: "EUR" },
        inStock: n !== 3,
        image: `https://cdn.shop.example/img/${1840 + n}.png`,
      })),
    },
  },
  {
    url: "https://cdn.shop.example/img/1840.png",
    at: 660,
    ms: 118,
    type: "image/png",
  },
  {
    url: "https://cdn.shop.example/img/1841.png",
    at: 668,
    ms: 22,
    status: 304,
    type: "image/png",
  },
  {
    url: "https://cdn.shop.example/img/1842.png",
    at: 671,
    ms: 131,
    type: "image/png",
  },
  {
    url: "https://api.shop.example/v2/recommendations?for=user_8f3a21",
    at: 690,
    ms: 1240,
    body: { strategy: "similar-purchases", items: [1844, 1871, 1903] },
  },
  {
    url: "https://api.shop.example/v2/promotions/spring-sale",
    at: 720,
    ms: 58,
    status: 404,
    body: { error: "not_found", message: "Promotion has ended." },
  },
  {
    method: "POST",
    url: "https://api.shop.example/v2/cart/items",
    at: 1180,
    ms: 176,
    status: 201,
    sent: { productId: 1842, size: "42", quantity: 1 },
    body: {
      cartId: "c_51d0",
      items: 3,
      subtotal: { amount: 29150, currency: "EUR" },
    },
  },
  {
    url: "https://api.shop.example/v2/cart",
    at: 1370,
    ms: 71,
    body: {
      id: "c_51d0",
      items: 3,
      subtotal: { amount: 29150, currency: "EUR" },
    },
  },
  {
    method: "POST",
    url: "https://events.shop.example/v1/batch",
    at: 1400,
    ms: 95,
    status: 204,
    sent: { events: [{ name: "add_to_cart", productId: 1842 }] },
  },
  {
    url: "https://api.shop.example/v2/orders?status=open",
    at: 1460,
    ms: 503,
    status: 500,
    body: { error: "internal", requestId: "req_7c2e" },
  },
  {
    method: "PUT",
    url: "https://api.shop.example/v2/me/preferences",
    at: 1520,
    ms: 88,
    sent: { newsletter: false },
    body: { ok: true },
  },
  {
    url: "https://api.shop.example/v2/stores/nearby?lat=45.46&lng=9.19",
    at: 1600,
    error:
      "SocketException: Connection refused (OS Error: Connection refused, errno = 61)",
  },
  { url: "https://api.shop.example/v2/inventory/1842", at: 1890 },
];
function populate() {
  const start = Date.now() * 1000;
  requests = fixtures.map((fixture, index) => {
    const begin = start + fixture.at * 1000;
    const end =
      fixture.ms === undefined ? undefined : begin + fixture.ms * 1000;
    const status =
      fixture.ms === undefined ? undefined : (fixture.status ?? 200);
    const type = fixture.type ?? "application/json; charset=utf-8";
    const bytes =
      status === undefined || status === 204 || status === 304
        ? []
        : type.startsWith("image/")
          ? image
          : encode(fixture.body ?? {});
    const sent = fixture.sent === undefined ? [] : encode(fixture.sent);
    const host = new URL(fixture.url).host;
    return {
      id: String(index),
      isolateId,
      method: fixture.method ?? "GET",
      uri: fixture.url,
      startTime: begin,
      endTime: fixture.error ? begin + 42_000 : end,
      request: {
        headers: {
          host: [host],
          "user-agent": ["Dart/3.10 (dart:io)"],
          accept: [type.startsWith("image/") ? "image/*" : "application/json"],
          "accept-encoding": ["gzip"],
          ...(host.startsWith("api.") && {
            authorization: [`Bearer ${token}`],
          }),
          ...(sent.length && { "content-type": ["application/json"] }),
        },
        contentLength: sent.length,
        ...(fixture.error && { error: fixture.error }),
      },
      response:
        status === undefined
          ? undefined
          : {
              statusCode: status,
              headers: {
                "content-type": [type],
                "cache-control": [
                  type.startsWith("image/")
                    ? "public, max-age=86400"
                    : "no-store",
                ],
                server: ["envoy"],
                "x-request-id": [`req_${(4096 + index * 977).toString(16)}`],
              },
              contentLength: bytes.length,
              startTime: begin + Math.round((fixture.ms ?? 0) * 600),
              endTime: end,
            },
      requestBody: sent,
      responseBody: bytes,
      events:
        end === undefined
          ? [{ event: "Connection established", timestamp: begin + 9000 }]
          : [
              {
                event: "Connection established",
                timestamp: begin + Math.round((fixture.ms ?? 0) * 150),
              },
              {
                event: "Request sent",
                timestamp: begin + Math.round((fixture.ms ?? 0) * 220),
              },
              {
                event: "Waiting (TTFB)",
                timestamp: begin + Math.round((fixture.ms ?? 0) * 600),
              },
              { event: "Content Download", timestamp: end },
            ],
    };
  });
}
server.on("connection", (socket) =>
  socket.on("message", (raw) => {
    const { id, method, params = {} } = JSON.parse(String(raw));
    let result: unknown;
    switch (method) {
      case "getVM":
        result = { isolates: [{ id: isolateId }] };
        break;
      case "getIsolate":
        result = {
          extensionRPCs: [
            "getVersion",
            "httpEnableTimelineLogging",
            "getHttpProfile",
            "getHttpProfileRequest",
          ].map((name) => `ext.dart.io.${name}`),
        };
        break;
      case "ext.dart.io.getVersion":
        result = { major: 4, minor: 0 };
        break;
      case "ext.dart.io.httpEnableTimelineLogging":
        if (params.enabled !== undefined) {
          enabled = params.enabled === "true";
          console.log(`Profiling ${enabled ? "enabled" : "disabled"}`);
          if (enabled) setTimeout(populate, 100);
        }
        result = { enabled };
        break;
      case "ext.dart.io.getHttpProfile":
        result = {
          timestamp: Date.now() * 1000,
          requests: requests.map(
            ({ requestBody: _a, responseBody: _b, ...ref }) => ref,
          ),
        };
        break;
      case "ext.dart.io.getHttpProfileRequest":
        result = requests.find((request) => request.id === params.id);
        break;
      default:
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Unsupported fixture RPC" },
          }),
        );
        return;
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }),
);
server.on("listening", () =>
  console.log(
    "Synthetic VM: http://127.0.0.1:8189/mock=/ — type restart to replace the isolate.",
  ),
);
process.stdin.on("data", (data) => {
  if (String(data).trim() === "restart") {
    isolateId = `isolates/${++revision}`;
    enabled = false;
    requests = [];
    console.log("Synthetic isolate restarted.");
  }
});
