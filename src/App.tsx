import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, RefObject } from "react";
import brandIcon from "../assets/flutrace-icon.png";
import { Discovery, DiscoveryPanel } from "./components/Discovery.tsx";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CaptureSession } from "./vm/session.ts";
import { mimeType } from "./vm/types.ts";
import { RequestTable } from "./components/RequestTable.tsx";
import { RequestDetails, tabs } from "./components/RequestDetails.tsx";
import type { DetailTab } from "./components/RequestDetails.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import type { RequestDetail } from "./vm/body.ts";
import { Settings } from "./components/Settings.tsx";
import { themes, useAppearance } from "./theme.ts";
import {
  actions,
  comboOf,
  formatCombo,
  loadBindings,
  saveBindings,
} from "./shortcuts.ts";
import type { ActionId } from "./shortcuts.ts";
import { GlobalSearch } from "./components/GlobalSearch.tsx";
import type { Command } from "./components/CommandPalette.tsx";
import { bodyText, copyText } from "./clipboard.ts";
import { toCurl } from "./curl.ts";
import { MethodFilter } from "./components/MethodFilter.tsx";
import { matchesStatus, sortRequests } from "./request-list.ts";
import type { Sort } from "./request-list.ts";
import {
  ClearIcon,
  CloseIcon,
  FilterIcon,
  GearIcon,
  LinkIcon,
  PulseIcon,
  SearchIcon,
  WarningIcon,
} from "./components/Icons.tsx";

export const capture = new CaptureSession();
const WIDTH_KEY = "flutrace.detailWidth";
function storedWidth() {
  const width = Number(localStorage.getItem(WIDTH_KEY));
  return width >= 360
    ? Math.max(360, Math.min(width, innerWidth - 420))
    : undefined;
}
export default function App({
  session = capture,
}: {
  session?: CaptureSession;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [url, setUrl] = useState("");
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("All");
  const [methods, setMethods] = useState<string[]>([]);
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<Sort>({ column: "start", direction: "asc" });
  const availableMethods = useMemo(
    () => [
      ...new Set([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        ...methods,
        ...state.rows.map((row) => row.method.toUpperCase()),
      ]),
    ],
    [state.rows, methods],
  );
  const [busy, setBusy] = useState(false);
  const [detailWidth, setDetailWidth] = useState(storedWidth);
  const [detailTab, setDetailTab] = useState<DetailTab>("Headers");
  const [palette, setPalette] = useState(false);
  const [searching, setSearching] = useState(false);
  const [bodyFind, setBodyFind] = useState("");
  const [notice, setNotice] = useState("");
  const [rowMenu, setRowMenu] = useState<{
    key: string;
    x: number;
    y: number;
    detail?: RequestDetail;
    returnFocus: Element | null;
  }>();
  const workspace = useRef<HTMLElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const paletteReturn = useRef<Element | null>(null);
  const [settings, setSettings] = useState(false);
  const [appearance, setAppearance, resolvedMode] = useAppearance();
  const [bindings, setBindings] = useState(loadBindings);
  useEffect(() => saveBindings(bindings), [bindings]);
  const keys = (id: ActionId) =>
    bindings[id] ? formatCombo(bindings[id]) : undefined;
  useEffect(() => {
    if (detailWidth === undefined) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(detailWidth));
  }, [detailWidth]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 1800);
    return () => clearTimeout(timer);
  }, [notice]);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.target as Element | null)?.closest?.(".shortcut-recorder"))
        return;
      const combo = comboOf(event);
      const id = actions.find(
        ({ id }) => combo && bindingsRef.current[id] === combo,
      )?.id;
      if (!id || (settingsRef.current && id !== "settings")) return;
      event.preventDefault();
      if (id === "find") {
        const target =
          document.getElementById("body-find") ?? filterInput.current;
        (target as HTMLInputElement | null)?.select();
      } else if (id === "searchAll") {
        setSearching(true);
        document.getElementById("global-search")?.focus();
      } else if (id === "clear") {
        const { status } = session.getSnapshot();
        if (status !== "connecting" && status !== "disconnecting")
          void action(() => session.clear());
      } else if (id === "record") {
        const { status, recording } = session.getSnapshot();
        if (status === "connected")
          void action(() => session.setRecording(!recording));
      } else if (id === "settings") {
        setPalette(false);
        setSettings((open) => !open);
      } else {
        setPalette((open) => {
          if (!open) paletteReturn.current = document.activeElement;
          return !open;
        });
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [session]);
  const connected = state.status === "connected";
  useEffect(() => {
    // Lets flutrace-mcp attach to the app this window is inspecting.
    if (isTauri())
      invoke("publish_session", { uri: connected ? url : null }).catch(
        () => {},
      );
  }, [connected, url]);
  const transitioning =
    state.status === "connecting" || state.status === "disconnecting";
  const filtered = useMemo(
    () =>
      sortRequests(
        state.rows.filter((row) => {
          const mime = mimeType(row);
          return (
            row.uri.toLowerCase().includes(filter.toLowerCase()) &&
            (!methods.length || methods.includes(row.method.toUpperCase())) &&
            matchesStatus(row, status) &&
            (kind === "All" ||
              (kind === "JSON"
                ? mime.includes("json")
                : mime.startsWith("image/")))
          );
        }),
        sort,
      ),
    [state.rows, filter, kind, methods, status, sort],
  );
  const selected = state.rows.find((row) => row.key === state.selectedKey);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }
  const filtering =
    !!filter || kind !== "All" || !!methods.length || status !== "all";
  function connectTo(value: string) {
    setUrl(value);
    void action(() => session.connect(value));
  }
  function copy(label: string, text: string | undefined) {
    if (text === undefined) return;
    copyText(text).then(
      () => setNotice(`Copied ${label}`),
      () => setNotice("Could not copy"),
    );
  }
  function openRowMenu(key: string, x: number, y: number) {
    const returnFocus = document.activeElement;
    const ready =
      key === state.selectedKey && !state.detailLoading
        ? state.detail
        : undefined;
    setRowMenu({ key, x, y, detail: ready, returnFocus });
    if (ready) return;
    void session
      .fetchDetail(key)
      .then((detail) =>
        setRowMenu((menu) =>
          menu?.key === key && detail ? { ...menu, detail } : menu,
        ),
      );
  }
  function rowMenuItems(key: string, detail: RequestDetail | undefined) {
    const row = state.rows.find((row) => row.key === key);
    if (!row) return [];
    const curl = detail && toCurl(detail);
    const response = bodyText(detail?.response);
    const request = bodyText(detail?.request);
    let host = "";
    try {
      host = new URL(row.uri).host;
    } catch {
      /* Not a URL; the filter item stays hidden. */
    }
    return [
      { label: "Copy URL", run: () => copy("URL", row.uri) },
      {
        label: "Copy as cURL",
        disabled: curl === undefined,
        run: () => copy("cURL", curl),
      },
      {
        label: "Copy response body",
        disabled: response === undefined,
        run: () => copy("response body", response),
      },
      {
        label: "Copy request body",
        disabled: request === undefined,
        run: () => copy("request body", request),
      },
      ...(host
        ? [
            "separator" as const,
            { label: `Show only ${host}`, run: () => setFilter(host) },
          ]
        : []),
    ];
  }
  function commands(): Command[] {
    const ready = selected && state.detail && !state.detailLoading;
    const curl = ready ? toCurl(state.detail!) : undefined;
    const list: (Command | false | undefined)[] = [
      !connected &&
        !transitioning &&
        !!state.rows.length && {
          id: "find",
          group: "Session",
          title: "Find running app",
          run: () => {
            const button = document.getElementById("find-app");
            if (button?.getAttribute("aria-expanded") !== "true")
              button?.click();
          },
        },
      !connected && {
        id: "paste",
        group: "Session",
        title: "Paste VM Service URL",
        run: () => document.getElementById("vm-url")?.focus(),
      },
      connected && {
        id: "disconnect",
        group: "Session",
        title: "Disconnect",
        run: () => void action(() => session.disconnect()),
      },
      connected && {
        id: "record",
        group: "Capture",
        title: state.recording ? "Pause recording" : "Resume recording",
        shortcut: keys("record"),
        run: () => void action(() => session.setRecording(!state.recording)),
      },
      !transitioning && {
        id: "clear",
        group: "Capture",
        title: "Clear log",
        shortcut: keys("clear"),
        run: () => void action(() => session.clear()),
      },
      {
        id: "preserve",
        group: "Capture",
        title: state.preserveLog ? "Stop preserving log" : "Preserve log",
        run: () => session.setPreserveLog(!state.preserveLog),
      },
      {
        id: "filter",
        group: "Filter",
        title: "Filter by URL",
        shortcut: selected ? undefined : keys("find"),
        run: () => filterInput.current?.select(),
      },
      {
        id: "search-all",
        group: "Search",
        title: "Search all requests",
        shortcut: keys("searchAll"),
        run: () => setSearching(true),
      },
      selected && {
        id: "find-body",
        group: "Search",
        title: "Find in response body",
        shortcut: keys("find"),
        run: () => {
          setDetailTab("Response");
          setTimeout(() => document.getElementById("body-find")?.focus());
        },
      },
      filtering && {
        id: "clear-filters",
        group: "Filter",
        title: "Clear all filters",
        run: clearFilters,
      },
      ...(["All", "JSON", "Images"] as const).map(
        (type) =>
          kind !== type && {
            id: `kind-${type}`,
            group: "Filter",
            title: type === "All" ? "Show all types" : `Show ${type} only`,
            run: () => setKind(type),
          },
      ),
      status !== "failed" && {
        id: "errors",
        group: "Filter",
        title: "Show errors and failures",
        run: () => setStatus("failed"),
      },
      status !== "pending" && {
        id: "pending",
        group: "Filter",
        title: "Show pending requests",
        run: () => setStatus("pending"),
      },
      selected && {
        id: "copy-url",
        group: "Request",
        title: "Copy URL",
        run: () => copy("URL", selected.uri),
      },
      curl !== undefined && {
        id: "copy-curl",
        group: "Request",
        title: "Copy as cURL",
        run: () => copy("cURL", curl),
      },
      ready &&
        bodyText(state.detail!.response) !== undefined && {
          id: "copy-response",
          group: "Request",
          title: "Copy response body",
          run: () => copy("response body", bodyText(state.detail!.response)),
        },
      ready &&
        bodyText(state.detail!.request) !== undefined && {
          id: "copy-request",
          group: "Request",
          title: "Copy request body",
          run: () => copy("request body", bodyText(state.detail!.request)),
        },
      ...tabs.map(
        (name) =>
          selected && {
            id: `tab-${name}`,
            group: "Request",
            title: `Show ${name}`,
            run: () => setDetailTab(name),
          },
      ),
      selected && {
        id: "close",
        group: "Request",
        title: "Close details",
        run: () => void session.loadDetail(),
      },
      {
        id: "settings",
        group: "Preferences",
        title: "Open settings",
        shortcut: keys("settings"),
        run: () => setSettings(true),
      },
      ...themes.map(
        (theme) =>
          appearance.theme !== theme.id && {
            id: `theme-${theme.id}`,
            group: "Theme",
            title: theme.name,
            run: () => setAppearance({ ...appearance, theme: theme.id }),
          },
      ),
      ...(["system", "light", "dark"] as const).map(
        (mode) =>
          appearance.mode !== mode && {
            id: `mode-${mode}`,
            group: "Theme",
            title:
              mode === "system"
                ? "Match system appearance"
                : `Use ${mode} mode`,
            run: () => setAppearance({ ...appearance, mode }),
          },
      ),
      detailWidth !== undefined && {
        id: "reset-width",
        group: "View",
        title: "Reset details width",
        run: () => setDetailWidth(undefined),
      },
    ];
    return list.filter((command): command is Command => !!command);
  }
  function clearFilters() {
    setFilter("");
    setKind("All");
    setMethods([]);
    setStatus("all");
  }
  const isolates = `${state.supportedCount} ${state.supportedCount === 1 ? "isolate" : "isolates"}`;
  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img
            src={brandIcon}
            width="24"
            height="24"
            alt=""
            draggable={false}
            data-tauri-drag-region
          />
          <span data-tauri-drag-region>Flutrace</span>
        </div>
        <button
          type="button"
          className="command-center"
          onClick={() => {
            paletteReturn.current = document.activeElement;
            setPalette(true);
          }}
        >
          <SearchIcon />
          <span>Search commands</span>
          {keys("palette") && <kbd>{keys("palette")}</kbd>}
        </button>
        <form
          className="session"
          onSubmit={(event) => {
            event.preventDefault();
            if (!transitioning && !connected)
              void action(() => session.connect(url));
          }}
        >
          {connected ? (
            <>
              <span className="session-chip" role="status">
                <i className="dot online" />
                <b>Connected</b>
                <span>
                  {state.supportedCount === state.isolateCount
                    ? isolates
                    : `${isolates} of ${state.isolateCount} profiled`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void action(() => session.disconnect())}
                disabled={busy}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              {!!state.rows.length && (
                <Discovery
                  disabled={transitioning || busy}
                  onSelect={connectTo}
                />
              )}
              <div className="url-field">
                <LinkIcon />
                <input
                  id="vm-url"
                  aria-label="VM Service URL"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the VM Service URL"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={transitioning}
                />
              </div>
              <button
                className="primary"
                type="submit"
                disabled={!url.trim() || transitioning || busy}
              >
                {state.status === "disconnecting"
                  ? "Disconnecting…"
                  : transitioning
                    ? "Connecting…"
                    : "Connect"}
              </button>
            </>
          )}
        </form>
      </header>
      <div className="toolbar">
        <button
          className={`icon-button record-button ${connected && state.recording ? "recording" : ""}`}
          disabled={!connected || busy}
          onClick={() =>
            void action(() => session.setRecording(!state.recording))
          }
          aria-label={state.recording ? "Pause recording" : "Resume recording"}
          title={state.recording ? "Pause recording" : "Resume recording"}
        >
          <span className="record-glyph" aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          onClick={() => void action(() => session.clear())}
          disabled={busy || transitioning}
          aria-label="Clear"
          title="Clear the log"
        >
          <ClearIcon />
        </button>
        <span className="divider" />
        <label
          className="check-label"
          title="Keep requests across reconnects and hot restarts"
        >
          <input
            type="checkbox"
            checked={state.preserveLog}
            onChange={(event) => session.setPreserveLog(event.target.checked)}
          />
          Preserve log
        </label>
        <span className="divider" />
        <div className="filter-field">
          <SearchIcon />
          <input
            ref={filterInput}
            aria-label="Filter requests by URL"
            placeholder="Filter by URL"
            spellCheck={false}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setFilter("");
            }}
          />
          {filter && (
            <button
              className="icon-button clear-filter"
              aria-label="Clear filter"
              onClick={() => setFilter("")}
            >
              <CloseIcon />
            </button>
          )}
        </div>
        <MethodFilter
          methods={availableMethods}
          selected={methods}
          onChange={setMethods}
        />
        <select
          aria-label="Filter by status"
          data-active={status !== "all"}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">Any status</option>
          <option value="2xx">2xx Success</option>
          <option value="3xx">3xx Redirect</option>
          <option value="4xx">4xx Client error</option>
          <option value="5xx">5xx Server error</option>
          <option value="failed">Errors and failures</option>
          <option value="pending">Pending</option>
        </select>
        <div className="segmented" role="group" aria-label="Request type">
          {["All", "JSON", "Images"].map((type) => (
            <button
              key={type}
              aria-pressed={kind === type}
              onClick={() => setKind(type)}
            >
              {type}
            </button>
          ))}
        </div>
      </div>
      {state.message && (
        <div className="message-bar" role="status">
          <WarningIcon />
          {state.message}
        </div>
      )}
      <main
        className="workspace"
        ref={workspace}
        style={
          detailWidth
            ? ({ "--detail-width": `${detailWidth}px` } as CSSProperties)
            : undefined
        }
      >
        {searching && (
          <GlobalSearch
            rows={state.rows}
            fetchDetail={(key) => session.fetchDetail(key)}
            onOpen={(key, tab, query) => {
              setBodyFind(tab === "Headers" ? "" : query);
              setDetailTab(tab);
              void session.loadDetail(key);
            }}
            onClose={() => setSearching(false)}
          />
        )}
        <section className="request-pane" aria-label="Network log">
          <RequestTable
            key={`${kind}:${filter}:${methods.join(",")}:${status}`}
            rows={filtered}
            sort={sort}
            onSort={(column) =>
              setSort((previous) => ({
                column,
                direction:
                  previous.column === column && previous.direction === "asc"
                    ? "desc"
                    : "asc",
              }))
            }
            selectedKey={state.selectedKey}
            onSelect={(key) => {
              setBodyFind("");
              void session.loadDetail(key);
            }}
            onRowMenu={openRowMenu}
          />
          {!filtered.length && (
            <EmptyState
              filtered={!!state.rows.length}
              connected={connected}
              recording={state.recording}
              busy={transitioning || busy}
              onConnect={connectTo}
              onResume={() => void action(() => session.setRecording(true))}
              onClearFilters={filtering ? clearFilters : undefined}
            />
          )}
        </section>
        {selected && (
          <>
            <Splitter
              workspace={workspace}
              width={detailWidth}
              onResize={setDetailWidth}
            />
            <RequestDetails
              row={selected}
              detail={state.detail}
              loading={state.detailLoading}
              error={state.detailError}
              onClose={() => void session.loadDetail()}
              tab={detailTab}
              onTabChange={setDetailTab}
              find={bodyFind || undefined}
            />
          </>
        )}
      </main>
      <footer className="status-bar">
        <span>
          {filtered.length === state.rows.length
            ? state.rows.length.toLocaleString()
            : `${filtered.length.toLocaleString()} of ${state.rows.length.toLocaleString()}`}{" "}
          {state.rows.length === 1 ? "request" : "requests"}
        </span>
        <span className="divider" />
        <span className="recording-state">
          <i className={`dot ${connected && state.recording ? "on" : ""}`} />
          {!connected
            ? "Not connected"
            : state.recording
              ? "Recording"
              : "Paused"}
        </span>
        <span className="footer-limit">
          Keeps 2,000 requests · bodies up to 2 MiB
        </span>
        <button
          className="icon-button settings-button"
          aria-label="Settings"
          title={
            keys("settings") ? `Settings (${keys("settings")})` : "Settings"
          }
          onClick={() => setSettings(true)}
        >
          <GearIcon />
        </button>
      </footer>
      {palette && (
        <CommandPalette
          commands={commands()}
          onClose={(restore) => {
            setPalette(false);
            if (restore && paletteReturn.current instanceof HTMLElement)
              paletteReturn.current.focus();
          }}
        />
      )}
      {settings && (
        <Settings
          appearance={appearance}
          resolvedMode={resolvedMode}
          onAppearance={setAppearance}
          bindings={bindings}
          onBindings={setBindings}
          onClose={() => setSettings(false)}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenuItems(rowMenu.key, rowMenu.detail)}
          onClose={() => {
            if (rowMenu.returnFocus instanceof HTMLElement)
              rowMenu.returnFocus.focus();
            setRowMenu(undefined);
          }}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  filtered,
  connected,
  recording,
  busy,
  onConnect,
  onResume,
  onClearFilters,
}: {
  filtered: boolean;
  connected: boolean;
  recording: boolean;
  busy: boolean;
  onConnect: (uri: string) => void;
  onResume: () => void;
  onClearFilters?: () => void;
}) {
  if (filtered)
    return (
      <div className="empty-state">
        <FilterIcon className="empty-icon" />
        <h1>No requests match</h1>
        <p>Nothing in the log matches the current filters.</p>
        {onClearFilters && (
          <button onClick={onClearFilters}>Clear filters</button>
        )}
      </div>
    );
  if (connected)
    return (
      <div className="empty-state">
        <div
          className={`sonar ${recording ? "" : "paused"}`}
          aria-hidden="true"
        >
          <span />
          <span />
          <span />
          <PulseIcon />
        </div>
        <h1>{recording ? "Listening for requests" : "Recording paused"}</h1>
        <p>
          {recording
            ? "Use your app. Requests appear here as soon as they start."
            : "New requests are not captured while recording is paused."}
        </p>
        {recording ? (
          <p className="empty-hint">
            Only traffic after you connected is captured. Images loaded from the
            app’s cache may not show up.
          </p>
        ) : (
          <button onClick={onResume}>Resume recording</button>
        )}
      </div>
    );
  return (
    <div className="empty-state onboarding">
      <div className="onboarding-body">
        <h1>Connect to your Flutter app</h1>
        <p>
          Start it in debug mode with <code>flutter run</code> or from your
          editor. Flutrace reads its HTTP traffic through the Dart VM Service.
        </p>
        {isTauri() && <DiscoveryPanel disabled={busy} onSelect={onConnect} />}
        <section className="manual-connect">
          <h2>{isTauri() ? "Or paste the URL" : "Paste the VM Service URL"}</h2>
          <p>
            The debug console prints it when the app starts. Copy the
            highlighted part into the field above.
          </p>
          <pre className="console-line">
            A Dart VM Service on iPhone 17 is available at:{" "}
            <mark>http://127.0.0.1:50123/AbCdEf=/</mark>
          </pre>
          <p className="fine-print">
            A DevTools link with <code>?uri=</code> works too. The URL holds a
            session token, which Flutrace keeps in memory only.
          </p>
        </section>
      </div>
    </div>
  );
}

function Splitter({
  workspace,
  width,
  onResize,
}: {
  workspace: RefObject<HTMLElement | null>;
  width?: number;
  onResize: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("resizing", dragging);
    return () => document.documentElement.classList.remove("resizing");
  }, [dragging]);
  function clamp(next: number) {
    const total = workspace.current?.clientWidth ?? 1200;
    return Math.round(Math.min(Math.max(next, 360), total - 420));
  }
  function current() {
    return (
      width ??
      workspace.current?.querySelector<HTMLElement>(".request-details")
        ?.offsetWidth ??
      520
    );
  }
  return (
    <div
      className={`splitter ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize request details"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        // Without this the drag also starts a text selection in the panes.
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging || !workspace.current) return;
        onResize(
          clamp(
            workspace.current.getBoundingClientRect().right - event.clientX,
          ),
        );
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onResize(clamp(current() + (event.key === "ArrowLeft" ? 32 : -32)));
      }}
    />
  );
}
