import { useEffect, useState } from "react";
import type { AuditEntry, ClusterClient } from "@podgaze/contracts";
import { saveText } from "./download";
import { formatAge } from "./format";
import { Icon } from "./icons";
import { GazeLoader } from "./loader";
import { actionsScript } from "./script";

// Every change Podgaze made, newest first, with the kubectl line that does the same thing.
export function ActivityView({ client, clusterId, filter }: { client: ClusterClient; clusterId: string | null; filter: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [scope, setScope] = useState<"cluster" | "all">("cluster");
  const [failedOnly, setFailedOnly] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [scriptNote, setScriptNote] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    const load = () => client.listAudit().then((found) => {
      if (!gone) setEntries(found);
    }, () => {
      if (!gone) setEntries([]);
    });
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [client]);

  if (!entries) return <GazeLoader label="Reading the history" />;
  const needle = filter.trim().toLowerCase();
  const shown = entries
    .filter((entry) => scope === "all" || entry.cluster === clusterId)
    .filter((entry) => !failedOnly || !entry.ok)
    .filter((entry) => !needle || [entry.action, entry.target, entry.namespace ?? "", entry.cluster].some((text) => text.toLowerCase().includes(needle)));
  return (
    <div className="activity-view">
      <div className="activity-tools">
        <div className="segmented" role="group" aria-label="History scope">
          <button type="button" aria-pressed={scope === "cluster"} onClick={() => setScope("cluster")}>This cluster</button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All clusters</button>
        </div>
        <label className="check">
          <input type="checkbox" checked={failedOnly} onChange={(event) => setFailedOnly(event.target.checked)} />
          Failed only
        </label>
        <span className="muted">Saved on this computer. Reads are not recorded, only changes.</span>
      </div>
      {shown.length > 0 ? (
        <div className="activity-script" role="group" aria-label="Turn actions into a script">
          <label className="check">
            <input
              type="checkbox"
              aria-label="Pick every shown action"
              checked={shown.every((entry) => picked.has(entry.id))}
              onChange={(event) => setPicked(event.target.checked ? new Set(shown.map((entry) => entry.id)) : new Set())}
            />
            {picked.size > 0 ? `${picked.size} picked` : "Pick actions to turn into a script"}
          </label>
          <button
            type="button"
            className="ghost icon-btn"
            disabled={picked.size === 0}
            onClick={() => void navigator.clipboard?.writeText(actionsScript(entries.filter((entry) => picked.has(entry.id)))).then(() => {
              setScriptNote("Copied. Each command names its --context; failed ones are commented out.");
              window.setTimeout(() => setScriptNote(null), 4000);
            }, () => setScriptNote("Could not copy"))}
          >
            <Icon name="copy" /> Copy as script
          </button>
          <button
            type="button"
            className="ghost icon-btn"
            disabled={picked.size === 0}
            onClick={() => saveText("podgaze-actions.sh", actionsScript(entries.filter((entry) => picked.has(entry.id))))}
          >
            <Icon name="download" /> Save .sh
          </button>
          {scriptNote ? <span className="muted" role="status">{scriptNote}</span> : null}
        </div>
      ) : null}
      {shown.length === 0 ? <p className="empty-state">{entries.length === 0 ? "Nothing changed yet. Restarts, scales, edits, deletes, and creates show up here." : "No entries match."}</p> : null}
      <ul className="activity-list">
        {shown.map((entry) => (
          <li key={entry.id} className={entry.ok ? undefined : "failed"}>
            <input
              type="checkbox"
              className="activity-pick"
              aria-label={`Pick ${entry.action} ${entry.target}`}
              checked={picked.has(entry.id)}
              onChange={() => setPicked((current) => {
                const next = new Set(current);
                if (next.has(entry.id)) next.delete(entry.id);
                else next.add(entry.id);
                return next;
              })}
            />
            <span className={entry.ok ? "activity-dot ok" : "activity-dot bad"} aria-label={entry.ok ? "Succeeded" : "Failed"} />
            <div className="activity-main">
              <p>
                <strong>{entry.action}</strong> <span className="mono">{entry.target}</span>
                {entry.namespace ? <span className="muted"> · {entry.namespace}</span> : null}
                {scope === "all" ? <span className="chip">{entry.cluster}</span> : null}
              </p>
              <p className="activity-cmd mono">$ {entry.kubectl}</p>
              {entry.error ? <p className="problem">{entry.error}</p> : null}
            </div>
            <span className="muted activity-time" title={new Date(entry.time).toLocaleString()}>{formatAge(entry.time) || "now"} ago</span>
            <button
              type="button"
              className="dock-icon ghost"
              aria-label={`Copy command for ${entry.target}`}
              title="Copy the kubectl command"
              onClick={() => void navigator.clipboard?.writeText(entry.kubectl).then(() => {
                setCopied(entry.id);
                window.setTimeout(() => setCopied(null), 1200);
              }, () => undefined)}
            >
              <Icon name={copied === entry.id ? "check" : "copy"} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
