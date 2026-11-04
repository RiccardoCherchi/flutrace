import { useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import type { WsConnection, WsMessage } from "../vm/types.ts";
import { clock } from "../sockets.ts";
import { formatBytes } from "./RequestTable.tsx";
function pretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
const TOP_SLACK = 4;

export function WebSocketSetupHint() {
  return (
    <section className="detail-section ws-setup">
      <h3>See WebSocket messages live</h3>
      <p className="muted">
        The Dart VM does not record WebSocket messages, so the app reports them
        itself. Add the debug-only helper from the Flutrace README and wrap the
        socket once:
      </p>
      <pre className="ws-snippet">
        {`final socket = traceWebSocket(
  await WebSocket.connect(url),
  url,
);`}
      </pre>
      <p className="muted">
        It posts each message to the VM Service in debug builds and does nothing
        in release builds.
      </p>
    </section>
  );
}

/** Freezes the list while a message is open or the reader has scrolled down. */
export function useMessageView(connection: WsConnection | undefined) {
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [expanded, setExpanded] = useState<number>();
  const [frozen, setFrozen] = useState<{
    messages: WsMessage[];
    total: number;
  }>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = connection
    ? { messages: connection.messages, total: connection.total }
    : { messages: [], total: 0 };
  const source = frozen ?? live;
  const pending = frozen ? Math.max(0, live.total - frozen.total) : 0;
  const freeze = () => setFrozen((current) => current ?? live);
  const atTop = () => (scrollRef.current?.scrollTop ?? 0) <= TOP_SLACK;

  const shown = useMemo(() => {
    const needle = query.toLowerCase();
    const list: WsMessage[] = [];
    for (let index = source.messages.length - 1; index >= 0; index--) {
      const message = source.messages[index];
      if (direction !== "all" && message.direction !== direction) continue;
      if (needle && !message.text?.toLowerCase().includes(needle)) continue;
      list.push(message);
    }
    return list;
  }, [source.messages, query, direction]);

  return {
    connection,
    query,
    setQuery,
    direction,
    setDirection,
    expanded,
    shown,
    paused: !!frozen,
    pending,
    scrollRef,
    toggle(seq: number) {
      if (expanded === seq) {
        setExpanded(undefined);
        if (atTop()) setFrozen(undefined);
      } else {
        freeze();
        setExpanded(seq);
      }
    },
    onScroll(event: UIEvent<HTMLElement>) {
      if (event.currentTarget.scrollTop > TOP_SLACK) freeze();
      else if (expanded === undefined) setFrozen(undefined);
    },
    resume() {
      setExpanded(undefined);
      setFrozen(undefined);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    },
  };
}
export type MessageView = ReturnType<typeof useMessageView>;

export function MessagesToolbar({ view }: { view: MessageView }) {
  const connection = view.connection;
  if (!connection) return null;
  const open = connection.closedAt === undefined;
  const dropped = connection.total - connection.messages.length;
  return (
    <div className="ws-toolbar">
      <span
        className={`status-code ${open && !view.paused ? "ok" : "pending"}`}
      >
        {open && !view.paused && <i className="live-dot" aria-hidden="true" />}
        {!open
          ? `Closed${connection.closeCode ? ` (${connection.closeCode})` : ""}`
          : view.paused
            ? "Paused"
            : "Live"}
      </span>
      <span className="muted ws-count">
        {connection.total.toLocaleString()}{" "}
        {connection.total === 1 ? "message" : "messages"}
        {dropped > 0 ? ` · showing latest ${connection.messages.length}` : ""}
      </span>
      <div className="segmented small" role="group" aria-label="Direction">
        {(
          [
            ["all", "All"],
            ["in", "↓ Received"],
            ["out", "↑ Sent"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={view.direction === id}
            onClick={() => view.setDirection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        className="ws-filter"
        aria-label="Filter messages"
        placeholder="Filter messages"
        spellCheck={false}
        value={view.query}
        onChange={(event) => view.setQuery(event.target.value)}
      />
    </div>
  );
}

export function MessagesList({ view }: { view: MessageView }) {
  const connection = view.connection;
  if (!connection) return null;
  const open = connection.closedAt === undefined;
  return (
    <>
      {view.pending > 0 && (
        <button className="new-items-pill" onClick={view.resume}>
          ↑ {view.pending.toLocaleString()} new{" "}
          {view.pending === 1 ? "message" : "messages"}
        </button>
      )}
      {view.shown.length ? (
        <ol className="ws-list" aria-label="WebSocket messages">
          {view.shown.map((message) => {
            const isOpen = view.expanded === message.seq;
            return (
              <li
                key={message.seq}
                className={`ws-message ${message.direction} ${isOpen ? "expanded" : ""}`}
              >
                <button
                  className="ws-row"
                  aria-expanded={isOpen}
                  onClick={() => view.toggle(message.seq)}
                >
                  <span
                    className="ws-dir"
                    aria-label={
                      message.direction === "in" ? "Received" : "Sent"
                    }
                  >
                    {message.direction === "in" ? "↓" : "↑"}
                  </span>
                  <span className="ws-text">
                    {message.binary ? "Binary message" : (message.text ?? "")}
                  </span>
                  <span className="ws-size muted">
                    {formatBytes(message.size)}
                  </span>
                  <time className="muted">{clock(message.at, true)}</time>
                </button>
                {isOpen && !message.binary && message.text !== undefined && (
                  <pre className="ws-body">
                    {pretty(message.text)}
                    {message.truncated
                      ? "\n… (truncated by the app helper)"
                      : ""}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="detail-notice">
          {view.shown.length !== connection.messages.length &&
          connection.messages.length
            ? "No messages match the filter."
            : open
              ? "Waiting for messages…"
              : "No messages were reported for this connection."}
        </p>
      )}
    </>
  );
}

export function WebSocketMessages({
  connection,
}: {
  connection: WsConnection;
}) {
  const view = useMessageView(connection);
  return (
    <section className="ws-messages fill" aria-label="WebSocket messages pane">
      <MessagesToolbar view={view} />
      <div className="ws-scroll" ref={view.scrollRef} onScroll={view.onScroll}>
        <MessagesList view={view} />
      </div>
    </section>
  );
}
