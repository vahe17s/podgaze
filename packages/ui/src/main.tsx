/// <reference types="vite/client" />
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import { createRoot } from "react-dom/client";
import type { ClusterClient } from "@podgaze/contracts";
import { App } from "./App";
import { applyDocumentSettings, getSettings } from "./settings";
import "./styles.css";

applyDocumentSettings(getSettings());

declare global {
  interface Window {
    podgaze?: ClusterClient;
  }
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Podgaze is missing its root element.");
}

// The sample cluster behind ?preview exists only on the dev server. The import sits inside an
// import.meta.env.DEV branch, so a production build drops it and ships no sample data at all.
// While the window is hidden or another app has focus, nothing in it needs to move.
function pauseWhenInactive() {
  const sync = () => {
    if (document.hidden || !document.hasFocus()) document.documentElement.dataset.inactive = "";
    else delete document.documentElement.dataset.inactive;
  };
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
}
pauseWhenInactive();

async function previewClient(): Promise<ClusterClient | undefined> {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview")) {
    return (await import("./preview")).createPreviewClient();
  }
  return undefined;
}

void (async () => {
  const client = window.podgaze ?? (await previewClient());
  if (!client) root.textContent = "Podgaze is missing its desktop bridge.";
  else createRoot(root).render(<App client={client} />);
})();
