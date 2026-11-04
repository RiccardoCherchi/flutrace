import type {
  HttpRequest,
  RequestRow,
  SocketRow,
  WsConnection,
} from "./vm/types.ts";

/** Brackets IPv6 addresses so the port stays readable. */
export function socketAddress(row: SocketRow) {
  const host = row.address.includes(":") ? `[${row.address}]` : row.address;
  return row.port ? `${host}:${row.port}` : host;
}

export type SocketLabel = {
  host: string;
  webSocket: boolean;
  /** The `101` handshake request. */
  requestKey?: string;
};

function portOf(url: URL) {
  if (url.port) return Number(url.port);
  return url.protocol === "http:" || url.protocol === "ws:" ? 80 : 443;
}

/**
 * The VM reports only the remote IP, so sockets are named after the one host that used their port.
 * Only the socket that opened closest to a `101` handshake is labelled a WebSocket, so plain
 * HTTPS sockets on the same port are not.
 */
export function labelSockets(
  sockets: SocketRow[],
  requests: RequestRow[],
): Map<string, SocketLabel> {
  const byPort = new Map<
    string,
    { hosts: Set<string>; upgrades: RequestRow[] }
  >();
  for (const request of requests) {
    let url: URL;
    try {
      url = new URL(request.uri);
    } catch {
      continue;
    }
    const id = `${request.session}:${portOf(url)}`;
    const candidate = byPort.get(id) ?? {
      hosts: new Set<string>(),
      upgrades: [],
    };
    candidate.hosts.add(url.hostname);
    if (request.response?.statusCode === 101) candidate.upgrades.push(request);
    byPort.set(id, candidate);
  }
  const eligible = new Map<string, SocketRow[]>();
  for (const socket of sockets) {
    const id = `${socket.session}:${socket.port}`;
    const candidate = byPort.get(id);
    if (
      !candidate ||
      candidate.hosts.size !== 1 ||
      socket.socketType.toLowerCase() !== "tcp"
    )
      continue;
    const list = eligible.get(id) ?? [];
    list.push(socket);
    eligible.set(id, list);
  }
  const labels = new Map<string, SocketLabel>();
  for (const [id, list] of eligible) {
    const candidate = byPort.get(id)!;
    const host = [...candidate.hosts][0];
    for (const socket of list)
      labels.set(socket.key, { host, webSocket: false });
    // Each handshake claims the nearest socket not already claimed.
    const claimed = new Set<string>();
    for (const upgrade of candidate.upgrades) {
      let best: SocketRow | undefined;
      for (const socket of list) {
        if (claimed.has(socket.key)) continue;
        if (
          !best ||
          Math.abs(socket.startTime - upgrade.startTime) <
            Math.abs(best.startTime - upgrade.startTime)
        )
          best = socket;
      }
      if (!best) continue;
      claimed.add(best.key);
      labels.set(best.key, { host, webSocket: true, requestKey: upgrade.key });
    }
  }
  return labels;
}

/** Bytes per second over the last `windowMs`. */
export function socketRate(row: SocketRow, now: number, windowMs = 3000) {
  let read = 0;
  let write = 0;
  for (let i = row.activity.length - 1; i >= 0; i--) {
    const entry = row.activity[i];
    if (now - entry.at > windowMs) break;
    read += entry.read;
    write += entry.write;
  }
  const seconds = windowMs / 1000;
  return { read: read / seconds, write: write / seconds };
}

/** Per-second byte totals, oldest first. */
export function socketBuckets(row: SocketRow, now: number, seconds = 30) {
  const buckets = Array.from({ length: seconds }, () => 0);
  for (let i = row.activity.length - 1; i >= 0; i--) {
    const entry = row.activity[i];
    const age = Math.floor((now - entry.at) / 1000);
    if (age >= seconds) break;
    if (age >= 0) buckets[seconds - 1 - age] += entry.read + entry.write;
  }
  return buckets;
}

export function socketDuration(row: SocketRow) {
  return row.endTime === undefined
    ? undefined
    : Math.max(0, (row.endTime - row.startTime) / 1000);
}

const two = (n: number) => String(n).padStart(2, "0");
/** Local wall-clock time, `HH:MM:SS` or `HH:MM:SS.mmm`. */
export function clock(ms: number, millis = false) {
  const date = new Date(ms);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  return millis
    ? `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`
    : time;
}

export function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond < 1) return "0 B/s";
  return bytesPerSecond < 1024
    ? `${bytesPerSecond.toFixed(0)} B/s`
    : bytesPerSecond < 1024 * 1024
      ? `${(bytesPerSecond / 1024).toFixed(1)} kB/s`
      : `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatAgo(ms: number) {
  if (ms < 1500) return "now";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

function endpoint(uri: string) {
  try {
    const url = new URL(uri);
    return `${url.hostname}:${portOf(url)}${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/** The connection a `101` handshake opened: same endpoint, opened closest to it. */
export function connectionForRequest(
  request: HttpRequest & { session?: number },
  connections: WsConnection[],
): WsConnection | undefined {
  const target = endpoint(request.uri);
  if (!target) return undefined;
  const started = request.startTime / 1000;
  let best: WsConnection | undefined;
  for (const connection of connections) {
    if (request.session !== undefined && connection.session !== request.session)
      continue;
    if (endpoint(connection.url) !== target) continue;
    if (
      !best ||
      Math.abs(connection.openedAt - started) <
        Math.abs(best.openedAt - started)
    )
      best = connection;
  }
  return best;
}

/** The latest connection with the socket's host, port and open state. */
export function connectionForSocket(
  socket: SocketRow,
  label: SocketLabel | undefined,
  connections: WsConnection[],
): WsConnection | undefined {
  if (!label?.webSocket) return undefined;
  const open = socket.endTime === undefined;
  const matches = connections.filter((connection) => {
    if (connection.session !== socket.session) return false;
    try {
      const url = new URL(connection.url);
      return (
        url.hostname === label.host &&
        portOf(url) === socket.port &&
        (connection.closedAt === undefined) === open
      );
    } catch {
      return false;
    }
  });
  return matches[matches.length - 1];
}

/** Rows for reported WebSockets with no profiled socket, built from their messages. */
export function helperSocketRows(
  connections: WsConnection[],
  claimed: Set<string>,
): { rows: SocketRow[]; labels: Map<string, SocketLabel> } {
  const rows: SocketRow[] = [];
  const labels = new Map<string, SocketLabel>();
  for (const connection of connections) {
    if (claimed.has(connection.key)) continue;
    let url: URL;
    try {
      url = new URL(connection.url);
    } catch {
      continue;
    }
    rows.push({
      key: connection.key,
      id: connection.id,
      isolateId: connection.isolateId,
      session: connection.session,
      address: url.hostname,
      port: portOf(url),
      socketType: "tcp",
      startTime: connection.openedAt * 1000,
      endTime:
        connection.closedAt === undefined
          ? undefined
          : connection.closedAt * 1000,
      readBytes: connection.bytesIn,
      writeBytes: connection.bytesOut,
      activity: connection.activity,
      lastActive: connection.lastActive,
    });
    labels.set(connection.key, { host: url.hostname, webSocket: true });
  }
  return { rows, labels };
}
