import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ClusterClient, ContextRemoved } from "@podgaze/contracts";
import { Icon } from "./icons";

// Two ways to take a cluster off Home: hide it here only, or delete the context from the kubeconfig itself.
export function RemoveCluster({ client, clusterId, open, onHide, onRemoved, onClose }: {
  client: ClusterClient;
  clusterId: string;
  open: boolean;
  onHide: () => void;
  onRemoved: (result: ContextRemoved) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      onRemoved(await client.removeContext(clusterId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove it");
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="context-panel remove-dialog" role="dialog" aria-modal="true" aria-label={`Remove ${clusterId}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="context-head">
          <div>
            <p className="eyebrow">Remove cluster</p>
            <h2>{clusterId}</h2>
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="remove-choice">
          <div>
            <strong>Hide from Home</strong>
            <p className="muted">The context stays in your kubeconfig, so kubectl and other tools still see it. Bring it back with Show hidden.</p>
          </div>
          <button type="button" className="ghost icon-btn" onClick={onHide}><Icon name="eye" /> Hide</button>
        </div>
        <div className="remove-choice danger-zone">
          <div>
            <strong>Delete from kubeconfig</strong>
            <p className="muted">Deletes the context, plus its cluster and user entries if no other context uses them. A backup copy is written next to the file first.</p>
            {open ? <p className="warn-note">Close this cluster's tab first.</p> : (
              <label className="field">
                Type {clusterId} to confirm
                <input aria-label="Type the context name to confirm" value={typed} onChange={(event) => setTyped(event.target.value)} spellCheck={false} />
              </label>
            )}
          </div>
          <button type="button" className="danger icon-btn" disabled={open || busy || typed !== clusterId} onClick={() => void remove()}>
            <Icon name="trash" /> {busy ? "Deleting" : "Delete"}
          </button>
        </div>
        {error ? <p className="problem" role="alert">{error}</p> : null}
      </section>
    </div>,
    document.body,
  );
}
