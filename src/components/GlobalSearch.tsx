import { useEffect, useRef, useState } from "react";
import type { RequestRow } from "../vm/types.ts";
import type { RequestDetail } from "../vm/body.ts";
import { bodyText } from "../clipboard.ts";
import { requestName } from "../request-list.ts";
import type { DetailTab } from "./RequestDetails.tsx";
import { CloseIcon, SearchIcon } from "./Icons.tsx";

type Hit = { where: string; tab: DetailTab; text: string };
type Result = { row: RequestRow; hits: Hit[] };
const HITS_PER_PLACE = 3;
const MAX_HITS = 500;

function snippet(line: string, at: number, length: number) {
  // The pane is narrow: keep the match within the first ~40 characters.
  if (at + length <= 40) return line.slice(0, 160).trim();
  const start = Math.max(0, at - 20);
  return `${start ? "…" : ""}${line.slice(start, at + length + 80).trim()}`;
}
/** Up to HITS_PER_PLACE matching lines from a block of text. */
function scan(text: string, needle: string, where: string, tab: DetailTab) {
  const hits: Hit[] = [];
  for (const line of text.split("\n")) {
    const at = line.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    hits.push({ where, tab, text: snippet(line, at, needle.length) });
    if (hits.length >= HITS_PER_PLACE) break;
  }
  return hits;
}
function headerText(headers: Record<string, string[]> | undefined) {
  return Object.entries(headers ?? {})
    .map(([name, values]) => `${name}: ${[values].flat().join(", ")}`)
    .join("\n");
}
function Marked({ text, needle }: { text: string; needle: string }) {
  const lower = text.toLowerCase();
  const parts = [];
  let from = 0;
  for (
    let at = lower.indexOf(needle);
    needle && at >= 0;
    at = lower.indexOf(needle, from)
  ) {
    parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export function GlobalSearch({
  rows,
  fetchDetail,
  onOpen,
  onClose,
}: {
  rows: RequestRow[];
  fetchDetail: (key: string) => Promise<RequestDetail | undefined>;
  onOpen: (key: string, tab: DetailTab, query: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [active, setActive] = useState(0);
  const run = useRef(0);
  const searched = useRef("");
  const list = useRef<HTMLDivElement>(null);
  async function search(text: string) {
    const id = ++run.current;
    const value = text.trim().toLowerCase();
    searched.current = value;
    setNeedle(value);
    setResults([]);
    setActive(0);
    if (!value) return setProgress(undefined);
    const found: Result[] = [];
    let total = 0;
    const snapshot = [...rows];
    for (const [index, row] of snapshot.entries()) {
      if (id !== run.current) return;
      const hits = [
        ...scan(row.uri, value, "URL", "Headers"),
        ...scan(
          headerText(row.request?.headers),
          value,
          "Request header",
          "Headers",
        ),
        ...scan(
          headerText(row.response?.headers),
          value,
          "Response header",
          "Headers",
        ),
      ];
      const detail = await fetchDetail(row.key);
      if (id !== run.current) return;
      const sent = bodyText(detail?.request);
      const received = bodyText(detail?.response);
      if (sent) hits.push(...scan(sent, value, "Request body", "Payload"));
      if (received)
        hits.push(...scan(received, value, "Response body", "Response"));
      if (hits.length) {
        found.push({ row, hits });
        total += hits.length;
      }
      if (
        index % 10 === 9 ||
        index === snapshot.length - 1 ||
        total >= MAX_HITS
      ) {
        setResults([...found]);
        setProgress({ done: index + 1, total: snapshot.length });
      }
      if (total >= MAX_HITS) break;
    }
    setProgress({ done: snapshot.length, total: snapshot.length });
  }
  useEffect(() => {
    if (query.trim().toLowerCase() === searched.current) return;
    const timer = setTimeout(() => void search(query), 250);
    return () => clearTimeout(timer);
    // Searches as you type; rows are snapshotted when each search starts.
  }, [query]);
  useEffect(() => {
    list.current
      ?.querySelector(".search-hit.active")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const hits = results.flatMap(({ row, hits }) =>
    hits.map((hit) => ({ row, hit })),
  );
  const offsets = results.map((_, index) =>
    results
      .slice(0, index)
      .reduce((sum, result) => sum + result.hits.length, 0),
  );
  function open(index: number) {
    const target = hits[index];
    if (!target) return;
    setActive(index);
    onOpen(target.row.key, target.hit.tab, needle);
  }
  const searching = !!progress && progress.done < progress.total;
  const hitCount = results.reduce((sum, result) => sum + result.hits.length, 0);
  return (
    <aside className="search-pane" aria-label="Search all requests">
      <div className="search-input">
        <SearchIcon />
        <input
          id="global-search"
          autoFocus
          aria-label="Search URLs, headers and bodies"
          placeholder="Search URLs, headers, bodies"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (query.trim().toLowerCase() !== needle || !hits.length)
                void search(query);
              else open(active);
            } else if (
              (event.key === "ArrowDown" || event.key === "ArrowUp") &&
              hits.length
            ) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              open((active + step + hits.length) % hits.length);
            } else if (event.key === "Escape") onClose();
          }}
        />
        <button
          className="close-button"
          aria-label="Close search"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="search-status" role="status">
        {searching && <span className="spinner" />}
        {!progress
          ? "Searches every captured request. Use ↑ ↓ to step through matches."
          : searching
            ? `Searching ${progress.done} of ${progress.total}…`
            : hitCount
              ? `${hitCount}${hitCount >= MAX_HITS ? "+" : ""} ${hitCount === 1 ? "match" : "matches"} in ${results.length} ${results.length === 1 ? "request" : "requests"}`
              : "No matches"}
      </p>
      <div className="search-results" ref={list}>
        {results.map(({ row, hits: rowHits }, section) => (
          <section key={row.key}>
            <h3 title={row.uri}>
              <span className="method">{row.method}</span>
              <span className="name">{requestName(row.uri)}</span>
              <span className="count">{rowHits.length}</span>
            </h3>
            {rowHits.map((hit, index) => {
              const position = offsets[section] + index;
              return (
                <button
                  key={index}
                  className={`search-hit ${position === active && progress ? "active" : ""}`}
                  onClick={() => open(position)}
                >
                  <span className="where">{hit.where}</span>
                  <code>
                    <Marked text={hit.text} needle={needle} />
                  </code>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
