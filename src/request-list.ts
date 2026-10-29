import { durationMs, mimeType } from "./vm/types.ts";
import type { RequestRow } from "./vm/types.ts";

export type SortColumn =
  "name" | "method" | "status" | "type" | "size" | "time" | "start";
export type Sort = { column: SortColumn; direction: "asc" | "desc" };
export function requestName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.split("/").filter(Boolean).pop() || url.hostname;
  } catch {
    return uri;
  }
}
export function requestLocation(uri: string): string {
  try {
    const url = new URL(uri);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length ? [url.host, ...segments.slice(0, -1)].join('/') : '';
  } catch { return ''; }
}
function sortValue(
  row: RequestRow,
  column: SortColumn,
): string | number | undefined {
  switch (column) {
    case "name":
      return requestName(row.uri);
    case "method":
      return row.method.toUpperCase();
    case "status":
      return row.response?.statusCode;
    case "type":
      return (
        mimeType(row).replace("application/", "").replace("image/", "") ||
        undefined
      );
    case "size":
      return (row.response?.contentLength ?? -1) < 0
        ? undefined
        : row.response?.contentLength;
    case "time":
      return durationMs(row);
    case "start":
      return row.startTime;
  }
}
export function sortRequests(rows: RequestRow[], sort: Sort): RequestRow[] {
  return [...rows].sort((a, b) => {
    const left = sortValue(a, sort.column);
    const right = sortValue(b, sort.column);
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    const difference =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), undefined, {
            numeric: true,
            sensitivity: "base",
          });
    return difference * (sort.direction === "asc" ? 1 : -1);
  });
}
export function matchesStatus(row: RequestRow, status: string): boolean {
  const error = !!row.request?.error || !!row.response?.error;
  if (status === "all") return true;
  if (status === "failed")
    return error || (row.response?.statusCode ?? 0) >= 400;
  if (status === "pending")
    return !error && row.response?.endTime === undefined;
  return (
    Math.floor((row.response?.statusCode ?? 0) / 100) === Number(status[0])
  );
}
