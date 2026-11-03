export type Headers = Record<string, string[]>;
export type HttpData = {
  headers?: Headers;
  contentLength?: number;
  startTime?: number;
  endTime?: number;
  statusCode?: number;
  error?: string;
};
export type HttpRequest = {
  id: string;
  isolateId: string;
  method: string;
  uri: string;
  startTime: number;
  endTime?: number;
  events?: { event: string; timestamp: number }[];
  request?: HttpData;
  response?: HttpData;
  requestBody?: number[];
  responseBody?: number[];
};
export type Profile = { timestamp: number; requests: HttpRequest[] };
export type RequestRow = HttpRequest & { key: string; session: number };

export function header(headers: Headers | undefined, name: string): string {
  const value = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(value) ? value.join(", ") : "";
}
export function mimeType(request: HttpRequest): string {
  return header(request.response?.headers, "content-type")
    .split(";")[0]
    .trim()
    .toLowerCase();
}
export function isWebSocketUpgrade(request: HttpRequest): boolean {
  return request.response?.statusCode === 101;
}
/** dart:io reports "Socket has been detached" when a connection becomes a WebSocket. */
export function requestError(request: HttpRequest): string | undefined {
  const error = request.request?.error ?? request.response?.error;
  if (!error) return undefined;
  if (isWebSocketUpgrade(request) && /detached/i.test(error)) return undefined;
  return error;
}
export function durationMs(request: HttpRequest): number | undefined {
  const end =
    request.response?.endTime ??
    (request.request?.error ? request.endTime : undefined);
  return end === undefined
    ? undefined
    : Math.max(0, (end - request.startTime) / 1000);
}

/** Times are VM timeline microseconds, not wall-clock time. */
export type SocketStatistic = {
  id: string;
  startTime: number;
  endTime?: number;
  address: string;
  port: number;
  socketType: string;
  readBytes: number;
  writeBytes: number;
};
export type SocketProfile = { sockets: SocketStatistic[] };
/** Bytes moved between two polls. */
export type SocketActivity = {
  at: number;
  read: number;
  write: number;
};
export type SocketRow = SocketStatistic & {
  key: string;
  isolateId: string;
  session: number;
  activity: SocketActivity[];
  lastActive?: number;
};
export const ACTIVITY_LIMIT = 300;

/** Posted by dart/flutrace_ws.dart; the VM itself keeps no WebSocket messages. */
export const WS_EVENT_KIND = "flutrace.ws";
export type WsMessage = {
  /** Stable while older messages are dropped. */
  seq: number;
  at: number;
  direction: "in" | "out";
  size: number;
  text?: string;
  binary: boolean;
  truncated: boolean;
};
export type WsConnection = {
  key: string;
  id: string;
  isolateId: string;
  session: number;
  url: string;
  openedAt: number;
  closedAt?: number;
  closeCode?: number;
  messages: WsMessage[];
  /** Includes messages dropped by WS_MESSAGE_LIMIT. */
  total: number;
  bytesIn: number;
  bytesOut: number;
};
export const WS_MESSAGE_LIMIT = 1000;
