import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { durationMs, mimeType } from "../vm/types.ts";
import { requestLocation, requestName } from "../request-list.ts";
import { DocumentIcon, FailedIcon, ImageIcon, JsonIcon } from "./Icons.tsx";
import type { Sort, SortColumn } from "../request-list.ts";
import type { RequestRow } from "../vm/types.ts";

export function formatBytes(bytes: number | undefined) {
  if (bytes === undefined || bytes < 0) return "—";
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} kB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function formatDuration(ms: number) {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function formatSpan(microseconds: number) {
  const ms = microseconds / 1000;
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
const ROW_HEIGHT = 26;
export function RequestTable({
  rows,
  sort,
  onSort,
  selectedKey,
  onSelect,
  onRowMenu,
}: {
  rows: RequestRow[];
  sort: Sort;
  onSort: (column: SortColumn) => void;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onRowMenu?: (key: string, x: number, y: number) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const element = scroll.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
    setTop(0);
  }, [sort.column, sort.direction]);
  // Like DevTools: while the list is scrolled to the end, keep new requests in view.
  const following = useRef(true);
  const newestLast = sort.column === "start" && sort.direction === "asc";
  useLayoutEffect(() => {
    const element = scroll.current;
    if (element && newestLast && following.current)
      element.scrollTop = element.scrollHeight;
  }, [rows.length, newestLast]);
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, rows.length - 1),
      Math.floor((top - ROW_HEIGHT) / ROW_HEIGHT) - 5,
    ),
  );
  const end = Math.min(
    rows.length,
    start + Math.ceil(height / ROW_HEIGHT) + 12,
  );
  const origin = rows.reduce(
    (earliest, row) => Math.min(earliest, row.startTime),
    rows[0]?.startTime ?? 0,
  );
  const finish = rows.reduce(
    (end, row) =>
      Math.max(end, row.response?.endTime ?? row.endTime ?? row.startTime),
    origin + 1000,
  );
  const span = Math.max(1000, finish - origin);
  return (
    <div
      className="table-scroll"
      ref={scroll}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current =
          element.scrollTop + element.clientHeight >=
          element.scrollHeight - ROW_HEIGHT;
        setTop(element.scrollTop);
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("thead")) return;
        if (
          (event.key === "ContextMenu" ||
            (event.key === "F10" && event.shiftKey)) &&
          selectedKey
        ) {
          event.preventDefault();
          const box = event.currentTarget
            .querySelector("tr.selected")
            ?.getBoundingClientRect();
          if (box) onRowMenu?.(selectedKey, box.left + 24, box.bottom);
          return;
        }
        if (
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
          !rows.length
        )
          return;
        event.preventDefault();
        const current = rows.findIndex((row) => row.key === selectedKey);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    current + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
        onSelect(rows[next].key);
        const element = scroll.current;
        if (
          element &&
          (next * ROW_HEIGHT < element.scrollTop ||
            (next + 2) * ROW_HEIGHT > element.scrollTop + height)
        )
          element.scrollTop = Math.max(0, next * ROW_HEIGHT - height / 2);
      }}
      tabIndex={0}
      role="region"
      aria-label="Captured requests"
    >
      <table aria-rowcount={rows.length + 1}>
        <colgroup>
          <col className="name-col" />
          <col className="method-col" />
          <col className="status-col" />
          <col className="type-col" />
          <col className="size-col" />
          <col className="time-col" />
          <col className="waterfall-col" />
        </colgroup>
        <thead>
          <tr>
            {(
              [
                ["name", "Name"],
                ["method", "Method"],
                ["status", "Status"],
                ["type", "Type"],
                ["size", "Size"],
                ["time", "Time"],
                ["start", "Waterfall"],
              ] as [SortColumn, string][]
            ).map(([column, title]) => {
              const heading = (
                <button
                  className="sort-heading"
                  aria-label={`Sort by ${title}`}
                  onClick={() => onSort(column)}
                >
                  {title}
                  <span aria-hidden="true">
                    {sort.column === column
                      ? sort.direction === "asc"
                        ? "▲"
                        : "▼"
                      : ""}
                  </span>
                </button>
              );
              return (
                <th
                  key={column}
                  className={
                    column === "size" || column === "time" ? "num" : undefined
                  }
                  aria-sort={
                    sort.column === column
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  title={
                    column === "size"
                      ? "Content-Length declared by the response, when present. Not bytes on the wire."
                      : undefined
                  }
                >
                  {column === "start" ? (
                    <div className="waterfall-heading">
                      {heading}
                      {rows.length > 0 && (
                        <span className="scale">{formatSpan(span)}</span>
                      )}
                    </div>
                  ) : (
                    heading
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={7}
                style={{ height: start * ROW_HEIGHT, padding: 0, border: 0 }}
              />
            </tr>
          )}
          {rows.slice(start, end).map((row, index) => {
            const mime = mimeType(row);
            const image = mime.startsWith("image/");
            const json = mime.includes("json");
            const failed = !!row.request?.error || !!row.response?.error;
            const statusCode = row.response?.statusCode;
            const error = failed || (statusCode ?? 0) >= 400;
            const duration = durationMs(row);
            const left = Math.max(0, ((row.startTime - origin) / span) * 100);
            const width = Math.min(
              100 - left,
              Math.max(0.6, (((duration ?? 0) * 1000) / span) * 100),
            );
            const Icon = failed
              ? FailedIcon
              : image
                ? ImageIcon
                : json
                  ? JsonIcon
                  : DocumentIcon;
            const location = requestLocation(row.uri);
            return (
              <tr
                key={row.key}
                className={`${selectedKey === row.key ? "selected" : ""} ${error ? "error-row" : ""}`}
                aria-selected={selectedKey === row.key}
                aria-rowindex={start + index + 2}
                onClick={() => onSelect(row.key)}
                onContextMenu={(event) => {
                  if (!onRowMenu) return;
                  event.preventDefault();
                  onRowMenu(row.key, event.clientX, event.clientY);
                }}
              >
                <td>
                  <button
                    className="request-name"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(row.key);
                    }}
                    title={row.uri}
                  >
                    <Icon
                      className={`file-icon ${image ? "image" : json ? "" : "other"}`}
                    />
                    <span className="label">{requestName(row.uri)}</span>
                    {location && (
                      <span className="location" aria-hidden="true">
                        {location}
                      </span>
                    )}
                  </button>
                </td>
                <td className="muted">{row.method}</td>
                <td>
                  <span
                    className={`status-code ${error ? "failure" : statusCode === undefined ? "pending" : statusCode >= 300 ? "redirect" : "ok"}`}
                  >
                    {statusCode ?? (failed ? "Failed" : "Pending")}
                  </span>
                </td>
                <td className="muted" title={mime}>
                  {mime.replace("application/", "").replace("image/", "") ||
                    "—"}
                </td>
                <td className="num muted">
                  {formatBytes(row.response?.contentLength)}
                </td>
                <td
                  className={`num ${(duration ?? 0) >= 1000 ? "slow" : "muted"}`}
                  title={
                    (duration ?? 0) >= 1000 ? "Took 1 s or longer" : undefined
                  }
                >
                  {duration === undefined ? "—" : formatDuration(duration)}
                </td>
                <td>
                  <div className="waterfall-track">
                    <span
                      className={`waterfall-bar ${image ? "image" : ""} ${error ? "failure" : ""} ${duration === undefined && !error ? "pending" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
          {end < rows.length && (
            <tr aria-hidden="true">
              <td
                colSpan={7}
                style={{
                  height: (rows.length - end) * ROW_HEIGHT,
                  padding: 0,
                  border: 0,
                }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
