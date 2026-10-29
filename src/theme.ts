import { useEffect, useState } from "react";

export const themes = [
  { id: "flutrace", name: "Flutrace" },
  { id: "fjord", name: "Fjord" },
  { id: "paper", name: "Paper" },
  { id: "dusk", name: "Dusk" },
] as const;
export type ThemeId = (typeof themes)[number]["id"];
export type Mode = "system" | "light" | "dark";
export type Appearance = { theme: ThemeId; mode: Mode };

const STORAGE_KEY = "flutrace.appearance";
export function loadAppearance(): Appearance {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      theme: themes.some((theme) => theme.id === stored.theme)
        ? stored.theme
        : "flutrace",
      mode: ["light", "dark"].includes(stored.mode) ? stored.mode : "system",
    };
  } catch {
    return { theme: "flutrace", mode: "system" };
  }
}
const query = () => globalThis.matchMedia?.("(prefers-color-scheme: light)");
export function resolveMode(mode: Mode): "light" | "dark" {
  if (mode !== "system") return mode;
  return query()?.matches ? "light" : "dark";
}
export function applyAppearance({ theme, mode }: Appearance) {
  const root = document.documentElement;
  const resolved = resolveMode(mode);
  root.dataset.theme = theme;
  root.dataset.mode = resolved;
  root.style.colorScheme = resolved;
  return resolved;
}

/** Persists the appearance, applies it and follows the system setting. */
export function useAppearance() {
  const [appearance, setAppearance] = useState(loadAppearance);
  const [resolved, setResolved] = useState(() => resolveMode(appearance.mode));
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    setResolved(applyAppearance(appearance));
    if (appearance.mode !== "system") return;
    const media = query();
    const onChange = () => setResolved(applyAppearance(appearance));
    media?.addEventListener("change", onChange);
    return () => media?.removeEventListener("change", onChange);
  }, [appearance]);
  return [appearance, setAppearance, resolved] as const;
}
