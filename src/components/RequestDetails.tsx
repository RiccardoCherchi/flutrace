import { useEffect, useMemo, useState, useRef } from "react";
import { useTextFind } from "./useTextFind.ts";
import type { Headers, RequestRow } from "../vm/types.ts";
import { durationMs, header, mimeType } from "../vm/types.ts";
import type { Body, RequestDetail } from "../vm/body.ts";
import { toCurl } from "../curl.ts";
import { requestName } from "../request-list.ts";
import { JsonViewer } from "./JsonTree.tsx";
import { JwtInspector } from "./JwtInspector.tsx";
import { JwtText } from "./JwtText.tsx";
import { CodeView } from "./CodeView.tsx";
import { CheckIcon, CloseIcon, CopyIcon } from "./Icons.tsx";
import { formatBytes, formatDuration } from "./RequestTable.tsx";
import { bodyText, copyText } from "../clipboard.ts";

export const tabs = [
  "Headers",
  "Query",
  "Payload",
  "Preview",
  "Response",
  "Timing",
] as const;
export type DetailTab = (typeof tabs)[number];
function CopyButton({
  text,
  initialLabel,
  title,
}: {
  text?: string;
  initialLabel: string;
  title?: string;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (label === initialLabel) return;
    const timer = setTimeout(() => setLabel(initialLabel), 1600);
    return () => clearTimeout(timer);
  }, [label, initialLabel]);
  async function copy() {
    if (text === undefined) return;
    setPending(true);
    try {
      await copyText(text);
      if (mounted.current) setLabel("Copied");
    } catch {
      if (mounted.current) setLabel("Copy failed");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <button
      className="text-button"
      disabled={text === undefined || pending || label !== initialLabel}
      onClick={copy}
      aria-live="polite"
      title={label === "Copy failed" ? "Could not copy. Try again." : title}
    >
      {label}
    </button>
  );
}
function CopyIconButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      className={`icon-button copy-icon ${state}`}
      aria-label={state === "done" ? "Copied" : label}
      title={state === "failed" ? "Could not copy. Try again." : label}
      onClick={() =>
        copyText(text).then(
          () => setState("done"),
          () => setState("failed"),
        )
      }
    >
      {state === "done" ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
function HeaderList({ title, headers }: { title: string; headers?: Headers }) {
  const entries = Object.entries(headers ?? {});
  return (
    <section className="detail-section">
      <h3>
        {title}
        {entries.length > 0 && <span className="count">{entries.length}</span>}
      </h3>
      {entries.length ? (
        <dl className="headers-list">
          {entries.map(([name, values]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <JwtText
                  text={
                    Array.isArray(values) ? values.join("\n") : String(values)
                  }
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">None reported.</p>
      )}
    </section>
  );
}
function QueryList({ uri }: { uri: string }) {
  const params = useMemo(() => {
    try {
      return [...new URL(uri).searchParams];
    } catch {
      return [];
    }
  }, [uri]);
  return (
    <section className="detail-section">
      <h3>
        Query parameters
        {params.length > 0 && <span className="count">{params.length}</span>}
      </h3>
      {params.length ? (
        <dl className="headers-list">
          {params.map(([name, value], index) => (
            <div key={index}>
              <dt>{name}</dt>
              <dd>
                {value ? (
                  <JwtText text={value} />
                ) : (
                  <span className="muted">empty</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">This URL has no query string.</p>
      )}
    </section>
  );
}
function RasterPreview({ body }: { body: Body }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<string>();
  useEffect(() => {
    if (!body.bytes || !body.imageMime) return;
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(body.bytes)], { type: body.imageMime }),
    );
    setFailed(false);
    setSize(undefined);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [body]);
  return failed ? (
    <p className="body-note">This image could not be decoded.</p>
  ) : (
    <>
      <div className="image-preview">
        {url && (
          <img
            src={url}
            alt="Captured response"
            onLoad={(event) =>
              setSize(
                `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
              )
            }
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <p className="image-meta">
        {[size, body.imageMime, formatBytes(body.bytes?.length)]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </>
  );
}
function CodeBody({
  text,
  formatted,
  mime,
  size,
  find: initialFind = "",
}: {
  text: string;
  formatted?: string;
  mime: string;
  size: number;
  find?: string;
}) {
  const [raw, setRaw] = useState(false);
  const [query, setQuery] = useState(initialFind);
  const root = useRef<HTMLDivElement>(null);
  const shown = formatted === undefined || raw ? text : formatted;
  const find = useTextFind(root, query, shown);
  return (
    <>
      <div className="body-toolbar">
        <span>
          {[
            formatted !== undefined ? "JSON" : mime || "Text",
            formatBytes(size),
          ].join(" · ")}
        </span>
        {formatted !== undefined && (
          <div
            className="segmented small"
            role="group"
            aria-label="Body format"
          >
            <button aria-pressed={!raw} onClick={() => setRaw(false)}>
              Pretty
            </button>
            <button aria-pressed={raw} onClick={() => setRaw(true)}>
              Raw
            </button>
          </div>
        )}
        <div className="body-find">
          <input
            id="body-find"
            aria-label="Find in body"
            placeholder="Find"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) find.previous();
                else find.next();
              } else if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query && (
            <span className="find-count" aria-live="polite">
              {find.count
                ? `${find.index + 1} of ${find.count}${find.capped ? "+" : ""}`
                : "No results"}
            </span>
          )}
        </div>
        <CopyButton
          text={shown}
          initialLabel="Copy"
          title={
            formatted !== undefined && !raw
              ? "Copy the body as formatted JSON"
              : "Copy the body"
          }
        />
      </div>
      <div ref={root}>
        <CodeView
          text={shown}
          mime={formatted !== undefined ? "application/json" : mime}
        />
      </div>
    </>
  );
}
function BodyView({
  body,
  preview = false,
  notModified = false,
  mime = "",
  find,
}: {
  body?: Body;
  preview?: boolean;
  notModified?: boolean;
  mime?: string;
  find?: string;
}) {
  const parsed = useMemo(() => {
    if (body?.text === undefined) return undefined;
    try {
      const value = JSON.parse(body.text);
      let formatted = body.text;
      try {
        formatted = JSON.stringify(value, null, 2);
      } catch {
        /* Deep JSON remains available as raw text. */
      }
      return { value, formatted };
    } catch {
      return undefined;
    }
  }, [body?.text]);
  if (notModified)
    return (
      <p className="body-note">
        304 Not Modified. The server sent no body because the app already has a
        cached copy.
      </p>
    );
  if (!body) return <p className="body-note">Body not loaded.</p>;
  if (body.state === "pending")
    return <p className="body-note">The body is still arriving.</p>;
  if (body.state === "omitted")
    return (
      <p className="body-note">
        Not loaded. The request or response is larger than the 2 MiB inspection
        limit.
      </p>
    );
  if (body.state === "unavailable")
    return <p className="body-note">The VM did not provide this body.</p>;
  if (!body.bytes?.length) return <p className="body-note">No body.</p>;
  if (preview && body.imageMime) return <RasterPreview body={body} />;
  const text = bodyText(body);
  const toolbar = text !== undefined && (
    <div className="body-toolbar">
      <span>
        {[
          parsed ? "JSON" : mime || "Text",
          formatBytes(body.bytes.length),
        ].join(" · ")}
      </span>
      <CopyButton
        text={text}
        initialLabel="Copy"
        title={parsed ? "Copy the body as formatted JSON" : "Copy the body"}
      />
    </div>
  );
  if (preview && parsed)
    return (
      <>
        {toolbar}
        <JsonViewer value={parsed.value} />
      </>
    );
  if (body.text !== undefined)
    return (
      <CodeBody
        text={body.text}
        formatted={parsed?.formatted}
        mime={mime}
        size={body.bytes.length}
        find={find}
      />
    );
  return (
    <p className="body-note">
      Binary body, {body.bytes.length.toLocaleString()} bytes.
      {body.imageMime
        ? " Open Preview to see the image."
        : " There is no preview for this format."}
    </p>
  );
}
function statusClass(statusCode: number | undefined, failed: boolean) {
  if (failed || (statusCode ?? 0) >= 400) return "failure";
  if (statusCode === undefined) return "pending";
  return statusCode >= 300 ? "redirect" : "ok";
}
export function RequestDetails({
  row,
  detail,
  loading,
  error,
  onClose,
  tab: controlledTab,
  onTabChange,
  find,
}: {
  row: RequestRow;
  detail?: RequestDetail;
  loading: boolean;
  error?: string;
  onClose: () => void;
  tab?: DetailTab;
  onTabChange?: (tab: DetailTab) => void;
  /** Pre-fills Find in the body, e.g. when opened from global search. */
  find?: string;
}) {
  const [ownTab, setOwnTab] = useState<DetailTab>("Headers");
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  const request = detail?.metadata ?? row;
  const curl = useMemo(() => detail && toCurl(detail), [detail]);
  const duration = durationMs(request);
  const failed = !!request.request?.error || !!request.response?.error;
  const statusCode = request.response?.statusCode;
  const path = useMemo(() => {
    try {
      const url = new URL(row.uri);
      return url.pathname + url.search;
    } catch {
      return requestName(row.uri);
    }
  }, [row.uri]);
  return (
    <JwtInspector resetKey={row.key}>
      <aside className="request-details" aria-label="Request details">
        <div className="detail-heading">
          <span className="method">{row.method}</span>
          <span className={`status-code ${statusClass(statusCode, failed)}`}>
            {statusCode ?? (failed ? "Failed" : "Pending")}
          </span>
          <span className="detail-title" title={row.uri}>
            {path}
          </span>
          <CopyIconButton key={row.key} text={row.uri} label="Copy URL" />
          <button
            className="close-button"
            aria-label="Close request details"
            title="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div
          className="detail-tabs"
          role="tablist"
          aria-label="Request detail sections"
        >
          {tabs.map((name, index) => (
            <button
              key={name}
              role="tab"
              id={`tab-${name}`}
              aria-controls="detail-panel"
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          tabs.length) %
                        tabs.length;
                setTab(tabs[next]);
                document.getElementById(`tab-${tabs[next]}`)?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div
          className="detail-content"
          id="detail-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          tabIndex={0}
        >
          {loading && (
            <p className="detail-notice" role="status">
              Loading the body…
            </p>
          )}
          {error && (
            <p className="detail-notice warning" role="status">
              {error}
            </p>
          )}
          {tab === "Headers" && (
            <>
              <section className="detail-section">
                <div className="section-heading">
                  <h3>General</h3>
                  <div className="copy-actions">
                    <CopyButton
                      key={`${row.key}:curl`}
                      text={loading ? undefined : curl}
                      initialLabel="Copy cURL"
                      title={
                        curl
                          ? "Copy request as a shell command"
                          : "Requires a complete captured request body and valid HTTP metadata"
                      }
                    />
                  </div>
                </div>
                <dl className="headers-list">
                  <div>
                    <dt>Request URL</dt>
                    <dd className="request-url">
                      <JwtText text={row.uri} />
                    </dd>
                  </div>
                  <div>
                    <dt>Method</dt>
                    <dd>{row.method}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{statusCode ?? (failed ? "Failed" : "Pending")}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>
                      {duration === undefined ? "—" : formatDuration(duration)}
                    </dd>
                  </div>
                  <div>
                    <dt>Isolate</dt>
                    <dd>{row.isolateId}</dd>
                  </div>
                </dl>
                {failed && (
                  <p className="request-error">
                    {request.request?.error ?? request.response?.error}
                  </p>
                )}
              </section>
              <HeaderList
                title="Response headers"
                headers={request.response?.headers}
              />
              <HeaderList
                title="Request headers"
                headers={request.request?.headers}
              />
            </>
          )}
          {tab === "Query" && <QueryList uri={row.uri} />}
          {tab === "Payload" && (
            <BodyView
              key={`${row.key}:request:${find ?? ""}`}
              body={detail?.request}
              find={find}
              preview
              mime={header(request.request?.headers, "content-type")}
            />
          )}
          {(tab === "Response" || tab === "Preview") && (
            <BodyView
              key={`${row.key}:response:${find ?? ""}`}
              mime={mimeType(request)}
              find={find}
              body={detail?.response}
              preview={tab === "Preview"}
              notModified={statusCode === 304}
            />
          )}
          {tab === "Timing" && (
            <section className="detail-section">
              <p className="timing-total">
                {duration === undefined
                  ? "Pending"
                  : `${duration.toFixed(1)} ms`}
                <span>total</span>
              </p>
              <dl className="timing-events">
                {(request.events ?? []).map((event, index, events) => {
                  const offset = (event.timestamp - request.startTime) / 1000;
                  const last = events.at(-1);
                  const total = Math.max(
                    duration ?? 0,
                    last ? (last.timestamp - request.startTime) / 1000 : 0,
                    1,
                  );
                  return (
                    <div key={index}>
                      <dt title={event.event}>{event.event}</dt>
                      <span className="timing-track" aria-hidden="true">
                        <span
                          style={{
                            width: `${Math.min(100, Math.max(1, (offset / total) * 100))}%`,
                          }}
                        />
                      </span>
                      <dd>{offset.toFixed(1)} ms</dd>
                    </div>
                  );
                })}
              </dl>
              <p className="muted">
                {request.events?.length
                  ? "Event times come from the Dart VM and count from the request start. Phases the VM did not report are left out."
                  : "The VM reported no timing events for this request."}
              </p>
            </section>
          )}
        </div>
      </aside>
    </JwtInspector>
  );
}
