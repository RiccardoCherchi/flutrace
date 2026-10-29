import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "./Icons.tsx";

export type Command = {
  id: string;
  group: string;
  title: string;
  shortcut?: string;
  run: () => void;
};

/** Case-insensitive subsequence match. Returns matched indices and a score, lower is better. */
function match(query: string, text: string) {
  const indices: number[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (const char of query.toLowerCase().replace(/\s+/g, "")) {
    const index = lower.indexOf(char, from);
    if (index < 0) return undefined;
    indices.push(index);
    from = index + 1;
  }
  const gaps = indices.reduce(
    (sum, index, i) => sum + (i ? index - indices[i - 1] - 1 : index),
    0,
  );
  return { indices, score: gaps };
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: (restoreFocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const results = useMemo(
    () =>
      commands
        .map((command) => ({
          command,
          label: `${command.group}: ${command.title}`,
          hit: match(query, `${command.group}: ${command.title}`),
        }))
        .filter((result) => result.hit)
        .sort((a, b) => (query ? a.hit!.score - b.hit!.score : 0)),
    [commands, query],
  );
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  function run(command: Command) {
    onClose(false);
    command.run();
  }
  return (
    <div className="palette-backdrop" onMouseDown={() => onClose(true)}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <SearchIcon />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              results[active]
                ? `command-${results[active].command.id}`
                : undefined
            }
            placeholder="Type a command"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose(true);
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive(
                  (index) =>
                    (index + step + results.length) %
                    Math.max(1, results.length),
                );
              } else if (event.key === "Enter" && results[active]) {
                event.preventDefault();
                run(results[active].command);
              }
            }}
          />
        </div>
        {results.length ? (
          <ul
            className="palette-list"
            id="palette-list"
            role="listbox"
            ref={list}
          >
            {results.map(({ command, label, hit }, index) => {
              const marked = new Set(hit!.indices);
              return (
                <li
                  key={command.id}
                  id={`command-${command.id}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(command)}
                >
                  <span className="label">
                    {[...label].map((char, i) =>
                      marked.has(i) ? <mark key={i}>{char}</mark> : char,
                    )}
                  </span>
                  {command.shortcut && <kbd>{command.shortcut}</kbd>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="palette-empty">No matching commands</p>
        )}
        <footer className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
