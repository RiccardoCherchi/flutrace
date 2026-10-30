import { RpcClient } from "./rpc.ts";
import type { RpcTransport } from "./rpc.ts";
import type { HttpRequest, Profile, RequestRow } from "./types.ts";
import { BODY_LIMIT, makeDetail } from "./body.ts";
import type { RequestDetail } from "./body.ts";

export type Snapshot = {
  status: "disconnected" | "connecting" | "connected" | "disconnecting";
  recording: boolean;
  preserveLog: boolean;
  rows: RequestRow[];
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
        selectedKey: undefined,
        detail: undefined,
        detailError: undefined,
        detailLoading: false,
      });
      for (const [id, state] of ctx.isolates) {
        const baseline = await this.profile(ctx, id);
        state.cutoff = baseline.timestamp;
        state.cursor = baseline.timestamp;
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
        const state = {
          original: original.enabled,
          profilingOn: original.enabled,
          enableKey:
            version.major === 1 && version.minor < 4 ? "enable" : "enabled",
          cursor: start,
          cutoff: start,
        };
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
    if (!this.live(ctx) || revision !== ctx.revision) return;
    const sorted = [...rows.values()].sort(compare);
    if (sorted.length > 2000) ctx.floor = sorted[sorted.length - 2001];
    const retained = sorted.slice(-2000);
    this.emit({ rows: retained });
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
          }
          if (!state.original) await this.toggle(ctx, id, state, recording);
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
    this.clearCache();
    this.emit({
      rows: [],
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
        } catch {
          failed = true;
          state.cutoff = Number.MAX_SAFE_INTEGER;
        }
      }
      if (this.live(ctx))
        this.emit({
          rows: [],
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
        if (state.original) continue;
        try {
          await this.toggle(ctx, id, state, false);
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
