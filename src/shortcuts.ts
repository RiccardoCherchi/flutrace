export type ActionId =
  "palette" | "settings" | "find" | "searchAll" | "clear" | "record";
export type Bindings = Record<ActionId, string>;

export const actions: { id: ActionId; title: string; keys: string }[] = [
  { id: "palette", title: "Show command palette", keys: "Meta+KeyP" },
  { id: "settings", title: "Open settings", keys: "Meta+Comma" },
  { id: "find", title: "Find in body or filter", keys: "Meta+KeyF" },
  { id: "searchAll", title: "Search all requests", keys: "Shift+Meta+KeyF" },
  { id: "clear", title: "Clear log", keys: "Meta+KeyK" },
  { id: "record", title: "Pause or resume recording", keys: "Meta+KeyE" },
];
export const defaultBindings = Object.fromEntries(
  actions.map((action) => [action.id, action.keys]),
) as Bindings;
// Editing and window commands people rely on everywhere.
const reserved = new Set(
  ["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyQ", "KeyW", "KeyH", "KeyM"].map(
    (code) => `Meta+${code}`,
  ),
);

const STORAGE_KEY = "flutrace.shortcuts";
export function loadBindings(): Bindings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const bindings = { ...defaultBindings };
    for (const { id } of actions)
      if (typeof stored[id] === "string") bindings[id] = stored[id];
    return bindings;
  } catch {
    return { ...defaultBindings };
  }
}
export function saveBindings(bindings: Bindings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
}

type KeyEvent = Pick<
  KeyboardEvent,
  "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;
function codeOf(event: KeyEvent) {
  if (event.code) return event.code;
  // Synthetic events (tests) may carry only `key`.
  return /^[a-z]$/i.test(event.key)
    ? `Key${event.key.toUpperCase()}`
    : event.key === ","
      ? "Comma"
      : event.key;
}
/** "Ctrl+Alt+Shift+Meta+KeyF", or undefined for a lone modifier. Layout-independent. */
export function comboOf(event: KeyEvent) {
  const code = codeOf(event);
  if (/^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(code)) return undefined;
  return [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Meta",
    code,
  ]
    .filter(Boolean)
    .join("+");
}
/** Why a combo cannot be used, if it cannot. */
export function comboProblem(combo: string) {
  if (!/(^|\+)(Meta|Ctrl)\+/.test(combo)) return "Include ⌘ or ⌃.";
  if (reserved.has(combo)) return "Reserved for editing and window commands.";
}

const symbols: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Meta: "⌘",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Enter: "↵",
  Backspace: "⌫",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
export function formatCombo(combo: string) {
  return combo
    .split("+")
    .map(
      (part) => symbols[part] ?? part.replace(/^Key/, "").replace(/^Digit/, ""),
    )
    .join("");
}
