import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ClusterClient, ContextDetails, ContextSaved } from "@podgaze/contracts";
import { certNote } from "./home";
import { Icon } from "./icons";
import { GazeLoader } from "./loader";

// Reads and edits one kubeconfig context. Secrets never reach this view; the file is backed up before every save.
export function ContextPanel({
  client,
  clusterId,
  onClose,
  onSaved,
}: {
  client: ClusterClient;
  clusterId: string;
  onClose: () => void;
  onSaved: (saved: ContextSaved, previous: string) => void;
}) {
  const [id, setId] = useState(clusterId);
  const [details, setDetails] = useState<ContextDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [server, setServer] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ContextSaved | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let gone = false;
    setError(null);
    client.describeContext(id).then(
      (found) => {
        if (gone) return;
        setDetails(found);
        setName(found.id);
        setNamespace(found.namespace ?? "");
        setServer(found.server);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read this context");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, id, reload]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed = details
    ? {
      ...(name.trim() !== details.id ? { name: name.trim() } : {}),
      ...(namespace.trim() !== (details.namespace ?? "") ? { namespace: namespace.trim() || null } : {}),
      ...(server.trim() !== details.server ? { server: server.trim() } : {}),
    }
    : {};
  const dirty = Object.keys(changed).length > 0;

  async function save() {
    if (!details || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const result = await client.updateContext(details.id, changed);
      setSaved(result);
      onSaved(result, details.id);
      setId(result.name);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the kubeconfig");
    } finally {
      setSaving(false);
    }
  }

  const cert = details ? certNote(details.certExpires) : null;

  // Rendered on <body>: the zoom wrapper uses a transform, which would trap and clip a fixed overlay.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="context-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Context ${id}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="context-head">
          <div>
            <p className="eyebrow">Kubeconfig context</p>
            <h2>{id} {details?.current ? <span className="chip">current-context</span> : null}</h2>
            {details ? <p className="path" title={details.file}>{details.file}</p> : null}
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close context details" onClick={onClose}><Icon name="x" /></button>
        </header>

        {!details && !error ? <GazeLoader label="Reading the kubeconfig" size={48} /> : null}
        {error ? <p className="problem" role="alert">{error}</p> : null}

        {details ? (
          <>
            <dl className="facts context-facts">
              <div><dt>Server</dt><dd className="mono">{details.server || "—"}</dd></div>
              <div><dt>Login</dt><dd>{details.auth}</dd></div>
              <div>
                <dt>Client certificate</dt>
                <dd>
                  {details.certExpires
                    ? <span className={cert ? `status ${cert.tone}` : undefined}>{cert ? cert.text : `valid until ${new Date(details.certExpires).toLocaleDateString()}`}</span>
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>TLS</dt>
                <dd>{details.skipTLSVerify ? <span className="status bad">Verification turned off</span> : `CA: ${details.ca}`}</dd>
              </div>
              <div><dt>Cluster entry</dt><dd className="mono">{details.cluster}</dd></div>
              <div><dt>User entry</dt><dd className="mono">{details.user}</dd></div>
            </dl>

            <form
              className="context-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h3>Edit</h3>
              <label className="field">
                Context name
                <input aria-label="Context name" value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
              </label>
              <label className="field">
                Default namespace
                <input aria-label="Default namespace" value={namespace} placeholder="none (all namespaces)" onChange={(event) => setNamespace(event.target.value)} spellCheck={false} />
              </label>
              <label className="field">
                API server
                <input aria-label="API server" value={server} onChange={(event) => setServer(event.target.value)} spellCheck={false} />
              </label>
              {server.trim() !== details.server && details.sharedWith.length > 0 ? (
                <p className="warn-note">The cluster entry {details.cluster} is also used by {details.sharedWith.join(", ")}. Changing the server changes them too.</p>
              ) : null}
              <div className="context-actions">
                <button type="submit" className="connect" disabled={!dirty || saving}>{saving ? "Saving" : "Save to kubeconfig"}</button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!dirty || saving}
                  onClick={() => {
                    setName(details.id);
                    setNamespace(details.namespace ?? "");
                    setServer(details.server);
                  }}
                >
                  Discard
                </button>
                <span className="muted">A backup copy is written next to the file before saving.</span>
              </div>
              {saved ? <p className="saved-note" role="status">Saved to {saved.file}. Backup: {saved.backup}</p> : null}
            </form>

            <div className="context-yaml">
              <button type="button" className="link-btn" aria-expanded={showYaml} onClick={() => setShowYaml((value) => !value)}>
                {showYaml ? "Hide YAML" : "Show YAML (secrets hidden)"}
              </button>
              {showYaml ? <pre aria-label="Context YAML">{details.yaml}</pre> : null}
            </div>
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
