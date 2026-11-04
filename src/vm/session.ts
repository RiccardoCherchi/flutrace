import { RpcClient } from "./rpc.ts";
import type { RpcTransport } from "./rpc.ts";
import type {
  HttpRequest,
  Profile,
  RequestRow,
  SocketProfile,
  SocketRow,
  WsConnection,
  WsMessage,
} from "./types.ts";
import { ACTIVITY_LIMIT, WS_EVENT_KIND, WS_MESSAGE_LIMIT } from "./types.ts";
import { BODY_LIMIT, makeDetail } from "./body.ts";
import type { RequestDetail } from "./body.ts";

export type Snapshot = {
  status: "disconnected" | "connecting" | "connected" | "disconnecting";
  recording: boolean;
  preserveLog: boolean;
  rows: RequestRow[];
  sockets: SocketRow[];
  webSockets: WsConnection[];
  isolateCount: number;
  supportedCount: number;
  message: string;
  selectedKey?: string;
  detail?: RequestDetail;
  detailLoading: boolean;
  detailError?: string;
};
type Isolate = {
  original: boolean;
  profilingOn: boolean;
  enableKey: string;
  cursor: number;
  cutoff: number;
  sockets?: {
    original: boolean;
    on: boolean;
    known: Set<string>;
  };
};
type Context = {
  id: number;
  rpc: RpcTransport;
  isolates: Map<string, Isolate>;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  active: boolean;
  revision: number;
  floor?: { startTime: number; key: string };
  /** Sockets at or before this were evicted and are not rebuilt. */
  socketFloor?: { startTime: number; key: string };
  /** Wall-clock time of connecting. */
  connectedAt: number;
};
const prefix = "ext.dart.io.";
/** Completed bodies kept for search. Bounded so a long session cannot grow without limit. */
const CACHE_LIMIT = 64 * 1024 * 1024;
const detailSize = (detail: RequestDetail) =>
  (detail.request.bytes?.length ?? 0) + (detail.response.bytes?.length ?? 0);
const required = [
  "getHttpProfile",
  "getHttpProfileRequest",
  "httpEnableTimelineLogging",
];
const socketRequired = ["getSocketProfile", "socketProfilingEnabled"];
/** Allows for the device clock differing from this machine's. */
const CLOCK_SLACK_MS = 60_000;
const compare = (
  a: { startTime: number; key: string },
  b: { startTime: number; key: string },
) => a.startTime - b.startTime || a.key.localeCompare(b.key);

export class CaptureSession {
  private snapshot: Snapshot = {
    status: "disconnected",
    recording: true,
    preserveLog: false,
    rows: [],
    sockets: [],
    webSockets: [],
    isolateCount: 0,
    supportedCount: 0,
    message: "",
    detailLoading: false,
  };
  private listeners = new Set<() => void>();
  private cache = new Map<string, RequestDetail>();
  private cacheBytes = 0;
  private context?: Context;
  private generation = 0;
  private detailVersion = 0;
  private dial: (url: string) => Promise<RpcTransport>;
  private intervalMs: number;
  private history: boolean;
  private closing?: Promise<void>;
  private wsPending: {
    ctx: Context;
    isolateId: string;
    data: Record<string, unknown>;
  }[] = [];
  private wsTimer?: ReturnType<typeof setTimeout>;

  constructor(
    options: {
      connect?: (url: string) => Promise<RpcTransport>;
      intervalMs?: number;
      /** Import requests the VM recorded before connecting. */
      history?: boolean;
    } = {},
  ) {
    this.dial = options.connect ?? ((url) => RpcClient.connect(url));
    this.intervalMs = options.intervalMs ?? 1000;
    this.history = options.history ?? false;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private live(ctx: Context) {
    return ctx.active && this.context === ctx;
  }
  private enqueue(ctx: Context, task: () => Promise<void>) {
    const next = ctx.queue.then(async () => {
      if (this.live(ctx)) await task();
    });
    ctx.queue = next.catch(() => {});
    return next;
  }

  async connect(url: string) {
    await this.disconnect();
    const id = ++this.generation;
    this.emit({
      status: "connecting",
      message: "",
      recording: true,
      detail: undefined,
      selectedKey: undefined,
      detailLoading: false,
      detailError: undefined,
      rows: this.snapshot.preserveLog ? this.snapshot.rows : [],
      sockets: this.snapshot.preserveLog ? this.snapshot.sockets : [],
      webSockets: this.snapshot.preserveLog ? this.snapshot.webSockets : [],
    });
    if (!this.snapshot.preserveLog) this.clearCache();
    let rpc: RpcTransport;
    try {
      rpc = await this.dial(url);
    } catch (error) {
      if (id === this.generation)
        this.emit({
          status: "disconnected",
          message:
            error instanceof Error &&
            /^(Enter a local|Could not connect|Could not open)/.test(
              error.message,
            )
              ? error.message
              : "Could not connect to the VM Service.",
        });
      return;
    }
    if (id !== this.generation) {
      rpc.close();
      return;
    }
    const ctx: Context = {
      id,
      rpc,
      isolates: new Map(),
      queue: Promise.resolve(),
      active: true,
      revision: 0,
      connectedAt: Date.now(),
    };
    this.context = ctx;
    rpc.onClose = () => {
      if (!this.live(ctx)) return;
      ctx.active = false;
      clearTimeout(ctx.timer);
      this.context = undefined;
      ++this.detailVersion;
      this.emit({
        status: "disconnected",
        detailLoading: false,
        message:
          "Connection lost. Reconnect with the current VM URL. Profiling could not be restored.",
      });
    };
    rpc.onEvent = (streamId, event) => {
      if (streamId === "Extension" && this.live(ctx))
        this.onExtension(ctx, event);
    };
    // The Flutrace WebSocket helper posts to the Extension stream.
    await rpc.call("streamListen", { streamId: "Extension" }).catch(() => {});
    if (!this.live(ctx)) return;
    this.emit({ status: "connected" });
    await this.refresh();
    this.schedule(ctx);
  }

  private schedule(ctx: Context) {
    if (!this.live(ctx)) return;
    ctx.timer = setTimeout(async () => {
      await this.refresh();
      this.schedule(ctx);
    }, this.intervalMs);
  }

  async refresh() {
    const ctx = this.context;
    if (!ctx) return;
    await this.enqueue(ctx, () => this.poll(ctx)).catch(() => {
      if (this.live(ctx))
        this.emit({
          message:
            "Could not refresh the VM profile. Retrying; disconnect if the app is paused.",
        });
    });
  }

  private async profile(
    ctx: Context,
    isolateId: string,
    cursor?: number,
  ): Promise<Profile> {
    const result = await ctx.rpc.call<Profile>(prefix + "getHttpProfile", {
      isolateId,
      ...(cursor === undefined ? {} : { updatedSince: String(cursor) }),
    });
    if (
      !result ||
      !Number.isSafeInteger(result.timestamp) ||
      !Array.isArray(result.requests)
    )
      throw new Error("Invalid profile");
    return result;
  }

  private async poll(ctx: Context) {
    const revision = ctx.revision;
    const vm = await ctx.rpc.call<{ isolates: { id: string }[] }>("getVM");
    if (!this.live(ctx)) return;
    const currentIds = new Set(vm.isolates.map((ref) => ref.id));
    const exited = [...ctx.isolates.keys()].filter((id) => !currentIds.has(id));
    exited.forEach((id) => ctx.isolates.delete(id));
    if (exited.length && !this.snapshot.preserveLog) {
      ++this.detailVersion;
      this.emit({
        rows: [],
        sockets: [],
        webSockets: [],
        selectedKey: undefined,
        detail: undefined,
        detailError: undefined,
        detailLoading: false,
      });
      for (const [id, state] of ctx.isolates) {
        const baseline = await this.profile(ctx, id);
        state.cutoff = baseline.timestamp;
        state.cursor = baseline.timestamp;
        await this.socketBaseline(ctx, id, state);
      }
    }
    let failed = false;
    for (const isolateId of currentIds) {
      if (!this.live(ctx)) return;
      if (ctx.isolates.has(isolateId)) continue;
      try {
        const isolate = await ctx.rpc.call<{ extensionRPCs?: string[] }>(
          "getIsolate",
          { isolateId },
        );
        if (
          !required.every((name) =>
            isolate.extensionRPCs?.includes(prefix + name),
          )
        )
          continue;
        const version = await ctx.rpc.call<{ major: number; minor: number }>(
          prefix + "getVersion",
          { isolateId },
        );
        const original = await ctx.rpc.call<{ enabled: boolean }>(
          prefix + "httpEnableTimelineLogging",
          { isolateId },
        );
        const baseline = await this.profile(ctx, isolateId);
        if (typeof original.enabled !== "boolean")
          throw new Error("Invalid profiling state");
        const start = this.history ? 0 : baseline.timestamp;
        const state: Isolate = {
          original: original.enabled,
          profilingOn: original.enabled,
          enableKey:
            version.major === 1 && version.minor < 4 ? "enable" : "enabled",
          cursor: start,
          cutoff: start,
        };
        if (
          socketRequired.every((name) =>
            isolate.extensionRPCs?.includes(prefix + name),
          )
        ) {
          // Socket capture is optional: HTTP keeps working without it.
          try {
            const sockets = await ctx.rpc.call<{ enabled: boolean }>(
              prefix + "socketProfilingEnabled",
              { isolateId },
            );
            if (typeof sockets.enabled === "boolean")
              state.sockets = {
                original: sockets.enabled,
                on: sockets.enabled,
                known: new Set(),
              };
            if (!this.history) await this.socketBaseline(ctx, isolateId, state);
          } catch {
            /* Leave sockets off for this isolate. */
          }
        }
        ctx.isolates.set(isolateId, state);
      } catch {
        failed = true;
      }
    }
    for (const [id, state] of ctx.isolates) {
      if (!this.live(ctx)) return;
      const desired = state.original || this.snapshot.recording;
      if (state.profilingOn !== desired) {
        try {
          await this.toggle(ctx, id, state, desired);
        } catch {
          failed = true;
        }
      }
      const sockets = state.sockets;
      if (
        sockets &&
        sockets.on !== (sockets.original || this.snapshot.recording)
      ) {
        try {
          await this.toggleSockets(ctx, id, state, !sockets.on);
        } catch {
          failed = true;
        }
      }
    }
    if (!this.live(ctx)) return;
    this.emit({
      isolateCount: currentIds.size,
      supportedCount: ctx.isolates.size,
      message: failed
        ? "Some isolates are unavailable; retrying."
        : ctx.isolates.size
          ? ""
          : "Waiting for an isolate with HTTP profiling support. Flutter web and release builds are not supported.",
    });
    if (!this.snapshot.recording) return;
    const rows = new Map(this.snapshot.rows.map((row) => [row.key, row]));
    const previousSelected = this.snapshot.rows.find(
      (row) => row.key === this.snapshot.selectedKey,
    );
    for (const [isolateId, state] of ctx.isolates) {
      try {
        const profile = await this.profile(ctx, isolateId, state.cursor);
        if (!this.live(ctx)) return;
        state.cursor = profile.timestamp;
        for (const raw of profile.requests) {
          if (
            !raw ||
            typeof raw.id !== "string" ||
            typeof raw.uri !== "string" ||
            typeof raw.method !== "string" ||
            !Number.isSafeInteger(raw.startTime)
          )
            continue;
          const {
            requestBody: _requestBody,
            responseBody: _responseBody,
            ...metadata
          } = raw;
          const row: RequestRow = {
            ...metadata,
            isolateId,
            key: `${ctx.id}:${isolateId}:${raw.id}`,
            session: ctx.id,
          };
          if (raw.startTime <= state.cutoff && !rows.has(row.key)) continue;
          if (!rows.has(row.key) && ctx.floor && compare(row, ctx.floor) <= 0)
            continue;
          rows.set(row.key, row);
        }
      } catch {
        if (this.live(ctx))
          this.emit({
            message:
              "An isolate could not be read. Retrying on the next update.",
          });
      }
    }
    const sockets = await this.pollSockets(ctx);
    if (!this.live(ctx) || revision !== ctx.revision) return;
    const sorted = [...rows.values()].sort(compare);
    if (sorted.length > 2000) ctx.floor = sorted[sorted.length - 2001];
    const retained = sorted.slice(-2000);
    this.emit({ rows: retained, sockets });
    const selected = retained.find(
      (row) => row.key === this.snapshot.selectedKey,
    );
    if (this.snapshot.selectedKey && !selected) {
      await this.loadDetail();
      return;
    }
    if (
      selected &&
      previousSelected &&
      (selected.endTime !== previousSelected.endTime ||
        selected.response?.endTime !== previousSelected.response?.endTime)
    ) {
      const version = ++this.detailVersion;
      this.emit({ detailLoading: true });
      await this.readDetail(ctx, selected, version);
    }
  }

  private async toggle(
    ctx: Context,
    isolateId: string,
    state: Isolate,
    enabled: boolean,
  ) {
    const result = await ctx.rpc.call<{ enabled: boolean }>(
      prefix + "httpEnableTimelineLogging",
      { isolateId, [state.enableKey]: String(enabled) },
    );
    if (result.enabled !== enabled)
      throw new Error("Profiling state was not applied");
    state.profilingOn = enabled;
  }

  private async toggleSockets(
    ctx: Context,
    isolateId: string,
    state: Isolate,
    enabled: boolean,
  ) {
    if (!state.sockets) return;
    const result = await ctx.rpc.call<{ enabled: boolean }>(
      prefix + "socketProfilingEnabled",
      { isolateId, enabled: String(enabled) },
    );
    if (result.enabled !== enabled)
      throw new Error("Socket profiling state was not applied");
    state.sockets.on = enabled;
  }

  /** Marks the sockets already in the profile as seen. */
  private async socketBaseline(
    ctx: Context,
    isolateId: string,
    state: Isolate,
  ) {
    if (!state.sockets) return;
    try {
      const profile = await ctx.rpc.call<SocketProfile>(
        prefix + "getSocketProfile",
        { isolateId },
      );
      if (Array.isArray(profile?.sockets))
        state.sockets.known = new Set(
          profile.sockets.map((socket) => String(socket?.id)),
        );
    } catch {
      /* Keep the previous boundary. */
    }
  }

  /** The VM has no cursor for sockets, so each poll reads the full profile. */
  private async pollSockets(ctx: Context): Promise<SocketRow[]> {
    const now = Date.now();
    const rows = new Map(this.snapshot.sockets.map((row) => [row.key, row]));
    for (const [isolateId, state] of ctx.isolates) {
      if (!state.sockets?.on || !this.live(ctx)) continue;
      try {
        const profile = await ctx.rpc.call<SocketProfile>(
          prefix + "getSocketProfile",
          { isolateId },
        );
        if (!Array.isArray(profile?.sockets)) continue;
        for (const raw of profile.sockets) {
          if (
            !raw ||
            (typeof raw.id !== "string" && typeof raw.id !== "number") ||
            !Number.isSafeInteger(raw.startTime)
          )
            continue;
          // Older VMs report numeric ids.
          const key = `${ctx.id}:${isolateId}:${String(raw.id)}`;
          if (state.sockets.known.has(String(raw.id)) && !rows.has(key))
            continue;
          if (
            !rows.has(key) &&
            ctx.socketFloor &&
            compare({ startTime: raw.startTime, key }, ctx.socketFloor) <= 0
          )
            continue;
          const previous = rows.get(key);
          const readBytes = Number(raw.readBytes) || 0;
          const writeBytes = Number(raw.writeBytes) || 0;
          const read = Math.max(0, readBytes - (previous?.readBytes ?? 0));
          const write = Math.max(0, writeBytes - (previous?.writeBytes ?? 0));
          const moved = read > 0 || write > 0;
          let activity = previous?.activity ?? [];
          if (moved) {
            activity = [...activity, { at: now, read, write }];
            if (activity.length > ACTIVITY_LIMIT)
              activity = activity.slice(-ACTIVITY_LIMIT);
          }
          rows.set(key, {
            ...raw,
            id: String(raw.id),
            address: String(raw.address ?? ""),
            socketType: String(raw.socketType ?? "tcp"),
            readBytes,
            writeBytes,
            key,
            isolateId,
            session: ctx.id,
            activity,
            lastActive: moved ? now : previous?.lastActive,
          });
        }
      } catch {
        /* Keep the previous socket rows. */
      }
    }
    const sorted = [...rows.values()].sort(compare);
    if (sorted.length > 2000) ctx.socketFloor = sorted[sorted.length - 2001];
    return sorted.slice(-2000);
  }

  private onExtension(ctx: Context, event: unknown) {
    const value = event as {
      extensionKind?: string;
      extensionData?: Record<string, unknown>;
      isolate?: { id?: string };
    };
    if (value?.extensionKind !== WS_EVENT_KIND || !value.extensionData) return;
    // A close still applies while paused, or the connection would look open forever.
    if (!this.snapshot.recording && value.extensionData.type !== "close")
      return;
    // DDS replays the stream's history to new listeners; skip what predates connecting.
    if (Number(value.extensionData.at) < ctx.connectedAt - CLOCK_SLACK_MS)
      return;
    this.wsPending.push({
      ctx,
      isolateId: String(value.isolate?.id ?? ""),
      data: value.extensionData,
    });
    // One update per burst keeps fast streams smooth.
    this.wsTimer ??= setTimeout(() => this.flushWebSockets(), 100);
  }

  private flushWebSockets() {
    this.wsTimer = undefined;
    const pending = this.wsPending.splice(0);
    const byKey = new Map(this.snapshot.webSockets.map((c) => [c.key, c]));
    // Connections already copied in this flush, so a burst mutates one copy.
    const copied = new Set<string>();
    let changed = false;
    for (const { ctx, isolateId, data } of pending) {
      if (!this.live(ctx)) continue;
      const id = String(data.id ?? "");
      if (!id) continue;
      const key = `${ctx.id}:${isolateId}:ws:${id}`;
      const at = Number(data.at) || Date.now();
      let connection = byKey.get(key);
      if (data.type === "open" || !connection) {
        if (data.type !== "open" && data.type !== "message") continue;
        if (!connection) {
          connection = {
            key,
            id,
            isolateId,
            session: ctx.id,
            url: String(data.url ?? ""),
            openedAt: at,
            messages: [],
            total: 0,
            bytesIn: 0,
            bytesOut: 0,
            activity: [],
          };
          copied.add(key);
        }
        if (data.type === "open") {
          byKey.set(key, connection);
          changed = true;
          continue;
        }
      }
      if (data.type !== "message" && data.type !== "close") continue;
      if (!copied.has(key)) {
        connection = {
          ...connection,
          messages: [...connection.messages],
          activity: [...connection.activity],
        };
        copied.add(key);
      }
      if (data.type === "message") {
        const message: WsMessage = {
          seq: connection.total,
          at,
          direction: data.direction === "out" ? "out" : "in",
          size: Number(data.size) || 0,
          text: typeof data.text === "string" ? data.text : undefined,
          binary: data.binary === true,
          truncated: data.truncated === true,
        };
        connection.messages.push(message);
        if (connection.messages.length > WS_MESSAGE_LIMIT)
          connection.messages.shift();
        connection.total += 1;
        if (message.direction === "in") connection.bytesIn += message.size;
        else connection.bytesOut += message.size;
        const second = Math.floor(at / 1000) * 1000;
        const last = connection.activity[connection.activity.length - 1];
        if (last?.at === second) {
          // Replace the entry: the previous snapshot may still share it.
          connection.activity[connection.activity.length - 1] = {
            at: second,
            read: last.read + (message.direction === "in" ? message.size : 0),
            write:
              last.write + (message.direction === "out" ? message.size : 0),
          };
        } else {
          connection.activity.push({
            at: second,
            read: message.direction === "in" ? message.size : 0,
            write: message.direction === "out" ? message.size : 0,
          });
          if (connection.activity.length > ACTIVITY_LIMIT)
            connection.activity.shift();
        }
        connection.lastActive = at;
      } else {
        connection.closedAt = at;
        connection.closeCode = Number.isInteger(data.code)
          ? Number(data.code)
          : undefined;
      }
      byKey.set(key, connection);
      changed = true;
    }
    if (changed)
      this.emit({
        webSockets: [...byKey.values()]
          .sort((a, b) => a.openedAt - b.openedAt)
          .slice(-200),
      });
  }

  async setRecording(recording: boolean) {
    const ctx = this.context;
    if (!ctx) return;
    ++ctx.revision;
    await this.enqueue(ctx, async () => {
      let failed = false;
      for (const [id, state] of ctx.isolates) {
        try {
          if (recording) {
            const baseline = await this.profile(ctx, id);
            state.cutoff = baseline.timestamp;
            state.cursor = baseline.timestamp;
            await this.socketBaseline(ctx, id, state);
          }
          if (!state.original) await this.toggle(ctx, id, state, recording);
          if (state.sockets && !state.sockets.original)
            await this.toggleSockets(ctx, id, state, recording);
        } catch {
          failed = true;
        }
      }
      if (this.live(ctx))
        this.emit({
          recording,
          message: failed
            ? "Could not change profiling on every isolate. Disconnect and reconnect to retry."
            : "",
        });
    });
  }

  async clear() {
    ++this.detailVersion;
    // Messages queued before Clear must not reappear after it.
    this.wsPending.length = 0;
    this.clearCache();
    this.emit({
      rows: [],
      sockets: [],
      webSockets: [],
      selectedKey: undefined,
      detail: undefined,
      detailLoading: false,
      detailError: undefined,
    });
    const ctx = this.context;
    if (!ctx) return;
    ++ctx.revision;
    await this.enqueue(ctx, async () => {
      let failed = false;
      for (const [id, state] of ctx.isolates) {
        try {
          const profile = await this.profile(ctx, id);
          state.cutoff = profile.timestamp;
          state.cursor = profile.timestamp;
          await this.socketBaseline(ctx, id, state);
        } catch {
          failed = true;
          state.cutoff = Number.MAX_SAFE_INTEGER;
        }
      }
      if (this.live(ctx))
        this.emit({
          rows: [],
          sockets: [],
          webSockets: [],
          message: failed
            ? "Could not establish a clear boundary. Reconnect to resume capture."
            : "",
        });
    });
  }

  setPreserveLog(preserveLog: boolean) {
    this.emit({ preserveLog });
  }

  async loadDetail(key?: string) {
    const version = ++this.detailVersion;
    this.emit({
      selectedKey: key,
      detail: undefined,
      detailLoading: !!key,
      detailError: undefined,
    });
    if (!key) return;
    const ctx = this.context;
    const row = this.snapshot.rows.find((row) => row.key === key);
    if (
      !ctx ||
      !this.live(ctx) ||
      !row ||
      row.session !== ctx.id ||
      !ctx.isolates.has(row.isolateId)
    ) {
      this.emit({
        detailLoading: false,
        detailError:
          "Body unavailable: this request belongs to an ended session or isolate.",
      });
      return;
    }
    await this.enqueue(ctx, () => this.readDetail(ctx, row, version));
  }

  private async readDetail(ctx: Context, row: RequestRow, version: number) {
    const current = () => this.live(ctx) && version === this.detailVersion;
    if (!current()) return;
    try {
      const detail = await this.fetch(ctx, row);
      if (current())
        this.emit({ detail, detailLoading: false, detailError: undefined });
    } catch {
      if (current())
        this.emit({
          detailLoading: false,
          detailError:
            "Body unavailable. The request may have expired or the isolate restarted.",
        });
    }
  }

  private async fetch(ctx: Context, row: RequestRow): Promise<RequestDetail> {
    const cached = this.cache.get(row.key);
    if (cached) return cached;
    if (
      (row.request?.contentLength ?? 0) > BODY_LIMIT ||
      (row.response?.contentLength ?? 0) > BODY_LIMIT
    )
      return {
        metadata: row,
        request: { state: "omitted" },
        response: { state: "omitted" },
      };
    const result = await ctx.rpc.call<HttpRequest>(
      prefix + "getHttpProfileRequest",
      { isolateId: row.isolateId, id: row.id },
    );
    const detail = makeDetail(result);
    if (
      detail.request.state !== "pending" &&
      detail.response.state !== "pending"
    ) {
      this.cache.set(row.key, detail);
      this.cacheBytes += detailSize(detail);
      for (const [key, old] of this.cache) {
        if (this.cacheBytes <= CACHE_LIMIT) break;
        this.cache.delete(key);
        this.cacheBytes -= detailSize(old);
      }
    }
    return detail;
  }

  private clearCache() {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /** Loads a request's bodies without changing the selection. Used by global search. */
  async fetchDetail(key: string): Promise<RequestDetail | undefined> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const ctx = this.context;
    const row = this.snapshot.rows.find((row) => row.key === key);
    if (!ctx || !this.live(ctx) || !row || row.session !== ctx.id) return;
    if (!ctx.isolates.has(row.isolateId)) return;
    let detail: RequestDetail | undefined;
    await this.enqueue(ctx, async () => {
      try {
        if (this.live(ctx)) detail = await this.fetch(ctx, row);
      } catch {
        /* Expired requests are skipped by search. */
      }
    });
    return detail;
  }

  async disconnect() {
    ++this.generation;
    ++this.detailVersion;
    if (this.closing) return this.closing;
    const ctx = this.context;
    if (!ctx) {
      this.emit({ status: "disconnected", detailLoading: false });
      return;
    }
    ctx.active = false;
    clearTimeout(ctx.timer);
    ctx.rpc.onClose = undefined;
    this.emit({ status: "disconnecting", detailLoading: false });
    this.closing = (async () => {
      await ctx.queue;
      let failed = false;
      for (const [id, state] of ctx.isolates) {
        try {
          if (!state.original) await this.toggle(ctx, id, state, false);
          if (state.sockets && !state.sockets.original && state.sockets.on)
            await this.toggleSockets(ctx, id, state, false);
        } catch {
          failed = true;
        }
      }
      ctx.rpc.close();
      this.context = undefined;
      this.emit({
        status: "disconnected",
        supportedCount: 0,
        isolateCount: 0,
        message: failed
          ? "Disconnected. Profiling could not be restored on every isolate."
          : "",
      });
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }
}
