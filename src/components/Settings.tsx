import { useState } from "react";
import {
  actions,
  comboOf,
  comboProblem,
  defaultBindings,
  formatCombo,
} from "../shortcuts.ts";
import type { ActionId, Bindings } from "../shortcuts.ts";
import { themes } from "../theme.ts";
import type { Appearance, Mode } from "../theme.ts";
import { CloseIcon } from "./Icons.tsx";

export function Settings({
  appearance,
  resolvedMode,
  onAppearance,
  bindings,
  onBindings,
  onClose,
}: {
  appearance: Appearance;
  resolvedMode: "light" | "dark";
  onAppearance: (appearance: Appearance) => void;
  bindings: Bindings;
  onBindings: (bindings: Bindings) => void;
  onClose: () => void;
}) {
  const [recording, setRecording] = useState<ActionId>();
  const [note, setNote] = useState<{ id: ActionId; text: string }>();
  function bind(id: ActionId, combo: string) {
    const next = { ...bindings, [id]: combo };
    const other = actions.find(
      (action) => action.id !== id && combo && bindings[action.id] === combo,
    );
    if (other) next[other.id] = "";
    onBindings(next);
    setNote(other ? { id, text: `Removed from “${other.title}”.` } : undefined);
  }
  const changed = actions.some(
    ({ id }) => bindings[id] !== defaultBindings[id],
  );
  return (
    <div className="palette-backdrop settings-backdrop" onMouseDown={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !recording) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="settings-heading">
          <h2>Settings</h2>
          <button
            className="close-button"
            aria-label="Close settings"
            autoFocus
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="settings-body">
          <section aria-labelledby="appearance-heading">
            <h3 id="appearance-heading">Appearance</h3>
            <div className="settings-row">
              <span>Mode</span>
              <div className="segmented" role="group" aria-label="Mode">
                {(["system", "light", "dark"] as Mode[]).map((mode) => (
                  <button
                    key={mode}
                    aria-pressed={appearance.mode === mode}
                    onClick={() => onAppearance({ ...appearance, mode })}
                  >
                    {mode[0].toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="theme-grid" role="group" aria-label="Theme">
              {themes.map((theme) => (
                <button
                  key={theme.id}
                  className="theme-card"
                  aria-pressed={appearance.theme === theme.id}
                  onClick={() =>
                    onAppearance({ ...appearance, theme: theme.id })
                  }
                >
                  <span className="theme-swatch">
                    <span
                      className="theme-preview"
                      data-theme={theme.id}
                      data-mode={resolvedMode}
                      aria-hidden="true"
                    >
                      <i className="bar" />
                      <i className="row selected" />
                      <i className="row" />
                      <i className="row error" />
                    </span>
                  </span>
                  <span className="theme-name">{theme.name}</span>
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="shortcuts-heading">
            <div className="settings-section-heading">
              <h3 id="shortcuts-heading">Keyboard shortcuts</h3>
              {changed && (
                <button
                  className="text-button"
                  onClick={() => {
                    onBindings({ ...defaultBindings });
                    setNote(undefined);
                  }}
                >
                  Restore defaults
                </button>
              )}
            </div>
            <ul className="shortcut-list">
              {actions.map((action) => {
                const combo = bindings[action.id];
                const active = recording === action.id;
                return (
                  <li key={action.id}>
                    <span className="title">{action.title}</span>
                    <button
                      className={`shortcut-recorder ${active ? "recording" : ""}`}
                      aria-label={`${action.title}: ${active ? "press a shortcut" : combo ? formatCombo(combo) : "not set"}`}
                      onClick={() => {
                        setNote(undefined);
                        setRecording(active ? undefined : action.id);
                      }}
                      onBlur={() => active && setRecording(undefined)}
                      onKeyDown={(event) => {
                        if (!active) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape")
                          return setRecording(undefined);
                        if (
                          (event.key === "Backspace" ||
                            event.key === "Delete") &&
                          !event.metaKey &&
                          !event.ctrlKey
                        ) {
                          bind(action.id, "");
                          return setRecording(undefined);
                        }
                        const next = comboOf(event.nativeEvent);
                        if (!next) return;
                        const problem = comboProblem(next);
                        if (problem)
                          return setNote({ id: action.id, text: problem });
                        bind(action.id, next);
                        setRecording(undefined);
                      }}
                    >
                      {active ? (
                        "Press keys…"
                      ) : combo ? (
                        <kbd>{formatCombo(combo)}</kbd>
                      ) : (
                        <span className="unset">Not set</span>
                      )}
                    </button>
                    {combo !== defaultBindings[action.id] && !active && (
                      <button
                        className="text-button"
                        aria-label={`Reset ${action.title}`}
                        onClick={() => {
                          bind(action.id, defaultBindings[action.id]);
                        }}
                      >
                        Reset
                      </button>
                    )}
                    {note?.id === action.id && (
                      <p className="shortcut-note" role="status">
                        {note.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="settings-hint">
              Click a shortcut, then press the new keys. Delete removes it, Esc
              cancels.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
