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
export function durationMs(request: HttpRequest): number | undefined {
  const end =
    request.response?.endTime ??
    (request.request?.error ? request.endTime : undefined);
  return end === undefined
    ? undefined
    : Math.max(0, (end - request.startTime) / 1000);
}
