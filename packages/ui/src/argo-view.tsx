import { useEffect, useState } from "react";
import { entryForApiKind, type ArgoApp, type ClusterClient, type ClusterSummary, type MapNode, type ResourceMap, type CommandResult, type ContextGuard, type ResourceRef } from "@podgaze/contracts";
import { formatAge } from "./format";
import { effectiveGuard } from "./guards";
import { Icon } from "./icons";
import { GazeInline, GazeLoader } from "./loader";
import { matchesSearch, PanelSearchBox } from "./panel-search";
import { ResizablePanel } from "./resizable-panel";
import { ResourceTable, type TableColumn } from "./table";

type Row = ArgoApp & { uid: string; status: string };

const columns: TableColumn<Row>[] = [
  { key: "name", header: "Name", width: "1.2fr", cell: (row) => row.name },
  { key: "status", header: "Health", width: "0.7fr", cell: (row) => row.health, status: true },
  { key: "sync", header: "Sync", width: "0.7fr", cell: (row) => row.sync },
  { key: "project", header: "Project", width: "0.6fr", cell: (row) => row.project },
  { key: "source", header: "Source", width: "1.4fr", cell: (row) => sourceText(row) },
  { key: "revision", header: "Revision", width: "0.6fr", cell: (row) => row.revision.slice(0, 8) },
  { key: "dest", header: "Destination", width: "0.8fr", cell: (row) => row.destNamespace || "—" },
  { key: "reconciled", header: "Checked", width: "0.5fr", cell: (row) => row.reconciledAt, age: true },
];

function sourceText(app: ArgoApp): string {
  const repo = app.repo.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  return app.chart ? `${repo} · ${app.chart}@${app.targetRevision}` : `${repo}${app.path ? `/${app.path}` : ""} @ ${app.targetRevision}`;
}

function tone(value: string): string {
  if (value === "Healthy" || value === "Synced" || value === "Succeeded") return "ok";
  if (value === "Progressing" || value === "OutOfSync" || value === "Running" || value === "Suspended" || value === "Missing") return "warn";
  if (value === "Unknown" || !value) return "muted";
  return "bad";
}

function inCluster(app: ArgoApp): boolean {
  return app.destServer === "https://kubernetes.default.svc" || app.destServer === "in-cluster";
}

const ownerKinds = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet"]);

// Argo CD's status lists only what comes from Git. The ReplicaSets, Jobs, and Pods those create are found here
// through ownership, the way Argo's own resource tree shows them.
function useChildren(client: ClusterClient, app: ArgoApp): { map: ResourceMap | null; loading: boolean } {
  const namespaces = [...new Set(app.resources.filter((item) => ownerKinds.has(item.kind) && item.namespace).map((item) => item.namespace))].sort();
  const enabled = inCluster(app) && namespaces.length > 0;
  const [map, setMap] = useState<ResourceMap | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { if (!document.hidden) setTick((value) => value + 1); }, 15_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    client.getMap({ namespaces }).then((found) => {
      if (!gone) setMap(found);
    }, () => undefined);
    return () => {
      gone = true;
    };
  }, [client, enabled, namespaces.join(","), app.reconciledAt, tick]);
  return { map: enabled ? map : null, loading: enabled && !map };
}

function childrenOf(map: ResourceMap | null, kind: string, namespace: string, name: string): { node: MapNode; depth: number }[] {
  if (!map || !ownerKinds.has(kind)) return [];
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const out: { node: MapNode; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    if (depth > 3) return;
    for (const edge of map.edges) {
      if (edge.from !== id || edge.relation !== "owns") continue;
      const child = byId.get(edge.to);
      if (!child) continue;
      out.push({ node: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(`${kind}/${namespace}/${name}`, 1);
  return out;
}

function normalizeServer(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

// Argo CD Applications read from the cluster. Sync and refresh work the way the argocd CLI does it, by writing
// to the Application, so no Argo CD login is needed: only permission to patch Applications.
export function ArgoView({ client, guard, filter, refreshKey, onNavigate, clusters = [], onOpenCluster }: {
  clusters?: ClusterSummary[];
  onOpenCluster?: (clusterId: string) => void;
  client: ClusterClient;
  guard: ContextGuard;
  filter: string;
  refreshKey: string;
  onNavigate: (ref: ResourceRef) => void;
}) {
  const [apps, setApps] = useState<ArgoApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [problemsOnly, setProblemsOnly] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) setTick((value) => value + 1); }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let gone = false;
    client.listArgoApps().then(
      (found) => {
        if (!gone) {
          setApps(found);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read Argo CD Applications");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, refreshKey, tick]);

  if (error && !apps) return <p className="empty-state" role="alert">{error}</p>;
  if (!apps) return <GazeLoader label="Reading Argo CD Applications" />;
  const needle = filter.trim().toLowerCase();
  const rows: Row[] = apps
    .filter((app) => !needle || [app.name, app.project, app.repo, app.path, app.destNamespace].some((text) => text.toLowerCase().includes(needle)))
    .filter((app) => !problemsOnly || app.health !== "Healthy" || app.sync !== "Synced")
    .map((app) => ({ ...app, uid: `${app.namespace}/${app.name}`, status: app.health }));
  const current = selected ? apps.find((app) => `${app.namespace}/${app.name}` === selected) : undefined;
  const counts = {
    healthy: apps.filter((app) => app.health === "Healthy").length,
    degraded: apps.filter((app) => app.health === "Degraded" || app.health === "Missing").length,
    outOfSync: apps.filter((app) => app.sync === "OutOfSync").length,
  };

  return (
    <div className="argo-view">
      <div className="helm-toolbar">
        <span className="chip ok-chip">{counts.healthy} healthy</span>
        {counts.degraded ? <span className="chip bad-chip">{counts.degraded} degraded</span> : null}
        {counts.outOfSync ? <span className="chip warn-chip">{counts.outOfSync} out of sync</span> : null}
        <label className="check">
          <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
          Problems only
        </label>
        <span className="muted">{apps.length} application{apps.length === 1 ? "" : "s"} · refreshes every 10s</span>
      </div>
      {apps.length === 0 ? <p className="empty-state">No Argo CD Applications in this cluster.</p> : (
        <ResourceTable
          rows={rows}
          tableId="ArgoApplication"
          columns={columns}
          selectedUid={current ? `${current.namespace}/${current.name}` : null}
          onSelect={(row) => setSelected(row.uid)}
        />
      )}
      {current ? (
        <ArgoPanel
          key={`${current.namespace}/${current.name}`}
          client={client}
          app={current}
          guard={effectiveGuard(guard, current.namespace)}
          onClose={() => setSelected(null)}
          onChanged={() => setTick((value) => value + 1)}
          onNavigate={onNavigate}
          clusters={clusters}
          onOpenCluster={onOpenCluster}
        />
      ) : null}
    </div>
  );
}

function ArgoPanel({ client, app, guard, onClose, onChanged, onNavigate, clusters, onOpenCluster }: {
  clusters: ClusterSummary[];
  onOpenCluster?: (clusterId: string) => void;
  client: ClusterClient;
  app: ArgoApp;
  guard: ContextGuard;
  onClose: () => void;
  onChanged: () => void;
  onNavigate: (ref: ResourceRef) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prune, setPrune] = useState(false);
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const { map: tree, loading: treeLoading } = useChildren(client, app);
  const remote = !inCluster(app);
  const target = remote
    ? clusters.find((cluster) => normalizeServer(cluster.server) === normalizeServer(app.destServer) || cluster.name === app.destServer || cluster.id === app.destServer)
    : undefined;

  async function act(action: "sync" | "refresh" | "hard-refresh" | "rollback" | "disable-autosync", revision?: string) {
    setBusy(action);
    setError(null);
    setOutput(null);
    try {
      setOutput(await client.argoAction({ name: app.name, namespace: app.namespace, action, ...(action === "sync" ? { prune } : {}), ...(revision ? { revision } : {}) }));
      setArmed(false);
      setRollbackTo(null);
      setAutoSyncArmed(false);
      setTyped("");
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Argo CD refused");
    } finally {
      setBusy(null);
    }
  }

  const [rollbackTo, setRollbackTo] = useState<string | null>(null);
  const [autoSyncArmed, setAutoSyncArmed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const resources = app.resources
    .filter((item) => !onlyProblems || item.sync !== "Synced" || (item.health && item.health !== "Healthy"))
    // A workload stays when one of its pods matches, so a pod name finds its Deployment too.
    .filter((item) => !needle
      || matchesSearch(needle, item.kind, item.name, item.namespace, item.sync, item.health)
      || childrenOf(tree, item.kind, item.namespace, item.name).some(({ node }) => matchesSearch(needle, node.kind, node.name, node.status)));
  const running = app.operation?.phase === "Running";
  return (
    <ResizablePanel storageKey="argo" label={`Application ${app.name}`} className="helm-panel argo-panel">
      <header className="helm-head">
        <div>
          <p className="eyebrow">Argo CD application · {app.project}</p>
          <h2>
            {app.name}
            <span className={`status ${tone(app.health)}`}>{app.health}</span>
            <span className={`status ${tone(app.sync)}`}>{app.sync}</span>
            {app.autoSync ? <span className="chip">auto-sync</span> : null}
          </h2>
          <p className="muted mono">{sourceText(app)} → {app.destNamespace || "—"}{inCluster(app) ? "" : ` on ${app.destServer}`}</p>
        </div>
        <div className="helm-head-actions">
          <button type="button" className="icon-btn" disabled={busy !== null} onClick={() => void act("refresh")} title="Compare with Git again">
            <Icon name="refresh" /> {busy === "refresh" ? "Refreshing" : "Refresh"}
          </button>
          <button type="button" className="icon-btn ghost" disabled={busy !== null} onClick={() => void act("hard-refresh")} title="Also drop Argo CD's cached manifests">
            Hard refresh
          </button>
          <button type="button" className="connect icon-btn" disabled={busy !== null || guard.readOnly || running} title={running ? "A sync is running" : guard.readOnly ? "Read-only" : undefined} onClick={() => setArmed(true)}>
            <Icon name="arrow" /> Sync
          </button>
          <button type="button" className="dock-icon ghost" aria-label="Close application" onClick={onClose}><Icon name="x" /></button>
        </div>
      </header>
      {armed ? (
        <form
          className="confirm-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (!guard.protected || typed === app.name) void act("sync");
          }}
        >
          <span>Sync {app.name} to {app.targetRevision}?</span>
          <label className="check"><input type="checkbox" checked={prune} onChange={(event) => setPrune(event.target.checked)} /> Prune (delete what Git no longer has)</label>
          {guard.protected ? (
            <label className="field">
              Type <strong>{app.name}</strong> to confirm
              <input aria-label="Confirm application name" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
            </label>
          ) : null}
          <button type="submit" className="danger" disabled={busy !== null || (guard.protected && typed !== app.name)}>{busy === "sync" ? "Syncing" : "Sync now"}</button>
          <button type="button" onClick={() => setArmed(false)}>Cancel</button>
        </form>
      ) : null}
      {error ? <p className="problem" role="alert">{error}</p> : null}
      {output ? (
        <div className="action-result" role="status">
          <Icon name="check" />
          <span>{output.output}</span>
          <code title="The same thing from a terminal">$ {output.command}</code>
          <button type="button" className="dock-icon ghost" aria-label="Dismiss" onClick={() => setOutput(null)}><Icon name="x" /></button>
        </div>
      ) : null}
      {app.operation ? (
        <p className={`argo-op ${tone(app.operation.phase)}`}>
          {running ? <GazeInline label="" /> : null}
          <strong>Last sync: {app.operation.phase}</strong>
          {app.operation.finishedAt ? <span className="muted"> · {formatAge(app.operation.finishedAt)} ago</span> : null}
          {app.operation.message ? <span> · {app.operation.message}</span> : null}
        </p>
      ) : null}
      {app.healthMessage ? <p className="muted">{app.healthMessage}</p> : null}
      {app.conditions.map((condition, index) => (
        <p key={index} className="warn-note"><strong>{condition.type}</strong> {condition.message}</p>
      ))}
      {app.history.length > 0 ? (
        <section className="argo-history" aria-label="Sync history">
          <button type="button" className="link-btn" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
            {historyOpen ? "▾" : "▸"} History · {app.history.length} sync{app.history.length === 1 ? "" : "s"}
          </button>
          {historyOpen ? (
            <>
              {app.autoSync ? (
                <div className="argo-autosync">
                  <span>Auto-sync is on, so a rollback would be undone at the next sync. Turn it off first; if this Application is itself in Git (app of apps), Git turns it back on.</span>
                  {autoSyncArmed ? (
                    <>
                      <button type="button" className="danger" disabled={busy !== null || guard.readOnly} onClick={() => void act("disable-autosync")}>Turn off auto-sync now</button>
                      <button type="button" onClick={() => setAutoSyncArmed(false)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className="icon-btn" disabled={guard.readOnly} onClick={() => setAutoSyncArmed(true)}>Turn off auto-sync</button>
                  )}
                </div>
              ) : null}
              <ul className="argo-history-list">
                {app.history.map((entry, index) => {
                  const current = index === 0;
                  return (
                    <li key={entry.id}>
                      <span className="helm-rev">#{entry.id}</span>
                      <span className="mono">{entry.revision.slice(0, 10)}</span>
                      <span className="muted">{entry.deployedAt ? `${formatAge(entry.deployedAt)} ago` : ""}</span>
                      <span className="muted mono">{entry.source}</span>
                      {current ? <span className="chip">deployed</span> : (
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={app.autoSync || guard.readOnly || busy !== null}
                          title={app.autoSync ? "Turn off auto-sync first" : undefined}
                          onClick={() => {
                            setRollbackTo(entry.revision);
                            setTyped("");
                          }}
                        >
                          <Icon name="refresh" /> Roll back here
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {rollbackTo ? (
                <form
                  className="confirm-bar"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!guard.protected || typed === app.name) void act("rollback", rollbackTo);
                  }}
                >
                  <span>Sync {app.name} back to {rollbackTo.slice(0, 10)}? It shows OutOfSync until Git matches again.</span>
                  {guard.protected ? (
                    <label className="field">
                      Type <strong>{app.name}</strong> to confirm
                      <input aria-label="Confirm application name for rollback" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
                    </label>
                  ) : null}
                  <button type="submit" className="danger" disabled={busy !== null || (guard.protected && typed !== app.name)}>Roll back now</button>
                  <button type="button" onClick={() => setRollbackTo(null)}>Cancel</button>
                </form>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      {remote ? (
        <div className="argo-remote">
          <span>
            Deploys to <strong>{app.destServer}</strong>, another cluster. Argo CD lists only what it manages from Git, so the pods and
            ReplicaSets those create are visible from that cluster.
          </span>
          {target && onOpenCluster ? (
            <button type="button" className="connect icon-btn" onClick={() => onOpenCluster(target.id)}><Icon name="arrow" /> Open {target.name}</button>
          ) : <span className="muted">Add that cluster to your kubeconfig to open it here.</span>}
        </div>
      ) : null}
      <div className="argo-resources-head">
        <h3>Resources <span className="muted">{app.resources.length}{treeLoading ? " · finding pods…" : ""}</span></h3>
        <PanelSearchBox value={query} onChange={setQuery} placeholder="Find resources and pods" label="Find in application" />
        <label className="check"><input type="checkbox" checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} /> Only out of sync or unhealthy</label>
      </div>
      {needle && resources.length === 0 ? <p className="muted">Nothing in this application matches.</p> : null}
      <ul className="argo-resources">
        {resources.map((item) => {
          const entry = inCluster(app) ? entryForApiKind(item.kind, item.group ? `${item.group}/v1` : "v1") : undefined;
          const label = (
            <>
              <span className="related-kind">{item.kind}</span>
              <span className="related-name">{item.name}</span>
              {item.namespace ? <span className="muted">{item.namespace}</span> : <span />}
              <span className={`status ${tone(item.sync)}`}>{item.sync}</span>
              {item.health ? <span className={`status ${tone(item.health)}`} title={item.message}>{item.health}</span> : <span />}
            </>
          );
          const parentMatches = matchesSearch(needle, item.kind, item.name, item.namespace, item.sync, item.health);
          const kids = childrenOf(tree, item.kind, item.namespace, item.name)
            .filter(({ node }) => parentMatches || matchesSearch(needle, node.kind, node.name, node.status));
          return (
            <li key={`${item.group}/${item.kind}/${item.namespace}/${item.name}`}>
              {entry ? (
                <button type="button" className="argo-resource" onClick={() => onNavigate({ kind: entry.kind, namespace: entry.namespaced ? item.namespace || null : null, name: item.name })}>{label}</button>
              ) : <div className="argo-resource">{label}</div>}
              {kids.length > 0 ? (
                <ul className="argo-children">
                  {kids.map(({ node, depth }) => (
                    <li key={node.id}>
                      <button
                        type="button"
                        className="argo-resource child"
                        style={{ paddingLeft: 8 + depth * 18 }}
                        onClick={() => onNavigate({ kind: node.kind, namespace: node.namespace, name: node.name })}
                      >
                        <span className="related-kind"><i aria-hidden="true">└</i> {node.kind}</span>
                        <span className="related-name">{node.name}</span>
                        <span className="muted">{node.namespace}</span>
                        <span />
                        {node.status ? <span className={`status ${tone(node.status === "Running" || node.status === "Available" || node.status === "Complete" || node.status === "Completed" ? "Healthy" : node.status === "Progressing" || node.status === "Pending" || node.status === "ContainerCreating" ? "Progressing" : "Degraded")}`}>{node.status}</span> : <span />}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ResizablePanel>
  );
}
