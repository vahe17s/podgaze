import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClusterSummary } from "@podgaze/contracts";
import { groupOf, type ClusterGrouping } from "./groups";
import { Icon } from "./icons";

const SUGGESTED = 8;

// Everything about one group in one place: its name, who is in it, adding by search, and deleting it.
export function GroupSettings({
  groupId,
  grouping,
  clusters,
  focusName = false,
  onRename,
  onAssign,
  onDelete,
  onClose,
}: {
  groupId: string;
  grouping: ClusterGrouping;
  clusters: ClusterSummary[];
  focusName?: boolean;
  onRename: (name: string) => void;
  onAssign: (clusterId: string, groupId: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const group = grouping.groups.find((item) => item.id === groupId);
  const [name, setName] = useState(group?.name ?? "");
  const [query, setQuery] = useState("");
  const [armDelete, setArmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusName) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [focusName]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!group) return null;
  const members = clusters.filter((cluster) => grouping.membership[cluster.id] === groupId);
  const needle = query.trim().toLowerCase();
  const others = clusters
    .filter((cluster) => grouping.membership[cluster.id] !== groupId)
    .filter((cluster) => !needle || [cluster.name, cluster.server, cluster.namespace ?? ""].join(" ").toLowerCase().includes(needle));

  function commitName() {
    const next = name.trim() || "Untitled group";
    setName(next);
    onRename(next);
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="context-panel group-settings" role="dialog" aria-modal="true" aria-label={`Group ${group.name}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="context-head">
          <div className="group-name-field">
            <p className="eyebrow">Group</p>
            <input
              ref={nameRef}
              aria-label="Group name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (event.target.value.trim()) onRename(event.target.value);
              }}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitName();
                  nameRef.current?.blur();
                }
              }}
            />
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close group settings" onClick={onClose}><Icon name="x" /></button>
        </header>

        <div className="group-section">
          <h3>In this group <span className="muted">{members.length}</span></h3>
          {members.length === 0 ? <p className="muted">No clusters yet. Add some below, or drag a card onto the group.</p> : null}
          <ul className="group-rows">
            {members.map((cluster) => (
              <li key={cluster.id}>
                <span className="cluster-mark small" aria-hidden="true">{cluster.name.slice(0, 1).toUpperCase()}</span>
                <span className="row-main">
                  <strong>{cluster.name}</strong>
                  <small>{cluster.server || cluster.problem}</small>
                </span>
                <button type="button" className="ghost" aria-label={`Remove ${cluster.name} from ${group.name}`} onClick={() => onAssign(cluster.id, "")}>Remove</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="group-section">
          <h3>Add clusters</h3>
          <input
            role="searchbox"
            aria-label="Find clusters to add"
            placeholder="Search by name, server, or namespace"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {others.length === 0 ? <p className="muted">{needle ? "No clusters match." : "Every cluster is already in this group."}</p> : null}
          <ul className="group-rows">
            {others.slice(0, needle ? 50 : SUGGESTED).map((cluster) => {
              const current = groupOf(grouping, cluster.id);
              return (
                <li key={cluster.id}>
                  <span className="cluster-mark small" aria-hidden="true">{cluster.name.slice(0, 1).toUpperCase()}</span>
                  <span className="row-main">
                    <strong>{cluster.name}</strong>
                    <small>{current ? `Now in ${current.name}` : cluster.server || "Ungrouped"}</small>
                  </span>
                  <button type="button" className="connect" aria-label={`Add ${cluster.name} to ${group.name}`} onClick={() => onAssign(cluster.id, groupId)}>
                    {current ? "Move here" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
          {!needle && others.length > SUGGESTED ? <p className="muted">{others.length - SUGGESTED} more. Search to find them.</p> : null}
        </div>

        <footer className="group-foot">
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (!armDelete) {
                setArmDelete(true);
                return;
              }
              onDelete();
            }}
          >
            {armDelete ? "Click again to delete" : "Delete group"}
          </button>
          <span className="muted">Its clusters move back to Ungrouped. Nothing changes in your kubeconfig.</span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
