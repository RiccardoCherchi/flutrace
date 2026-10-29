import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RpcClient, normalizeVmUrl } from "../vm/rpc.ts";
import { CloseIcon, DeviceIcon } from "./Icons.tsx";

type Session = { name: string; uri: string };
type Snapshot = {
  searching: boolean;
  message: string;
  sessions: Session[];
  dtdUris: string[];
};
const OPTIONS_KEY = "flutrace.discoveryOptions";
function storedOptions(): { sdk: string; appId: string } {
  try {
    const value = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}");
    return {
      sdk: typeof value.sdk === "string" ? value.sdk : "",
      appId: typeof value.appId === "string" ? value.appId : "",
    };
  } catch {
    return { sdk: "", appId: "" };
  }
}
/** Titlebar button with a popover. Hidden outside Tauri. */
export function Discovery({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (uri: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!isTauri()) return null;
  return (
    <div className="discovery">
      <button
        type="button"
        id="find-app"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <DeviceIcon />
        Find app
      </button>
      {open && (
        <DiscoveryPanel
          disabled={disabled}
          onSelect={(uri) => {
            onSelect(uri);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
/** Starts a search when mounted. Without onClose it renders as an inline card. */
export function DiscoveryPanel({
  disabled,
  onSelect,
  onClose,
}: {
  disabled: boolean;
  onSelect: (uri: string) => void;
  onClose?: () => void;
}) {
  const [{ sdk, appId }, setOptions] = useState(storedOptions);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [dtdSessions, setDtdSessions] = useState<Session[]>([]);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const clients = useRef(new Set<RpcClient>());
  useEffect(() => {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({ sdk, appId }));
  }, [sdk, appId]);
  useEffect(() => {
    if (starting) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const seen = new Set<string>();
    async function poll() {
      try {
        const next = await invoke<Snapshot>("discovery_snapshot");
        if (!active) return;
        setSnapshot(next);
        for (const uri of next.dtdUris) {
          if (seen.has(uri)) continue;
          seen.add(uri);
          const version = generation.current;
          void (async () => {
            let client: RpcClient | undefined;
            try {
              client = await RpcClient.connect(uri, 3000, true);
              if (!active || version !== generation.current) return;
              clients.current.add(client);
              const result = await client.call<{
                vmServices: { name?: string; uri: string }[];
              }>("ConnectedApp.getVmServices");
              const sessions: Session[] = [];
              for (const service of result.vmServices ?? []) {
                try {
                  normalizeVmUrl(service.uri);
                  sessions.push({
                    name: service.name || "Flutter session (DTD)",
                    uri: service.uri,
                  });
                } catch {
                  /* Ignore endpoints outside the local connection policy. */
                }
              }
              if (active && version === generation.current)
                setDtdSessions((previous) => [
                  ...previous,
                  ...sessions.filter(
                    (s) => !previous.some((p) => p.uri === s.uri),
                  ),
                ]);
            } catch {
              /* Stale DTD instances do not block device discovery. */
            } finally {
              client?.close();
              if (client) clients.current.delete(client);
            }
          })();
        }
      } catch {
        if (active) setError("Could not read discovery results. Try again.");
      }
      if (active) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      for (const client of clients.current) client.close();
      clients.current.clear();
    };
  }, [starting]);
  async function start() {
    generation.current++;
    setStarting(true);
    setError("");
    setDtdSessions([]);
    setSnapshot(undefined);
    try {
      await invoke("start_discovery", { sdk, appId });
    } catch {
      setError("Could not start discovery. Check your Flutter SDK folder.");
    } finally {
      setStarting(false);
    }
  }
  useEffect(() => {
    void start();
    // Search once on mount; later searches are explicit.
  }, []);
  const sessions = [...(snapshot?.sessions ?? []), ...dtdSessions].filter(
    (s, i, all) => all.findIndex((other) => other.uri === s.uri) === i,
  );
  const searching = starting || !!snapshot?.searching;
  const status =
    error ||
    (searching
      ? "Searching devices and simulators…"
      : sessions.length
        ? `${sessions.length} ${sessions.length === 1 ? "app" : "apps"} found`
        : (snapshot?.message ?? ""));
  const inline = !onClose;
  return (
    <section
      className={inline ? "discovery-card" : "discovery-panel"}
      aria-label="Find Flutter app"
    >
      <header className="discovery-heading">
        <div>
          <h2>Running Flutter apps</h2>
          <p
            className={`discovery-status ${error ? "error" : ""}`}
            role="status"
          >
            {searching && !error && <span className="spinner" />}
            {status}
          </p>
        </div>
        {inline ? (
          <button
            type="button"
            disabled={disabled || starting}
            onClick={() => void start()}
          >
            {searching ? "Restart" : "Search again"}
          </button>
        ) : (
          <button
            type="button"
            className="close-button"
            aria-label="Close discovery"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        )}
      </header>
      {sessions.length > 0 ? (
        <ul className="discovery-list">
          {sessions.map((session, index) => (
            <li key={session.uri}>
              <button
                type="button"
                className="discovery-item"
                aria-label={`Connect to ${session.name}`}
                disabled={disabled}
                onClick={() => onSelect(session.uri)}
              >
                <DeviceIcon />
                <span className="name">{session.name}</span>
                {sessions.length > 1 && (
                  <span className="index">#{index + 1}</span>
                )}
                <span className="action">Connect</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        searching &&
        !error && (
          <p className="discovery-empty">
            Simulators and emulators show up in a few seconds. Physical devices
            can take up to 45.
          </p>
        )
      )}
      <details className="discovery-options">
        <summary>Options</summary>
        <label>
          <span>Flutter SDK folder</span>
          <input
            value={sdk}
            onChange={(e) => setOptions({ sdk: e.target.value, appId })}
            placeholder="Detected automatically"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Bundle or package ID</span>
          <input
            value={appId}
            onChange={(e) => setOptions({ sdk, appId: e.target.value })}
            placeholder="com.example.app"
            spellCheck={false}
          />
        </label>
        <p>Set the ID when several apps run on the same device.</p>
      </details>
      {!inline && (
        <footer className="discovery-footer">
          <span>Not listed? Paste the VM Service URL.</span>
          <button
            type="button"
            disabled={disabled || starting}
            onClick={() => void start()}
          >
            {searching ? "Restart" : "Search again"}
          </button>
        </footer>
      )}
    </section>
  );
}
