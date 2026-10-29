import { useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  { label: string; disabled?: boolean; run: () => void } | "separator";

/** Fixed-position menu at the pointer, kept inside the window. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    setPosition({
      left: Math.max(4, Math.min(x, innerWidth - element.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, innerHeight - element.offsetHeight - 4)),
    });
    element
      .querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")
      ?.focus();
  }, [x, y]);
  function move(step: number) {
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLElement>(
        "[role=menuitem]:not(:disabled)",
      ) ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  }
  return (
    <div
      className="menu-backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="context-menu"
        role="menu"
        ref={menu}
        style={position}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        {items.map((item, index) =>
          item === "separator" ? (
            <hr key={index} />
          ) : (
            <button
              key={index}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.run();
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
