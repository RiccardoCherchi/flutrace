import type { RpcTransport } from "../vm/rpc.ts";
import type { HttpRequest } from "../vm/types.ts";

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
export class Vm implements RpcTransport {
  isolates = ["i"];
  supported = true;
  enabled = new Map<string, boolean>();
  profiles = new Map<string, HttpRequest[]>();
  timestamp = 100;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  closed = false;
  onClose?: () => void;
  detail: HttpRequest = { ...request(), responseBody: [123, 125] };
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    const isolate = String(params.isolateId);
    let result: unknown;
    if (method === "getVM")
      result = { isolates: this.isolates.map((id) => ({ id })) };
    else if (method === "getIsolate")
      result = {
        extensionRPCs: this.supported
          ? [
              "getHttpProfile",
              "getHttpProfileRequest",
              "httpEnableTimelineLogging",
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
    else throw new Error("Unexpected RPC");
    return result as T;
  }
  close() {
    this.closed = true;
    this.onClose?.();
  }
}
