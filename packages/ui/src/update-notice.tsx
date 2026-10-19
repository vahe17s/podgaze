import { useEffect, useState } from "react";
import type { ClusterClient, UpdateState } from "@podgaze/contracts";
import { Icon } from "./icons";

const DISMISSED_KEY = "podgaze.update.dismissed";

export function useUpdateState(client: ClusterClient): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let gone = false;
    client.updateState().then((found) => {
      if (!gone) setState(found);
    }, () => undefined);
    const stop = client.onUpdate((next) => setState(next));
    return () => {
      gone = true;
      stop();
    };
  }, [client]);
  return state;
}

// A quiet note in the corner when a new version is ready or available. Dismissed per version.
export function UpdateNotice({ client }: { client: ClusterClient }) {
  const state = useUpdateState(client);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  if (!state?.version || (state.status !== "ready" && state.status !== "available") || dismissed === state.version) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, state.version!);
    } catch {
      // Hidden for this run.
    }
    setDismissed(state.version!);
  };
  return (
    <div className="update-notice" role="status" aria-label="Update">
      <Icon name="download" />
      <span>
        <strong>Podgaze {state.version}</strong> {state.status === "ready" ? "is ready to install." : "is available."}
      </span>
      {state.status === "ready" ? (
        <button type="button" className="connect" onClick={() => void client.installUpdate()}>Restart to update</button>
      ) : state.releaseUrl ? (
        <a className="connect update-link" href={state.releaseUrl} target="_blank" rel="noreferrer">Get it</a>
      ) : null}
      <button type="button" className="dock-icon ghost" aria-label="Dismiss update" onClick={dismiss}><Icon name="x" /></button>
    </div>
  );
}

export function updateText(state: UpdateState | null): string {
  if (!state) return "…";
  switch (state.status) {
    case "unsupported": return state.message ?? "Not available in this build.";
    case "checking": return "Checking…";
    case "none": return "You have the latest version.";
    case "available": return `Version ${state.version} is available${state.canInstall ? "" : ". Download it from the release page"}.`;
    case "downloading": return `Downloading ${state.version}… ${state.progress ?? 0}%`;
    case "ready": return `Version ${state.version} is ready. Restart to install it.`;
    case "error": return state.message ?? "Could not check for updates.";
    default: return state.automatic ? "Checks a few times a day." : "Automatic checks are off.";
  }
}
