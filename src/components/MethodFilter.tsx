import { useEffect, useRef } from "react";

export function MethodFilter({
  methods,
  selected,
  onChange,
}: {
  methods: string[];
  selected: string[];
  onChange: (methods: string[]) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        ref.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  return (
    <details
      className="method-filter"
      data-active={selected.length > 0}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current) {
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        {selected.length ? `Methods (${selected.length})` : "Methods"}
      </summary>
      <div className="method-options" aria-label="HTTP method filters">
        <button
          className="text-button"
          aria-pressed={selected.length === 0}
          onClick={() => onChange([])}
        >
          All methods
        </button>
        {methods.map((method) => (
          <label className="check-label" key={method}>
            <input
              type="checkbox"
              checked={selected.includes(method)}
              onChange={() =>
                onChange(
                  selected.includes(method)
                    ? selected.filter((value) => value !== method)
                    : [...selected, method],
                )
              }
            />
            {method}
          </label>
        ))}
      </div>
    </details>
  );
}
