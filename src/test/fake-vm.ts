import type { RpcTransport } from "../vm/rpc.ts";
import type { HttpRequest, SocketStatistic } from "../vm/types.ts";

const prefix = "ext.dart.io.";
export function request(
  id = "r",
  isolateId = "i",
  startTime = 101,
): HttpRequest {
  return {
    id,
    isolateId,
    uri: "https://example.test/data",
    method: "GET",
    startTime,
    endTime: 102,
    response: {
      statusCode: 200,
      endTime: 103,
      headers: { "content-type": ["application/json"] },
    },
  };
}
export function socket(
  id = "s",
  startTime = 101,
  extra: Partial<SocketStatistic> = {},
): SocketStatistic {
  return {
    id,
    startTime,
    address: "93.184.216.34",
    port: 443,
    socketType: "tcp",
    readBytes: 0,
    writeBytes: 0,
    ...extra,
  };
}
export class Vm implements RpcTransport {
  isolates = ["i"];
  supported = true;
  socketsSupported = true;
  socketEnabled = new Map<string, boolean>();
  socketProfiles = new Map<string, SocketStatistic[]>();
  enabled = new Map<string, boolean>();
  profiles = new Map<string, HttpRequest[]>();
  timestamp = 100;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  closed = false;
  onClose?: () => void;
  onEvent?: (streamId: string, event: unknown) => void;
  /** Posts a `flutrace.ws` event as the app helper would. */
  ws(data: Record<string, unknown>, isolateId = "i") {
    this.onEvent?.("Extension", {
      kind: "Extension",
      extensionKind: "flutrace.ws",
      extensionData: data,
      isolate: { id: isolateId },
    });
  }
  detail: HttpRequest = { ...request(), responseBody: [123, 125] };
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    const isolate = String(params.isolateId);
    let result: unknown;
    if (method === "streamListen") result = { type: "Success" };
    else if (method === "getVM")
      result = { isolates: this.isolates.map((id) => ({ id })) };
    else if (method === "getIsolate")
      result = {
        extensionRPCs: this.supported
          ? [
              "getHttpProfile",
              "getHttpProfileRequest",
              "httpEnableTimelineLogging",
              ...(this.socketsSupported
                ? ["getSocketProfile", "socketProfilingEnabled"]
                : []),
            ].map((name) => prefix + name)
          : [],
      };
    else if (method === prefix + "getVersion") result = { major: 4, minor: 0 };
    else if (method === prefix + "httpEnableTimelineLogging") {
      if ("enabled" in params)
        this.enabled.set(isolate, params.enabled === "true");
      result = { enabled: this.enabled.get(isolate) ?? false };
    } else if (method === prefix + "getHttpProfile")
      result = {
        timestamp: this.timestamp,
        requests: this.profiles.get(isolate) ?? [],
      };
    else if (method === prefix + "getHttpProfileRequest") result = this.detail;
    else if (method === prefix + "socketProfilingEnabled") {
      if ("enabled" in params)
        this.socketEnabled.set(isolate, params.enabled === "true");
      result = { enabled: this.socketEnabled.get(isolate) ?? false };
    } else if (method === prefix + "getSocketProfile")
      result = { sockets: this.socketProfiles.get(isolate) ?? [] };
    else throw new Error("Unexpected RPC");
    return result as T;
  }
  close() {
    this.closed = true;
    this.onClose?.();
  }
}
