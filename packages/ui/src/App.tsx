import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerCustomKinds, type ClusterAlert, type ClusterClient, type ClusterSummary, type DeploymentRow, type NodeRow, type PodRow, type ResourceRef, type ResourceRow, type RowBatch, type Session } from "@podgaze/contracts";
import { ClusterHome } from "./home";
import { Splash } from "./loader";
import { CommandPalette, type PaletteObject } from "./palette";
import { applyDocumentSettings, getSettings, useSettings } from "./settings";
import { SettingsPage } from "./settings-page";
import { Base64Tool } from "./secret-view";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { Titlebar } from "./titlebar";
import { UpdateNotice } from "./update-notice";
import { isToolView, Workspace, type WorkspaceView } from "./workspace";
import { useZoomKeys } from "./zoom";

const initialSession: Session = {
  state: "disconnected",
  clusterId: null,
  namespace: null,
  kubeconfigPath: null,
  problem: null,
  namespaces: [],
  guard: { protected: false, readOnly: false },
  forbidden: {},
};

type Place = { view: WorkspaceView; selected: ResourceRef | null };

function samePlace(left: Place | undefined, right: Place): boolean {
  return Boolean(left)
    && left!.view === right.view
    && left!.selected?.kind === right.selected?.kind
    && left!.selected?.name === right.selected?.name
    && left!.selected?.namespace === right.selected?.namespace;
}

function applyRows<T extends { uid: string }>(
  current: Map<string, T>,
  epochs: Map<string, number>,
  change: { reset?: boolean; upsert: T[]; delete: string[] } | undefined,
): { rows: Map<string, T>; epochs: Map<string, number> } {
  if (!change) return { rows: current, epochs };
  const rows = change.reset ? new Map<string, T>() : new Map(current);
  const nextEpochs = new Map(epochs);
  if (!change.reset) {
    for (const uid of change.delete) rows.delete(uid);
  }
  for (const row of change.upsert) {
    rows.set(row.uid, row);
    nextEpochs.set(row.uid, (epochs.get(row.uid) ?? 0) + 1);
  }
  return { rows, epochs: nextEpochs };
}

// One pass over a batch: a changed object's counter goes up (its details panel refetches), a deleted one's goes away.
// Returns the same map when nothing changed, so nothing that depends on it re-renders.
export function bumpEpochs(current: Map<string, number>, batch: RowBatch): Map<string, number> {
  const changes = [batch.pods, batch.nodes, batch.deployments, batch.resources].filter((change) => change && (change.upsert.length > 0 || change.delete.length > 0));
  if (changes.length === 0) return current;
  const next = new Map(current);
  for (const change of changes) {
    for (const uid of change!.delete) next.delete(uid);
    for (const row of change!.upsert) next.set(row.uid, (current.get(row.uid) ?? 0) + 1);
  }
  return next;
}

function paletteObjects(pods: PodRow[], deployments: DeploymentRow[], nodes: NodeRow[], resources: ResourceRow[]): PaletteObject[] {
  return [
    ...pods.map((row) => ({ kind: "Pod" as const, namespace: row.namespace, name: row.name, status: row.status })),
    ...deployments.map((row) => ({ kind: "Deployment" as const, namespace: row.namespace, name: row.name, status: row.status })),
    ...nodes.map((row) => ({ kind: "Node" as const, namespace: null, name: row.name, status: row.status })),
    ...resources.map((row) => ({ kind: row.kind, namespace: row.namespace || null, name: row.name, status: row.status })),
  ];
}

// The start screen stays at least this long so it reads as a screen, not a flicker.
const SPLASH_MS = 1100;
const SPLASH_MAX_MS = 5000;

export function App({ client, splashMs = SPLASH_MS }: { client: ClusterClient; splashMs?: number }) {
  // Read once: turning the start screen off in Settings takes effect at the next launch.
  const [splash] = useState(() => (getSettings().showSplash ? splashMs : 0));
  const [booting, setBooting] = useState(splash > 0);
  const settings = useSettings();
  useZoomKeys();
  const [session, setSession] = useState<Session>(initialSession);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [pods, setPods] = useState<Map<string, PodRow>>(() => new Map());
  const [nodes, setNodes] = useState<Map<string, NodeRow>>(() => new Map());
  const [deployments, setDeployments] = useState<Map<string, DeploymentRow>>(() => new Map());
  const [resources, setResources] = useState<Map<string, ResourceRow>>(() => new Map());
  const [epochs, setEpochs] = useState<Map<string, number>>(() => new Map());
  const [view, setView] = useState<WorkspaceView>(() => getSettings().startView);
  // Home is a local switch: it shows the cluster list at once instead of waiting for the disconnect to report back.
  const [home, setHome] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [base64Open, setBase64Open] = useState(false);
  const [toasts, setToasts] = useState<ClusterAlert[]>([]);
  // An object to open once its cluster's tab is on screen.
  const pendingOpen = useRef<{ clusterId: string; ref: ResourceRef } | null>(null);
  const [selected, setSelected] = useState<ResourceRef | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<{ stack: Place[]; index: number }>(() => ({ stack: [{ view: getSettings().startView, selected: null }], index: 0 }));
  // A jump to another kind or namespace selects the object before its rows arrive; keep that selection while they load.
  const arriving = useRef<{ ref: ResourceRef; until: number } | null>(null);
  const [reveal, setReveal] = useState(0);
  const [loadedView, setLoadedView] = useState<WorkspaceView | null>(null);
  // What each open cluster tab was showing, so switching back lands where you left it.
  const places = useRef(new Map<string, Place>());
  const placeNow = useRef<Place>({ view, selected });
  placeNow.current = { view, selected };

  useEffect(() => {
    let clusterId: string | null = null;
    const unsubSession = client.onSession((next) => {
      if (next.customKinds) registerCustomKinds(next.customKinds);
      if (clusterId !== next.clusterId) {
        if (clusterId) places.current.set(clusterId, placeNow.current);
        const stillOpen = new Set((next.open ?? []).map((tab) => tab.id));
        for (const id of [...places.current.keys()]) if (!stillOpen.has(id)) places.current.delete(id);
        clusterId = next.clusterId;
        setPods(new Map());
        setNodes(new Map());
        setDeployments(new Map());
        setResources(new Map());
        const restored = next.clusterId ? places.current.get(next.clusterId) : undefined;
        const start = restored ?? { view: getSettings().startView, selected: null };
        if (start.selected) arriving.current = { ref: start.selected, until: Date.now() + 8000 };
        setSelected(start.selected);
        setView(start.view);
        setHistory({ stack: [start], index: 0 });
        if (next.clusterId) setHome(false);
      }
      setSession(next);
    });
    const unsubRows = client.subscribeRows((batch: RowBatch) => {
      setPods((current) => applyRows(current, new Map(), batch.pods).rows);
      setNodes((current) => applyRows(current, new Map(), batch.nodes).rows);
      setDeployments((current) => applyRows(current, new Map(), batch.deployments).rows);
      setResources((current) => applyRows(current, new Map(), batch.resources).rows);
      // A reset is the first answer for the kind on screen; until then an empty table means "loading", not "none".
      if (batch.resources?.reset) setLoadedView(placeNow.current.view);
      setEpochs((current) => bumpEpochs(current, batch));
    });
    const started = Date.now();
    let ready = false;
    const finish = () => {
      if (ready) return;
      ready = true;
      window.setTimeout(() => setBooting(false), Math.max(0, splash - (Date.now() - started)));
    };
    // A kubeconfig that hangs (a slow network share) must not trap the user on the start screen.
    const giveUp = window.setTimeout(finish, SPLASH_MAX_MS);
    void client.listClusters().then(setClusters).finally(finish);
    return () => {
      window.clearTimeout(giveUp);
      unsubSession();
      unsubRows();
    };
  }, [client]);

  useEffect(() => {
    void client.setNotifications(settings.alerts).catch(() => undefined);
  }, [client, settings.alerts]);

  useEffect(() => {
    const stopAlert = client.onAlert((alert) => {
      if (!getSettings().alerts) return;
      setToasts((current) => [alert, ...current.filter((item) => item.id !== alert.id)].slice(0, 4));
      window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== alert.id)), 12_000);
    });
    const stopOpen = client.onAlertOpen((alert) => openAlert(alert));
    return () => {
      stopAlert();
      stopOpen();
    };
  }, [client]);

  useEffect(() => {
    const pending = pendingOpen.current;
    if (!pending || session.clusterId !== pending.clusterId || session.state !== "connected") return;
    pendingOpen.current = null;
    if (pending.ref.kind === "applications.argoproj.io") show("Argo");
    else navigate(pending.ref);
  }, [session.clusterId, session.state]);

  useEffect(() => {
    applyDocumentSettings(settings);
    if (settings.theme !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const follow = () => applyDocumentSettings(getSettings());
    query.addEventListener?.("change", follow);
    return () => query.removeEventListener?.("change", follow);
  }, [settings]);

  useEffect(() => {
    if (!selected) return;
    const pending = arriving.current;
    if (pending && pending.until > Date.now() && pending.ref.kind === selected.kind && pending.ref.name === selected.name && pending.ref.namespace === selected.namespace) {
      const present = selected.kind === "Pod"
        ? [...pods.values()].some((pod) => pod.name === selected.name && pod.namespace === (selected.namespace ?? ""))
        : selected.kind === "Deployment"
          ? [...deployments.values()].some((deployment) => deployment.name === selected.name && deployment.namespace === (selected.namespace ?? ""))
          : selected.kind === "Node"
            ? [...nodes.values()].some((node) => node.name === selected.name)
            : [...resources.values()].some((row) => row.kind === selected.kind && row.name === selected.name && row.namespace === (selected.namespace ?? ""));
      if (!present) return;
      arriving.current = null;
    }
    const found = selected.kind === "Pod"
      ? [...pods.values()].some((pod) => pod.name === selected.name && pod.namespace === (selected.namespace ?? ""))
      : selected.kind === "Deployment"
        ? [...deployments.values()].some((deployment) => deployment.name === selected.name && deployment.namespace === (selected.namespace ?? ""))
        : selected.kind === "Node"
          ? [...nodes.values()].some((node) => node.name === selected.name)
          : [...resources.values()].some((row) => row.kind === selected.kind && row.name === selected.name && row.namespace === (selected.namespace ?? ""));
    if (!found) setSelected(null);
  }, [pods, nodes, deployments, resources, selected]);

  useEffect(() => {
    if (session.state === "disconnected" || isToolView(view)) return;
    void client.setFocus(view);
  }, [client, session.clusterId, session.state, view]);

  useEffect(() => {
    if (session.state === "disconnected") {
      setCounts({});
      return;
    }
    let cancelled = false;
    void client.listCounts().then((next) => {
      if (!cancelled) setCounts(next);
    }).catch(() => {
      if (!cancelled) setCounts({});
    });
    return () => {
      cancelled = true;
    };
  }, [client, session.clusterId, session.namespace, session.state, session.customKinds?.length ?? 0]);

  const record = useCallback((place: Place) => {
    setHistory((current) => {
      if (samePlace(current.stack[current.index], place)) return current;
      const stack = [...current.stack.slice(0, current.index + 1), place].slice(-50);
      return { stack, index: stack.length - 1 };
    });
  }, []);

  function step(delta: number) {
    const index = history.index + delta;
    const place = history.stack[index];
    if (!place) return;
    if (place.selected) arriving.current = { ref: place.selected, until: Date.now() + 8000 };
    setView(place.view);
    setSelected(place.selected);
    if (place.selected) setReveal((value) => value + 1);
    setHistory({ ...history, index });
  }
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        stepRef.current(event.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function chooseFile() {
    const picked = await client.pickKubeconfig();
    if (!picked) return;
    setClusters(await client.listClusters());
  }

  function show(next: WorkspaceView) {
    setView(next);
    setSelected(null);
    record({ view: next, selected: null });
  }

  function choose(ref: ResourceRef | null) {
    setSelected(ref);
    if (ref) record({ view, selected: ref });
  }

  // Opens any object: switches to its kind, and to its namespace when the current filter would hide it.
  function navigate(ref: ResourceRef) {
    arriving.current = { ref, until: Date.now() + 8000 };
    if (ref.namespace && session.namespace !== null && session.namespace !== ref.namespace) {
      void client.setNamespace(ref.namespace);
    }
    setView(ref.kind);
    setSelected(ref);
    setReveal((value) => value + 1);
    record({ view: ref.kind, selected: ref });
  }

  function connect(id: string) {
    setHome(false);
    setPaletteOpen(false);
    void client.connect(id);
  }

  // Opens an object wherever it lives: on screen now, or after switching to its cluster's tab.
  function openIn(clusterId: string, ref: ResourceRef) {
    setPaletteOpen(false);
    if (clusterId === session.clusterId && !home && session.state === "connected") {
      if (ref.kind === "applications.argoproj.io") show("Argo");
      else navigate(ref);
      return;
    }
    pendingOpen.current = { clusterId, ref };
    connect(clusterId);
  }
  const openInRef = useRef(openIn);
  openInRef.current = openIn;

  function openAlert(alert: ClusterAlert) {
    setToasts((current) => current.filter((item) => item.id !== alert.id));
    openInRef.current(alert.clusterId, { kind: alert.kind, namespace: alert.namespace, name: alert.name });
  }

  // Home keeps the open clusters connected; their tabs come back when you pick one.
  function goHome() {
    setHome(true);
    setPaletteOpen(false);
  }

  function closeCluster(id: string) {
    const others = (session.open ?? []).filter((tab) => tab.id !== id);
    places.current.delete(id);
    void client.closeCluster(id).then(() => {
      // Closing the tab on screen moves to the next open one instead of dropping to Home.
      if (id === session.clusterId && others[0] && !home) connect(others[0].id);
    }, () => undefined);
  }

  // Change counters only matter for objects that exist; resets (tab switch, namespace change) leave old ones
  // behind, so drop them once they clearly outnumber the live rows.
  useEffect(() => {
    const live = pods.size + nodes.size + deployments.size + resources.size;
    if (epochs.size <= live + 500) return;
    setEpochs((current) => {
      const next = new Map<string, number>();
      for (const rows of [pods, nodes, deployments, resources] as Map<string, unknown>[]) for (const uid of rows.keys()) {
        const value = current.get(uid);
        if (value !== undefined) next.set(uid, value);
      }
      return next;
    });
  }, [pods, nodes, deployments, resources, epochs.size]);

  const showWorkspace = !home && session.state !== "disconnected";
  // Stable arrays: a new array on every render would make every list below recompute even when no row changed.
  const podList = useMemo(() => [...pods.values()], [pods]);
  const nodeList = useMemo(() => [...nodes.values()], [nodes]);
  const deploymentList = useMemo(() => [...deployments.values()], [deployments]);
  const resourceList = useMemo(() => [...resources.values()], [resources]);
  const openIds = useMemo(() => new Set((session.open ?? []).map((tab) => tab.id)), [session.open]);
  // The palette's object list is only built while the palette is open.
  const paletteList = useMemo(
    () => (paletteOpen ? paletteObjects(podList, deploymentList, nodeList, resourceList) : []),
    [paletteOpen, podList, deploymentList, nodeList, resourceList],
  );

  return (
    <div className="app-frame">
      <Titlebar />
      <div className="app-body">
      <div className="app-scale">
      {booting ? <Splash /> : showWorkspace ? (
        <Workspace
          session={session}
          clusters={clusters}
          pods={podList}
          nodes={nodeList}
          deployments={deploymentList}
          resources={resourceList}
          counts={counts}
          view={view}
          selected={selected}
          epochs={epochs}
          client={client}
          onView={show}
          onSelect={choose}
          onNavigate={navigate}
          reveal={reveal}
          canBack={history.index > 0}
          canForward={history.index < history.stack.length - 1}
          onBack={() => step(-1)}
          onForward={() => step(1)}
          onOpenPalette={() => setPaletteOpen(true)}
          onHome={goHome}
          onSettings={() => setSettingsOpen(true)}
          onSwitchCluster={connect}
          onOpenIn={openIn}
          resourcesLoaded={loadedView === view}
          onCloseCluster={closeCluster}
        />
      ) : (
        <ClusterHome
          clusters={clusters}
          session={session}
          client={client}
          onConnect={connect}
          onSettings={() => setSettingsOpen(true)}
          openIds={openIds}
          onPick={() => void chooseFile()}
          onContextsChanged={() => void client.listClusters().then(setClusters)}
        />
      )}
      {booting ? null : <UpdateNotice client={client} />}
      {paletteOpen ? (
        <CommandPalette
          clusters={clusters}
          namespaces={session.namespaces}
          objects={showWorkspace ? paletteList : []}
          onOpen={navigate}
          onClose={() => setPaletteOpen(false)}
          onKind={(kind) => show(kind)}
          onOverview={() => show("Overview")}
          onNamespace={(namespace) => void client.setNamespace(namespace)}
          onCluster={connect}
          onHome={goHome}
          onSettings={() => setSettingsOpen(true)}
          onBase64={() => {
            setPaletteOpen(false);
            setBase64Open(true);
          }}
        />
      ) : null}
      {toasts.length > 0 ? (
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((alert) => (
            <div key={alert.id} className="toast">
              <button type="button" className="toast-body" onClick={() => openAlert(alert)}>
                <strong>{alert.reason}</strong>
                <span>{alert.kind === "applications.argoproj.io" ? "Argo CD app" : alert.kind} {alert.namespace ? `${alert.namespace}/` : ""}{alert.name}</span>
                <small>{alert.clusterId}{alert.message ? ` · ${alert.message}` : ""}</small>
              </button>
              <button type="button" className="toast-close" aria-label="Dismiss alert" onClick={() => setToasts((current) => current.filter((item) => item.id !== alert.id))}><Icon name="x" /></button>
            </div>
          ))}
        </div>
      ) : null}
      {base64Open ? createPortal(
        <div className="modal-backdrop" onMouseDown={() => setBase64Open(false)}>
          <section className="context-panel" role="dialog" aria-modal="true" aria-label="Base64 encode and decode" onMouseDown={(event) => event.stopPropagation()}>
            <header className="context-head">
              <div>
                <p className="eyebrow">Tool</p>
                <h2>Base64</h2>
              </div>
              <button type="button" className="dock-icon ghost" aria-label="Close Base64 tool" onClick={() => setBase64Open(false)}><Icon name="x" /></button>
            </header>
            <Base64Tool />
          </section>
        </div>,
        document.body,
      ) : null}
      {settingsOpen ? (
        <SettingsPage
          client={client}
          kubeconfigPath={session.kubeconfigPath}
          onKubeconfigChanged={() => void client.listClusters().then(setClusters)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      </div>
      </div>
    </div>
  );
}
