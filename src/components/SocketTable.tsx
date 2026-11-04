import { useEffect, useRef, useState } from "react";
import type { SocketRow } from "../vm/types.ts";
import { ROW_HEIGHT, formatBytes, visibleRange } from "./RequestTable.tsx";
import {
  formatAgo,
  formatRate,
  socketAddress,
  socketBuckets,
  socketDuration,
  socketRate,
} from "../sockets.ts";
import type { SocketLabel } from "../sockets.ts";

/** Re-renders every second so relative times stay current. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** How long a row stays marked after it moved data. */
const PULSE_MS = 1600;

export function Sparkline({
  values,
  className = "sparkline",
  label,
}: {
  values: number[];
  className?: string;
  label?: string;
}) {
  // Square root, so a handshake burst does not flatten the traffic after it.
  const scaled = values.map((value) => Math.sqrt(value));
  const max = Math.max(1, ...scaled);
  return (
    <span
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {scaled.map((value, index) => (
        <i
          key={index}
          style={{ height: `${value ? Math.max(8, (value / max) * 100) : 0}%` }}
        />
      ))}
    </span>
  );
}

export function SocketTable({
  rows,
  labels,
  selectedKey,
  onSelect,
}: {
  rows: SocketRow[];
  labels: Map<string, SocketLabel>;
  selectedKey?: string;
  onSelect: (key: string) => void;
}) {
  const now = useNow();
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
  // Only the visible slice renders, so the per-second tick stays cheap with many sockets.
  const { start, end } = visibleRange(top, height, rows.length);
  return (
    <div
      className="table-scroll"
      ref={scroll}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
      tabIndex={0}
      role="region"
      aria-label="Captured sockets"
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        if (!rows.length) return;
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
    >
      <table className="socket-table" aria-rowcount={rows.length + 1}>
        <colgroup>
          <col className="address-col" />
          <col className="socket-type-col" />
          <col className="state-col" />
          <col className="size-col" />
          <col className="size-col" />
          <col className="rate-col" />
          <col className="spark-col" />
          <col className="activity-col" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <span className="plain-heading">Name</span>
            </th>
            <th>
              <span className="plain-heading">Type</span>
            </th>
            <th>
              <span className="plain-heading">State</span>
            </th>
            <th className="num" title="Total bytes read from the socket">
              <span className="plain-heading">Read</span>
            </th>
            <th className="num" title="Total bytes written to the socket">
              <span className="plain-heading">Written</span>
            </th>
            <th
              className="num"
              title="Bytes per second received (↓) and sent (↑) over the last 3 seconds"
            >
              <span className="plain-heading">Rate</span>
            </th>
            <th title="Bytes moved per second over the last 30 seconds">
              <span className="plain-heading">Activity</span>
            </th>
            <th className="num" title="When the socket last moved bytes">
              <span className="plain-heading">Last active</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr aria-hidden="true">
              <td
                colSpan={8}
                style={{ height: start * ROW_HEIGHT, padding: 0, border: 0 }}
              />
            </tr>
          )}
          {rows.slice(start, end).map((row, index) => {
            const open = row.endTime === undefined;
            const label = labels.get(row.key);
            const rate = socketRate(row, now);
            const pulsing =
              row.lastActive !== undefined && now - row.lastActive < PULSE_MS;
            const address = socketAddress(row);
            return (
              <tr
                key={row.key}
                className={`${selectedKey === row.key ? "selected" : ""} ${pulsing ? "pulse" : ""}`}
                aria-selected={selectedKey === row.key}
                aria-rowindex={start + index + 2}
                onClick={() => onSelect(row.key)}
              >
                <td title={label ? `${label.host} (${address})` : address}>
                  <button
                    className="request-name socket-name"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(row.key);
                    }}
                  >
                    {label?.webSocket && <span className="ws-badge">WS</span>}
                    <span className="label">{label?.host ?? address}</span>
                    {label && (
                      <span className="location socket-ip">{address}</span>
                    )}
                  </button>
                </td>
                <td className="muted">{row.socketType.toUpperCase()}</td>
                <td>
                  <span className={`status-code ${open ? "ok" : "pending"}`}>
                    {open && <i className="live-dot" aria-hidden="true" />}
                    {open ? "Open" : "Closed"}
                  </span>
                </td>
                <td className="num">{formatBytes(row.readBytes)}</td>
                <td className="num">{formatBytes(row.writeBytes)}</td>
                <td className="num muted rate-cell">
                  {open && (rate.read || rate.write) ? (
                    <>
                      <span className="down">↓{formatRate(rate.read)}</span>{" "}
                      <span className="up">↑{formatRate(rate.write)}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <Sparkline values={socketBuckets(row, now)} />
                </td>
                <td className="num muted">
                  {row.lastActive === undefined
                    ? "—"
                    : formatAgo(now - row.lastActive)}
                </td>
              </tr>
            );
          })}
          {end < rows.length && (
            <tr aria-hidden="true">
              <td
                colSpan={8}
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
