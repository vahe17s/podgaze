import { useEffect } from "react";
import { applyDocumentSettings, getSettings, updateSettings, zoomSteps } from "./settings";

function publish(next: number) {
  updateSettings({ zoom: next });
  applyDocumentSettings(getSettings());
}

export function setZoom(next: number) {
  publish(zoomSteps.includes(next) ? next : 1);
}

export function zoomBy(direction: -1 | 1) {
  const index = zoomSteps.indexOf(getSettings().zoom);
  publish(zoomSteps[Math.min(zoomSteps.length - 1, Math.max(0, (index < 0 ? zoomSteps.indexOf(1) : index) + direction))]);
}

export function useZoomKeys() {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(1);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
