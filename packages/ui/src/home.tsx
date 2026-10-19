import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ClusterClient, ClusterSummary, ContextGuard, Session } from "@podgaze/contracts";
import { ContextPanel } from "./context-panel";
import { RemoveCluster } from "./remove-cluster";
import { GroupSettings } from "./group-settings";
import { addGroup, assignCluster, setHidden, deleteGroup, loadGrouping, renameGroup, saveGrouping, type ClusterGrouping } from "./groups";
import { Icon } from "./icons";
import { WatchingLogo } from "./logo";
import { CloudDialog } from "./cloud-dialog";
import { ThemeToggle } from "./theme";

const DAY = 86_400_000;

// Client certificates (kubeadm's admin.conf among them) silently expire after a year; say so before Connect fails with a 401.
export function certNote(expires: string | null, now = Date.now()): { tone: "bad" | "warn"; text: string } | null {
  if (!expires) return null;
  const at = Date.parse(expires);
  if (Number.isNaN(at)) return null;
  const day = new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (at <= now) return { tone: "bad", text: `Certificate expired ${day}` };
  const days = Math.ceil((at - now) / DAY);
  if (days <= 30) return { tone: "warn", text: `Certificate expires in ${days} day${days === 1 ? "" : "s"}` };
  return null;
}

export function ClusterHome({
  clusters,
  session,
  client,
  onConnect,
  onPick,
  onContextsChanged,
  onSettings,
  openIds = new Set<string>(),
}: {
  clusters: ClusterSummary[];
  session: Session;
  client?: ClusterClient;
  onContextsChanged?: () => void;
  onConnect: (id: string) => void;
  onPick: () => void;
  onSettings?: () => void;
  // Clusters still connected in a tab.
  openIds?: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<ClusterGrouping>(() => loadGrouping(session.kubeconfigPath));
  // The drop zone under the pointer: a group id, "" for Ungrouped, or "new" for the start-a-group zone.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // dragenter/dragleave fire for every child the pointer crosses; counting them per zone tells a real exit from a child hop.
  const depth = useRef(new Map<string, number>());
  const [settings, setSettings] = useState<{ id: string; fresh: boolean } | null>(null);
  const [guards, setGuards] = useState<Record<string, ContextGuard>>({});
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [addingCloud, setAddingCloud] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    setGrouping(loadGrouping(session.kubeconfigPath));
    // A team settings file was imported: groups and guards may have changed.
    const reload = () => {
      setGrouping(loadGrouping(session.kubeconfigPath));
      client?.getGuards().then(setGuards, () => undefined);
    };
    window.addEventListener("podgaze:imported", reload);
    return () => window.removeEventListener("podgaze:imported", reload);
  }, [session.kubeconfigPath, client]);

  useEffect(() => {
    if (!client) return;
    let gone = false;
    client.getGuards().then((found) => {
      if (!gone) setGuards(found);
    }, () => undefined);
    return () => {
      gone = true;
    };
  }, [client, clusters]);

  function setGuard(clusterId: string, change: Partial<ContextGuard>) {
    if (!client) return;
    const next: ContextGuard = { ...(guards[clusterId] ?? { protected: false, readOnly: false }), ...change };
    setGuards((current) => ({ ...current, [clusterId]: next }));
    void client.setGuard(clusterId, next);
  }

  // Functional so quick successive edits (typing a name, several adds) never overwrite each other.
  function change(edit: (current: ClusterGrouping) => ClusterGrouping) {
    setGrouping((current) => {
      const next = edit(current);
      saveGrouping(session.kubeconfigPath, next);
      return next;
    });
  }

  function update(next: ClusterGrouping) {
    change(() => next);
  }

  function newGroup(withCluster?: string) {
    const created = addGroup(grouping, "New group");
    const next = withCluster ? assignCluster(created.grouping, withCluster, created.id) : created.grouping;
    update(next);
    setSettings({ id: created.id, fresh: true });
  }

  function assign(clusterId: string, groupId: string) {
    change((current) => assignCluster(current, clusterId, groupId));
  }

  function matches(cluster: ClusterSummary) {
    if (!needle) return true;
    return [cluster.name, cluster.server, cluster.namespace ?? "", cluster.problem ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  }

  const hidden = new Set(grouping.hidden ?? []);
  const hiddenCount = clusters.filter((cluster) => hidden.has(cluster.id)).length;
  const visible = clusters.filter((cluster) => (showHidden || !hidden.has(cluster.id)) && matches(cluster));
  const knownGroups = new Set(grouping.groups.map((group) => group.id));
  const ungrouped = visible.filter((cluster) => !knownGroups.has(grouping.membership[cluster.id] ?? ""));

  function onDragStart(event: DragEvent<HTMLLIElement>, clusterId: string) {
    event.dataTransfer.setData("text/plain", clusterId);
    event.dataTransfer.effectAllowed = "move";
    // Set after the browser has taken its drag snapshot, so the ghost image is the normal card.
    window.requestAnimationFrame(() => setDragging(clusterId));
  }

  function endDrag() {
    depth.current.clear();
    setDragging(null);
    setDropTarget(null);
  }

  // Drop-zone handlers. Leaving a child element inside the zone is not leaving the zone; that was the flicker.
  function zone(target: string, onDropped: (clusterId: string) => void) {
    return {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        depth.current.set(target, (depth.current.get(target) ?? 0) + 1);
        setDropTarget(target);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTarget !== target) setDropTarget(target);
      },
      onDragLeave: () => {
        const left = (depth.current.get(target) ?? 1) - 1;
        depth.current.set(target, left);
        if (left > 0) return;
        setDropTarget((current) => current === target ? null : current);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        const clusterId = event.dataTransfer.getData("text/plain") || dragging;
        endDrag();
        if (clusterId) onDropped(clusterId);
      },
    };
  }

  function zoneClass(base: string, target: string) {
    return [base, dragging ? "drop-ready" : "", dropTarget === target ? "drop" : ""].filter(Boolean).join(" ");
  }

  function cards(list: ClusterSummary[]) {
    return list.map((cluster) => (
      <li
        key={cluster.id}
        className={dragging === cluster.id ? "cluster-card dragging" : "cluster-card"}
        draggable
        title="Drag onto a group"
        onDragStart={(event) => onDragStart(event, cluster.id)}
        onDragEnd={endDrag}
      >
        <div className="cluster-mark" aria-hidden="true">{cluster.name.slice(0, 1).toUpperCase()}</div>
        <div className="cluster-copy">
          <h2 title={cluster.name}>{cluster.name}</h2>
          <p title={cluster.server || cluster.problem || ""}>{cluster.server || cluster.problem}</p>
          {cluster.namespace ? <span className="chip">{cluster.namespace}</span> : null}
          {(() => {
            const note = certNote(cluster.certExpires);
            return note ? (
              <span className={`status ${note.tone} cert-note`} title={`Client certificate valid until ${cluster.certExpires}. Renew it (for kubeadm: kubeadm certs renew admin.conf) and update your kubeconfig.`}>
                {note.text}
              </span>
            ) : null;
          })()}
          {client && guards[cluster.id] ? (
            <div className="guard-chips">
              <button
                type="button"
                className="chip guard-chip"
                aria-pressed={guards[cluster.id]!.protected}
                aria-label={`Protected ${cluster.name}`}
                title="Destructive actions ask you to type the object's name"
                onClick={() => setGuard(cluster.id, { protected: !guards[cluster.id]!.protected })}
              >
                Protected
              </button>
              <button
                type="button"
                className="chip guard-chip"
                aria-pressed={guards[cluster.id]!.readOnly}
                aria-label={`Read-only ${cluster.name}`}
                title="Podgaze refuses every change to this cluster"
                onClick={() => setGuard(cluster.id, { readOnly: !guards[cluster.id]!.readOnly })}
              >
                Read-only
              </button>
            </div>
          ) : null}
        </div>
        <div className="card-actions">
        {client ? (
          <button type="button" className="ghost card-icon" aria-label={`Details ${cluster.name}`} title="View and edit this context" onClick={() => setInspecting(cluster.id)}>
            <Icon name="panel" />
          </button>
        ) : null}
        {hidden.has(cluster.id) ? (
          <button type="button" className="ghost card-icon" aria-label={`Show ${cluster.name} on Home`} title="Show on Home again" onClick={() => change((current) => setHidden(current, cluster.id, false))}>
            <Icon name="eye" />
          </button>
        ) : client ? (
          <button type="button" className="ghost card-icon card-remove" aria-label={`Remove ${cluster.name}`} title="Hide from Home or delete from kubeconfig" onClick={() => setRemoving(cluster.id)}>
            <Icon name="trash" />
          </button>
        ) : null}
        <button
          type="button"
          className={openIds.has(cluster.id) ? "connect open" : "connect"}
          aria-label={`${openIds.has(cluster.id) ? "Open" : "Connect"} ${cluster.name}`}
          title={openIds.has(cluster.id) ? "Already connected in a tab" : undefined}
          disabled={!cluster.usable}
          onClick={() => onConnect(cluster.id)}
        >
          {openIds.has(cluster.id) ? "Open" : "Connect"}
        </button>
        </div>
      </li>
    ));
  }

  return (
    <main className="home">
      <header className="home-top">
        <div className="brand">
          <WatchingLogo size={48} />
          <div>
            <p className="mark">Podgaze</p>
            <p className="brand-sub">Kubernetes, without the terminal hop</p>
          </div>
        </div>
        <div className="home-actions">
          <ThemeToggle />
          {onSettings ? (
            <button type="button" className="ghost icon-btn" aria-label="Settings" title="Settings (Ctrl+,)" onClick={onSettings}>
              <Icon name="gear" />
              Settings
            </button>
          ) : null}
          {client ? (
            <button type="button" className="ghost icon-btn" title="Azure AKS, AWS EKS, or Google GKE, through their CLIs" onClick={() => setAddingCloud(true)}>
              <Icon name="plus" />
              Add cloud cluster
            </button>
          ) : null}
          <button type="button" className="ghost icon-btn" onClick={onPick}>
            <Icon name="folder" />
            Choose kubeconfig
          </button>
        </div>
      </header>
      <h1>Clusters</h1>
      {session.problem ? <p className="problem">{session.problem}</p> : null}
      <div className="home-tools">
        <input
          role="searchbox"
          aria-label="Search clusters"
          placeholder="Search clusters"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="ghost icon-btn" onClick={() => newGroup()}><Icon name="plus" /> New group</button>
        {hiddenCount > 0 ? (
          <button type="button" className="ghost icon-btn" aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>
            <Icon name="eye" /> {showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
          </button>
        ) : null}
      </div>
      {removedNote ? <p className="saved-note" role="status">{removedNote}</p> : null}
      {session.kubeconfigPath && !session.problem && clusters.length === 0 ? (
        <p className="empty">No contexts in this file.</p>
      ) : null}
      {needle && visible.length === 0 ? <p className="empty">No clusters match.</p> : null}
      {grouping.groups.map((group) => {
        const items = visible.filter((cluster) => grouping.membership[cluster.id] === group.id);
        if (needle && items.length === 0) return null;
        return (
          <section key={group.id} className={zoneClass("group-block", group.id)} aria-label={group.name} {...zone(group.id, (id) => assign(id, group.id))}>
            <header className="group-head">
              <h2>{group.name}</h2>
              <span className="group-count">{items.length}</span>
              <button
                type="button"
                className="ghost card-icon"
                aria-label={`Settings for group ${group.name}`}
                title="Rename, add or remove clusters, delete"
                onClick={() => setSettings({ id: group.id, fresh: false })}
              >
                <Icon name="sliders" />
              </button>
            </header>
            {items.length === 0 ? (
              <p className="empty group-empty">Empty. Drag a cluster here, or add some from the group settings.</p>
            ) : <ul className="cluster-list">{cards(items)}</ul>}
          </section>
        );
      })}
      {dragging ? (
        <section className={zoneClass("group-block new-group-zone", "new")} aria-label="Start a new group" {...zone("new", (id) => newGroup(id))}>
          <Icon name="plus" /> Drop here to start a new group
        </section>
      ) : null}
      <section
        aria-label="Ungrouped"
        className={grouping.groups.length > 0 || dragging ? zoneClass("group-block", "") : undefined}
        {...zone("", (id) => assign(id, ""))}
      >
        {grouping.groups.length > 0 ? <h2 className="group-label">Ungrouped <span className="group-count">{ungrouped.length}</span></h2> : null}
        {ungrouped.length === 0 && grouping.groups.length > 0 ? <p className="empty group-empty">Every cluster is in a group.</p> : null}
        <ul className="cluster-list">{cards(ungrouped)}</ul>
      </section>
      {settings ? (
        <GroupSettings
          groupId={settings.id}
          grouping={grouping}
          clusters={clusters}
          focusName={settings.fresh}
          onRename={(name) => change((current) => renameGroup(current, settings.id, name))}
          onAssign={assign}
          onDelete={() => {
            change((current) => deleteGroup(current, settings.id));
            setSettings(null);
          }}
          onClose={() => setSettings(null)}
        />
      ) : null}
      {addingCloud && client ? <CloudDialog client={client} onAdded={() => onContextsChanged?.()} onClose={() => setAddingCloud(false)} /> : null}
      {removing && client ? (
        <RemoveCluster
          client={client}
          clusterId={removing}
          open={openIds.has(removing)}
          onHide={() => {
            change((current) => setHidden(current, removing, true));
            setRemovedNote(`${removing} is hidden from Home. It is still in your kubeconfig.`);
            setRemoving(null);
          }}
          onRemoved={(result) => {
            change((current) => setHidden(assignCluster(current, removing, ""), removing, false));
            setRemovedNote(`Deleted ${result.removed.join(", ")} from ${result.file}. Backup: ${result.backup}`);
            setRemoving(null);
            onContextsChanged?.();
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
      {inspecting && client ? (
        <ContextPanel
          client={client}
          clusterId={inspecting}
          onClose={() => setInspecting(null)}
          onSaved={(saved, previous) => {
            // A renamed context keeps its group, and stays hidden if it was.
            if (saved.name !== previous) {
              change((current) => {
                const membership = { ...current.membership };
                if (membership[previous]) {
                  membership[saved.name] = membership[previous]!;
                  delete membership[previous];
                }
                const hidden = (current.hidden ?? []).map((id) => (id === previous ? saved.name : id));
                return { ...current, membership, hidden };
              });
            }
            setInspecting(saved.name);
            onContextsChanged?.();
          }}
        />
      ) : null}
    </main>
  );
}
