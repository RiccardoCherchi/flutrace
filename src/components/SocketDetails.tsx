import type { SocketRow, WsConnection } from "../vm/types.ts";
import {
  MessagesList,
  MessagesToolbar,
  WebSocketSetupHint,
  useMessageView,
} from "./WebSocketMessages.tsx";
import type { SocketLabel } from "../sockets.ts";
import {
  formatAgo,
  formatRate,
  socketAddress,
  socketBuckets,
  socketRate,
} from "../sockets.ts";
import { CloseIcon } from "./Icons.tsx";
import { formatBytes, formatDuration } from "./RequestTable.tsx";
import { Sparkline, socketDuration, useNow } from "./SocketTable.tsx";

const two = (n: number) => String(n).padStart(2, "0");
function clock(ms: number) {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

export function SocketDetails({
  row,
  label,
  onClose,
  onShowRequest,
  connection,
}: {
  row: SocketRow;
  label?: SocketLabel;
  connection?: WsConnection;
  onClose: () => void;
  onShowRequest?: (key: string) => void;
}) {
  const now = useNow();
  const open = row.endTime === undefined;
  const rate = socketRate(row, now);
  const duration = socketDuration(row);
  const address = socketAddress(row);
  const recent = row.activity.slice(-200).reverse();
  const view = useMessageView(connection);
  const messages = !!label?.webSocket && !!connection;
  return (
    <aside
      className="request-details socket-details"
      aria-label="Socket details"
    >
      <div className="detail-heading">
        {label?.webSocket && <span className="ws-badge">WS</span>}
        <span className={`status-code ${open ? "ok" : "pending"}`}>
          {open ? "Open" : "Closed"}
        </span>
        <span className="detail-title" title={address}>
          {label?.host ?? address}
        </span>
        <button
          className="close-button"
          aria-label="Close socket details"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="socket-pinned">
        <section className="detail-section">
          <h3>Connection</h3>
          <dl className="headers-list">
            <div>
              <dt>Remote address</dt>
              <dd>{address}</dd>
            </div>
            {label && (
              <div>
                <dt>Host</dt>
                <dd>
                  {label.host}
                  {label.webSocket ? " (WebSocket)" : ""}
                </dd>
              </div>
            )}
            <div>
              <dt>Protocol</dt>
              <dd>{row.socketType.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{formatBytes(row.readBytes)}</dd>
            </div>
            <div>
              <dt>Sent</dt>
              <dd>{formatBytes(row.writeBytes)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {duration === undefined
                  ? "Still open"
                  : formatDuration(duration)}
              </dd>
            </div>
            <div>
              <dt>Last active</dt>
              <dd>
                {row.lastActive === undefined
                  ? "No traffic since capture started"
                  : formatAgo(now - row.lastActive)}
              </dd>
            </div>
          </dl>
          {label?.requestKey && onShowRequest && (
            <button
              className="socket-request-link"
              title="The HTTP GET that opened this WebSocket; the server answered 101 Switching Protocols"
              onClick={() => onShowRequest(label.requestKey!)}
            >
              View handshake request
            </button>
          )}
        </section>
        {messages && <MessagesToolbar view={view} />}
      </div>
      <div
        className="detail-content socket-scroll"
        ref={view.scrollRef}
        onScroll={messages ? view.onScroll : undefined}
      >
        {messages ? (
          <section className="ws-messages" aria-label="WebSocket messages pane">
            <MessagesList view={view} />
          </section>
        ) : (
          label?.webSocket && <WebSocketSetupHint />
        )}
        <section className="detail-section">
          <div className="section-heading">
            <h3>Throughput</h3>
            <span className="muted socket-rate">
              ↓{formatRate(rate.read)} · ↑{formatRate(rate.write)}
            </span>
          </div>
          <Sparkline
            className="sparkline large"
            values={socketBuckets(row, now, 60)}
            label="Bytes moved per second over the last minute"
          />
          <div className="sparkline-scale muted">
            <span>60 s ago</span>
            <span>now</span>
          </div>
        </section>
        <section className="detail-section">
          <h3>
            Activity <span className="count">{row.activity.length}</span>
          </h3>
          <p className="muted socket-note">
            The Dart VM reports byte counts, not message contents. Each line is
            one update (about once a second) in which data moved.
          </p>
          {recent.length ? (
            <ol className="socket-activity">
              {recent.map((entry, index) => (
                <li key={`${entry.at}:${index}`}>
                  <time>{clock(entry.at)}</time>
                  <span className="down">
                    {entry.read ? `↓ ${formatBytes(entry.read)}` : ""}
                  </span>
                  <span className="up">
                    {entry.write ? `↑ ${formatBytes(entry.write)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No data has moved on this socket yet.</p>
          )}
        </section>
      </div>
    </aside>
  );
}
