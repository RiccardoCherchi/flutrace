import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { capture } from "./App.tsx";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyAppearance, loadAppearance } from "./theme.ts";
import "./styles.css";

applyAppearance(loadAppearance());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (isTauri()) {
  document.documentElement.classList.add("native-titlebar");
  void listen("flutrace-shutdown", async () => {
    try {
      await capture.disconnect();
    } finally {
      await invoke("finish_exit");
    }
  }).then(() => invoke("frontend_ready"));
}
