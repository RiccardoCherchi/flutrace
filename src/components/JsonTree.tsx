import { useState } from "react";
import { JwtText } from "./JwtText.tsx";

function expansionPlan(value: unknown) {
  const paths = new Set<string>();
  const queue = [{ value, path: "$", depth: 0 }];
  let remaining = 1000;
  let limited = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor];
    if (!node.value || typeof node.value !== "object") continue;
    const entries = Object.entries(node.value);
    const count = Math.min(entries.length, 100);
    if (node.depth >= 20 || remaining < count + 1) {
      limited = true;
      continue;
    }
    remaining -= count + 1;
    paths.add(node.path);
    if (entries.length > 100) limited = true;
    for (const [key, child] of entries.slice(0, 100)) {
      if (child && typeof child === "object")
        queue.push({
          value: child,
          path: `${node.path}[${JSON.stringify(key)}]`,
          depth: node.depth + 1,
        });
    }
  }
  return { paths, limited };
}
export function JsonViewer({ value }: { value: unknown }) {
  const [control, setControl] = useState<{
    version: number;
    paths?: Set<string>;
    limited: boolean;
  }>({ version: 0, limited: false });
  return (
    <div className="json-viewer">
      {value !== null && typeof value === "object" && (
        <div className="json-controls">
          <button
            className="text-button"
            onClick={() =>
              setControl((previous) => ({
                version: previous.version + 1,
                ...expansionPlan(value),
              }))
            }
          >
            Expand all
          </button>
          <button
            className="text-button"
            onClick={() =>
              setControl((previous) => ({
                version: previous.version + 1,
                paths: new Set(),
                limited: false,
              }))
            }
          >
            Collapse all
          </button>
        </div>
      )}
      {control.limited && (
        <p className="syntax-note">
          Large tree: Expand all opens at most 1,000 entries, 100 per branch and
          20 levels deep. Open the rest by hand.
        </p>
      )}
      <div className="json-tree">
        <JsonTree
          key={control.version}
          value={value}
          expandedPaths={control.paths}
        />
      </div>
    </div>
  );
}
export function JsonTree({
  value,
  depth = 0,
  path = "$",
  expandedPaths,
}: {
  value: unknown;
  depth?: number;
  path?: string;
  expandedPaths?: Set<string>;
}) {
  const [limit, setLimit] = useState(100);
  const [open, setOpen] = useState(
    expandedPaths ? expandedPaths.has(path) : depth < 1,
  );
  if (value === null || typeof value !== "object")
    return (
      <span className={`json-value ${typeof value}`}>
        <JwtText text={JSON.stringify(value) ?? "undefined"} />
      </span>
    );
  if (depth >= 20)
    return (
      <span className="muted">
        Too deep to show here. The Response tab has the full text.
      </span>
    );
  const entries = Object.entries(value);
  return (
    <details
      className="json-node"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {Array.isArray(value)
          ? `Array(${entries.length})`
          : `{${entries.length}}`}
      </summary>
      {open && (
        <div className="json-children">
          {entries.slice(0, limit).map(([key, item]) => (
            <div className="json-entry" key={key}>
              <span className="json-key">{key}: </span>
              <JsonTree
                value={item}
                depth={depth + 1}
                path={`${path}[${JSON.stringify(key)}]`}
                expandedPaths={expandedPaths}
              />
            </div>
          ))}
          {entries.length > limit && (
            <button
              className="text-button"
              onClick={() => setLimit(limit + 100)}
            >
              Show next 100 entries
            </button>
          )}
        </div>
      )}
    </details>
  );
}
