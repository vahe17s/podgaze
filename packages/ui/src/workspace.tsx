import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { canExec, catalog, catalogEntry, catalogGroups, kubectlName, type CatalogEntry, type ContextGuard, type ClusterClient, type ClusterSummary, type DeploymentRow, type NodeRow, type PodRow, type ResourceKind, type ResourceRef, type ResourceRow, type Session } from "@podgaze/contracts";
import { AccessView } from "./access-view";
import { CertificatesView } from "./certs-view";
import { CostView } from "./cost-view";
import { TeamView } from "./team-view";
import { LogSearchView, type LogSearchStart } from "./log-search-view";
import { CompareView } from "./compare-view";
import { ForwardsView, useAutoStartForwards } from "./forwards-view";
import { ImagesView } from "./images-view";
import { ArgoView } from "./argo-view";
import { MapView } from "./map-view";
import { ProjectsView } from "./projects-view";
import { ActivityView } from "./activity-view";
import { CreateDialog } from "./create-dialog";
import { labelText, matchesFilter, parseFilter } from "./filter";
import { isHealthy, statusTone } from "./format";
import { effectiveGuard } from "./guards";
import { HelmView } from "./helm-view";
import { usePins } from "./pins";
import { useUsage } from "./usage";
import { Icon } from "./icons";
import { Inspector } from "./inspector";
import { GazeLoader } from "./loader";
import { WatchingLogo } from "./logo";
import { menuFor, RowMenu, type MenuAction, type MenuContext, type MenuSection } from "./menu";
import { canForward as forwardable } from "./port-forward";
import { SearchSelect } from "./search-select";
import { useSettings } from "./settings";
import { Overview } from "./overview";
import { ResourceTable, type TableColumn } from "./table";
import { TerminalPane } from "./lazy";
import { ThemeToggle } from "./theme";

export type ToolView = "Overview" | "Map" | "Projects" | "Argo" | "Helm" | "Activity" | "Access" | "Compare" | "Images" | "Certificates" | "Forwards" | "Cost" | "LogSearch" | "Team";
export type WorkspaceView = ToolView | ResourceKind;

export const toolViews: readonly string[] = ["Overview", "Map", "Projects", "Argo", "Helm", "Activity", "Access", "Compare", "Images", "Certificates", "Forwards", "Cost", "LogSearch", "Team"];

export function isToolView(view: string): view is ToolView {
  return toolViews.includes(view);
}

const toolTitles: Record<ToolView, string> = {
  Overview: "Overview",
  Map: "Map",
  Projects: "Projects",
  Argo: "Argo CD",
  Helm: "Helm releases",
  Activity: "Activity",
  Access: "Access check",
  Compare: "Compare environments",
  Images: "Image versions",
  Certificates: "Certificates and expiry",
  Forwards: "Port forwards",
  Cost: "Cost",
  LogSearch: "Log search",
  Team: "Namespace page",
};

const labelsColumn = <T extends { labels?: Record<string, string> }>(): TableColumn<T> => ({
  key: "labels",
  header: "Labels",
  width: "1.4fr",
  cell: (row) => labelText(row.labels),
  optional: true,
});

const shellRequest = { mode: "shell" } as const;

const podColumns = (showNamespace: boolean): TableColumn<PodRow>[] => [
  { key: "name", header: "Name", width: "1.4fr", cell: (row) => row.name },
  { key: "status", header: "Status", width: "1.15fr", cell: (row) => row.status, status: true },
  { key: "ready", header: "Ready", width: "0.45fr", cell: (row) => row.ready },
  { key: "restarts", header: "Restarts", width: "0.5fr", cell: (row) => String(row.restarts) },
  { key: "lastExit", header: "Last exit", width: "0.8fr", cell: (row) => row.lastExit },
  { key: "ip", header: "IP", width: "0.8fr", cell: (row) => row.ip },
  { key: "node", header: "Node", width: "0.9fr", cell: (row) => row.nodeName },
  ...(showNamespace ? [{ key: "namespace", header: "Namespace", width: "0.8fr", cell: (row: PodRow) => row.namespace }] : []),
  labelsColumn<PodRow>(),
  { key: "age", header: "Age", width: "0.4fr", cell: (row) => row.ageStart },
];

const nodeColumns: TableColumn<NodeRow>[] = [
  { key: "name", header: "Name", width: "1.3fr", cell: (row) => row.name },
  { key: "status", header: "Status", width: "0.7fr", cell: (row) => row.status, status: true },
  { key: "roles", header: "Roles", width: "0.8fr", cell: (row) => row.roles.join(", ") },
  { key: "ip", header: "IP", width: "0.8fr", cell: (row) => row.internalIP },
  { key: "cpu", header: "CPU", width: "0.4fr", cell: (row) => row.cpu },
  { key: "memory", header: "Memory", width: "0.5fr", cell: (row) => row.memory },
  { key: "version", header: "Kubelet", width: "0.7fr", cell: (row) => row.kubeletVersion },
  labelsColumn<NodeRow>(),
  { key: "age", header: "Age", width: "0.4fr", cell: (row) => row.ageStart },
];

const deploymentColumns = (showNamespace: boolean): TableColumn<DeploymentRow>[] => [
  { key: "name", header: "Name", width: "1.4fr", cell: (row) => row.name },
  ...(showNamespace ? [{ key: "namespace", header: "Namespace", width: "0.9fr", cell: (row: DeploymentRow) => row.namespace }] : []),
  { key: "status", header: "Status", width: "0.8fr", cell: (row) => row.status, status: true },
  { key: "ready", header: "Ready", width: "0.5fr", cell: (row) => row.ready },
  { key: "updated", header: "Updated", width: "0.5fr", cell: (row) => row.updated },
  { key: "available", header: "Available", width: "0.55fr", cell: (row) => row.available },
  labelsColumn<DeploymentRow>(),
  { key: "age", header: "Age", width: "0.4fr", cell: (row) => row.ageStart },
];

function resourceColumns(kind: ResourceKind, showNamespace: boolean): TableColumn<ResourceRow>[] {
  const entry = catalogEntry(kind);
  return [
    { key: "name", header: "Name", width: "1.2fr", cell: (row) => row.name },
    { key: "status", header: "Status", width: "0.7fr", cell: (row) => row.status, status: true },
    ...(entry?.columns ?? []).map((column) => ({
      key: column.key,
      header: column.header,
      width: column.width,
      cell: (row: ResourceRow) => row.columns[column.key] ?? "",
      status: column.status,
      age: column.age,
    })),
    ...(showNamespace && entry?.namespaced ? [{ key: "namespace", header: "Namespace", width: "0.8fr", cell: (row: ResourceRow) => row.namespace }] : []),
    labelsColumn<ResourceRow>(),
    { key: "age", header: "Age", width: "0.4fr", cell: (row: ResourceRow) => row.ageStart },
  ];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function Workspace({
  session,
  clusters,
  pods,
  nodes,
  deployments,
  resources,
  counts,
  view,
  selected,
  epochs,
  client,
  onView,
  onSelect,
  onNavigate,
  reveal = 0,
  canBack,
  canForward,
  onBack,
  onForward,
  onOpenPalette,
  onHome,
  onSettings,
  onSwitchCluster,
  onCloseCluster,
  onOpenIn,
  resourcesLoaded = true,
}: {
  session: Session;
  clusters: ClusterSummary[];
  pods: PodRow[];
  nodes: NodeRow[];
  deployments: DeploymentRow[];
  resources: ResourceRow[];
  counts: Record<string, number>;
  view: WorkspaceView;
  selected: ResourceRef | null;
  epochs: Map<string, number>;
  client: ClusterClient;
  onView: (view: WorkspaceView) => void;
  onSelect: (ref: ResourceRef | null) => void;
  onNavigate: (ref: ResourceRef) => void;
  reveal?: number;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onOpenPalette: () => void;
  onHome: () => void;
  onSettings: () => void;
  onSwitchCluster?: (clusterId: string) => void;
  onCloseCluster?: (clusterId: string) => void;
  // Opens an object in any open cluster, switching tabs when needed.
  onOpenIn?: (clusterId: string, ref: ResourceRef) => void;
  // False until the first rows for the kind on screen arrive, so an empty table is not called empty too early.
  resourcesLoaded?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [customQuery, setCustomQuery] = useState("");
  const [hideEmpty, setHideEmpty] = useState(() => {
    try {
      return localStorage.getItem("podgaze.hideEmptyCustom") !== "0";
    } catch {
      return true;
    }
  });
  const [safetyOpen, setSafetyOpen] = useState(false);
  const safetyRef = useRef<HTMLDivElement>(null);
  const pins = usePins(session.clusterId);
  useAutoStartForwards(client, session);
  const openClusterIds = (session.open ?? []).map((tab) => tab.id);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const [dockHeight, setDockHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("podgaze.dock"));
      return saved >= 160 && saved <= 2000 ? saved : 320;
    } catch {
      return 320;
    }
  });
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Set from a node's "Pods on node"; narrows the pod table to that node until cleared.
  const [nodeFilter, setNodeFilter] = useState<string | null>(null);
  const [logSearchStart, setLogSearchStart] = useState<LogSearchStart | null>(null);
  const [pending, setPending] = useState<{ id: number; action: MenuAction } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ref: ResourceRef; uid: string; sections: MenuSection[] } | null>(null);
  const [dockTab, setDockTab] = useState<"details" | "shell">("details");
  const [nameCopied, setNameCopied] = useState(false);
  const [shellOn, setShellOn] = useState(false);
  const [terminalToken, setTerminalToken] = useState(0);
  const [openGroups, setOpenGroups] = useState<string[]>(["Workloads"]);
  const [minimized, setMinimized] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("podgaze.sidebar"));
    return saved >= 200 && saved <= 480 ? saved : 248;
  });
  const settings = useSettings();
  const currentCluster = clusters.find((cluster) => cluster.id === session.clusterId);
  const needle = filter.trim().toLowerCase();
  const parsed = useMemo(() => parseFilter(filter), [filter]);
  // Filtering is cached per input, so opening a menu, resizing the panel, or typing in the editor does not
  // re-filter thousands of rows; only a new batch or a new filter does.
  const visiblePods = useMemo(() => {
    const failing = (pod: PodRow) => !problemsOnly || statusTone(pod.status) !== "ok" || (pod.restarts > 0 && pod.lastExit !== "");
    return pods.filter((pod) => matchesFilter(pod, parsed) && (!nodeFilter || pod.nodeName === nodeFilter) && failing(pod));
  }, [pods, parsed, nodeFilter, problemsOnly]);
  const visibleNodes = useMemo(() => nodes.filter((node) => matchesFilter(node, parsed) && (!problemsOnly || statusTone(node.status) !== "ok")), [nodes, parsed, problemsOnly]);
  const visibleDeployments = useMemo(
    () => deployments.filter((deployment) => matchesFilter(deployment, parsed) && (!problemsOnly || statusTone(deployment.status) !== "ok")),
    [deployments, parsed, problemsOnly],
  );
  const visibleResources = useMemo(() => (view === "Event"
    ? resources
      .filter((row) => row.kind === "Event" && (!warningsOnly || row.status === "Warning"))
      .filter((row) => !needle || [row.name, row.columns.object ?? "", row.columns.reason ?? "", row.columns.message ?? ""].some((text) => text.toLowerCase().includes(needle)))
      .sort((left, right) => (right.columns.lastSeen ?? "").localeCompare(left.columns.lastSeen ?? ""))
    : resources.filter((row) => row.kind === view && matchesFilter(row, parsed) && (!problemsOnly || statusTone(row.status) !== "ok"))), [resources, view, warningsOnly, needle, parsed, problemsOnly]);
  const blocked = isToolView(view) ? undefined : session.forbidden[view];
  const connecting = session.state === "connecting";
  const selectedPod = selected?.kind === "Pod"
    ? pods.find((pod) => pod.name === selected.name && pod.namespace === (selected.namespace ?? "")) ?? null
    : null;
  const selectedNode = selected?.kind === "Node" ? nodes.find((node) => node.name === selected.name) ?? null : null;
  const selectedDeployment = selected?.kind === "Deployment"
    ? deployments.find((deployment) => deployment.name === selected.name && deployment.namespace === (selected.namespace ?? "")) ?? null
    : null;
  const selectedResource = selected && selected.kind !== "Pod" && selected.kind !== "Node" && selected.kind !== "Deployment"
    ? resources.find((row) => row.kind === selected.kind && row.name === selected.name && row.namespace === (selected.namespace ?? "")) ?? null
    : null;
  const selectedUid = selectedPod?.uid ?? selectedNode?.uid ?? selectedDeployment?.uid ?? selectedResource?.uid ?? null;
  const epoch = selectedUid ? epochs.get(selectedUid) ?? 0 : 0;
  const running = useMemo(() => pods.filter((pod) => isHealthy(pod.status)).length, [pods]);
  const readyNodes = useMemo(() => nodes.filter((node) => node.status.startsWith("Ready")).length, [nodes]);
  const entry = isToolView(view) ? undefined : catalogEntry(view);
  const title = isToolView(view) ? toolTitles[view] : entry?.label ?? view;
  const count = view === "Compare"
    ? "The same app side by side, across namespaces and open clusters"
    : view === "Images"
    ? "Which version of each image runs where"
    : view === "Certificates"
    ? "Everything with an expiry date or a sync to watch, soonest first"
    : view === "Forwards"
    ? "Running forwards and saved sets"
    : view === "Team"
    ? "Health, cost, traffic, and expiry for one namespace or team"
    : view === "LogSearch"
    ? "grep every pod of a workload or namespace at once"
    : view === "Cost"
    ? "Node prices split by what each workload requests"
    : view === "Map"
    ? (session.namespace ? `How the objects in ${session.namespace} connect` : "How objects connect, all namespaces")
    : view === "Projects"
    ? "Apps made of several namespaces and labels"
    : view === "Argo"
    ? "Applications managed by Argo CD"
    : view === "Helm"
    ? "Read from release Secrets"
    : view === "Activity"
    ? "Changes made from Podgaze"
    : view === "Access"
    ? "RBAC: who can do what"
    : view === "Overview"
    ? [plural(pods.length, "pod"), plural(nodes.length, "node"), plural(deployments.length, "deployment")].join(" · ")
    : view === "Pod"
    ? `${visiblePods.length} shown · ${running} running`
    : view === "Node"
      ? `${visibleNodes.length} shown · ${readyNodes} ready`
      : view === "Deployment"
        ? `${visibleDeployments.length} shown`
        : `${visibleResources.length} shown`;
  const open = Boolean(selectedPod || selectedNode || selectedDeployment || selectedResource);
  const dockVisible = open || shellOn;
  // With nothing selected, the only thing the dock can show is the local shell.
  const activeTab = open ? dockTab : "shell";
  const activeGroup = isToolView(view) ? null : catalogEntry(view)?.group ?? null;
  const usageKey = `${session.clusterId ?? ""}:${session.namespace ?? ""}`;
  // Keeps sampling usage while connected, so pod and node trends exist before anyone opens them.
  useUsage(client, session.state === "connected", usageKey);
  const checkedRows = view === "Pod" ? visiblePods.filter((row) => checked.has(row.uid))
    : view === "Deployment" ? visibleDeployments.filter((row) => checked.has(row.uid))
    : view === "Node" ? visibleNodes.filter((row) => checked.has(row.uid))
    : visibleResources.filter((row) => checked.has(row.uid));
  const namespaceGuard = effectiveGuard(session.guard, session.namespace);
  const customAll = session.customKinds ?? [];
  const hasArgo = customAll.some((item) => item.kind === "applications.argoproj.io");
  const customCounted = customAll.some((item) => counts[item.kind] !== undefined);
  // Empty kinds hide once counts are in; the open one always stays so it does not vanish under you.
  const customShown = hideEmpty && customCounted
    ? customAll.filter((item) => (counts[item.kind] ?? 1) > 0 || item.kind === view)
    : customAll;
  const customGroups = groupCustom(customShown, customQuery);
  const emptyKinds = customAll.length - customAll.filter((item) => (counts[item.kind] ?? 1) > 0).length;

  useEffect(() => {
    if (!safetyOpen) return;
    const close = (event: MouseEvent) => {
      if (!safetyRef.current?.contains(event.target as Node)) setSafetyOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [safetyOpen]);

  function onCheck(uids: string[], on: boolean) {
    setChecked((current) => {
      const next = new Set(current);
      for (const uid of uids) {
        if (on) next.add(uid);
        else next.delete(uid);
      }
      return next;
    });
  }

  useEffect(() => {
    if (reveal === 0) return;
    setMinimized(false);
    setDockTab("details");
  }, [reveal]);

  useEffect(() => {
    setChecked(new Set());
  }, [view, session.clusterId, session.namespace]);

  useEffect(() => {
    if (!activeGroup) return;
    setOpenGroups((current) => current.includes(activeGroup) ? current : [...current, activeGroup]);
  }, [activeGroup]);

  function countFor(kind: ResourceKind): number | null {
    if (kind === "Pod") return pods.length;
    if (kind === "Node") return nodes.length;
    if (kind === "Deployment") return deployments.length;
    if (view === kind) return resources.filter((row) => row.kind === kind).length;
    return Object.prototype.hasOwnProperty.call(counts, kind) ? counts[kind] : null;
  }

  // Picking an object always brings its details up; Minimize keeps the bar until the next pick.
  function select(ref: ResourceRef) {
    onSelect(ref);
    setDockTab("details");
    // With auto-open off, a first pick shows only the bar; an already open panel stays as it is.
    if (settings.autoOpenDetails) setMinimized(false);
    else if (!open) setMinimized(true);
  }

  function openShell() {
    setShellOn(true);
    setDockTab("shell");
    setMinimized(false);
  }

  function closeShell() {
    setShellOn(false);
    setDockTab("details");
  }

  // k9s-style keys on the selected row. They stay out of the way while typing in a field, the editor, or a terminal.
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable='true'], .cm-editor, .xterm, [role='dialog']")) return;
    if (event.key === "/") {
      event.preventDefault();
      filterRef.current?.focus();
      return;
    }
    if (!selected) return;
    if (event.key === "Escape") {
      onSelect(null);
      return;
    }
    const commands = catalogEntry(selected.kind)?.commands ?? [];
    const key = event.key.toLowerCase();
    if (key === "l" && canExec(selected.kind)) {
      setMinimized(false);
      setDockTab("details");
      setPending({ id: Date.now(), action: "logs" });
    } else if (key === "s" && canExec(selected.kind)) {
      setMinimized(false);
      setDockTab("details");
      setTerminalToken((value) => value + 1);
    } else if (key === "y") {
      setMinimized(false);
      setDockTab("details");
      setPending({ id: Date.now(), action: "yaml" });
    } else if ((key === "d" && commands.includes("describe")) || (key === "e" && commands.includes("events"))) {
      setMinimized(false);
      setDockTab("details");
      setPending({ id: Date.now(), action: key === "d" ? "describe" : "events" });
    } else {
      return;
    }
    event.preventDefault();
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Right-click only opens the menu. The panel opens when an action is picked, since that is where its result shows.
  function openMenu(ref: ResourceRef, uid: string, x: number, y: number) {
    const row = resources.find((item) => item.uid === uid);
    const host = row?.kind === "Ingress" ? (row.columns.hosts ?? "").split(",")[0]?.trim() : "";
    const context: MenuContext = {
      paused: deployments.find((item) => item.uid === uid)?.paused,
      unschedulable: nodes.find((item) => item.uid === uid)?.unschedulable,
      suspended: row ? row.columns.suspend === "True" : undefined,
      url: host ? `https://${host}` : null,
    };
    setMenu({ x, y, ref, uid, sections: menuFor(ref.kind, context) });
  }

  // Menu items that are not commands: they copy, open, or switch something here.
  function runMenuAction(ref: ResourceRef, uid: string, action: MenuAction) {
    if (action === "copy-name") {
      void navigator.clipboard?.writeText(ref.name);
      return;
    }
    if (action === "copy-get") {
      void navigator.clipboard?.writeText(`kubectl get ${kubectlName(ref.kind)} ${ref.name}${ref.namespace ? ` -n ${ref.namespace}` : ""} -o yaml`);
      return;
    }
    if (action === "use-namespace") {
      void client.setNamespace(ref.name);
      onView("Pod");
      return;
    }
    if (action === "open-url") {
      const host = (resources.find((item) => item.uid === uid)?.columns.hosts ?? "").split(",")[0]?.trim();
      if (host) window.open(`https://${host}`, "_blank", "noopener");
      return;
    }
    if (action === "namespace-page") {
      void client.setNamespace(ref.name);
      onView("Team");
      return;
    }
    if (action === "search-logs") {
      setLogSearchStart({ namespace: ref.namespace ?? "default", workload: ref });
      onView("LogSearch");
      return;
    }
    if (action === "pods-on-node") {
      setNodeFilter(ref.name);
      setFilter("");
      onView("Pod");
      return;
    }
    setMinimized(false);
    select(ref);
    if (action === "exec") {
      setDockTab("details");
      setTerminalToken((value) => value + 1);
    } else {
      setPending({ id: Date.now(), action });
    }
  }

  function onSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const start = sidebarWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      setSidebarWidth(Math.min(480, Math.max(200, Math.round(start + (ev.clientX - startX)))));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      setSidebarWidth((width) => {
        localStorage.setItem("podgaze.sidebar", String(width));
        return width;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  function onResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const start = dockHeight;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const next = start + (startY - ev.clientY);
      const max = Math.round(window.innerHeight * 0.72);
      setDockHeight(Math.min(Math.max(160, next), max));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      setDockHeight((height) => {
        try {
          localStorage.setItem("podgaze.dock", String(height));
        } catch {
          // Height just resets next launch.
        }
        return height;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  return (
    <div className="shell" style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <WatchingLogo size={40} />
          <p className="mark">Podgaze</p>
        </div>
        <button type="button" className="home-btn" aria-label="Home" title="Home: all clusters" onClick={onHome}>
          <Icon name="home" />
          <span>Home</span>
        </button>
        <div className="cluster-now" title={currentCluster?.server ?? undefined} ref={safetyRef}>
          <span className={`cluster-dot ${session.state}`} aria-hidden="true" />
          <div>
            <p className="eyebrow">Cluster</p>
            <p className="brand-sub">{session.clusterId ?? "Cluster"}</p>
          </div>
          {session.clusterId ? (
            <button
              type="button"
              className={namespaceGuard.readOnly ? "safety-btn readonly" : session.guard.protected ? "safety-btn protected" : "safety-btn"}
              aria-label="Safety settings"
              aria-expanded={safetyOpen}
              title={namespaceGuard.readOnly ? "Read-only" : session.guard.protected ? "Protected" : "No safety switches on"}
              onClick={() => setSafetyOpen((value) => !value)}
            >
              <Icon name="shield" />
            </button>
          ) : null}
          {safetyOpen && session.clusterId ? (
            <div className="safety-pop" role="group" aria-label="Safety">
              <p className="eyebrow">Safety for {session.clusterId}</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={session.guard.protected}
                  onChange={(event) => void client.setGuard(session.clusterId!, { ...session.guard, protected: event.target.checked })}
                />
                <span><strong>Protected</strong><small>Deletes, drains, and restarts ask you to type the name first.</small></span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={session.guard.readOnly}
                  onChange={(event) => void client.setGuard(session.clusterId!, { ...session.guard, readOnly: event.target.checked })}
                />
                <span><strong>Read-only</strong><small>Podgaze refuses every change: no edits, deletes, scaling, or exec.</small></span>
              </label>
              {session.namespace ? (
                <label className="ns-guard" title="An exception for this namespace only">
                  <span>Namespace <code>{session.namespace}</code></span>
                  <select
                    aria-label={`Safety for namespace ${session.namespace}`}
                    value={session.guard.namespaces?.[session.namespace] ?? ""}
                    onChange={(event) => {
                      const namespaces = { ...(session.guard.namespaces ?? {}) };
                      if (event.target.value) namespaces[session.namespace!] = event.target.value as "readOnly" | "writable";
                      else delete namespaces[session.namespace!];
                      void client.setGuard(session.clusterId!, { ...session.guard, namespaces });
                    }}
                  >
                    <option value="">Same as cluster</option>
                    <option value="writable">Always writable</option>
                    <option value="readOnly">Read-only</option>
                  </select>
                </label>
              ) : <p className="muted">Pick a namespace to set an exception for it.</p>}
            </div>
          ) : null}
        </div>
        <div className="sidebar-switch">
          <SearchSelect
            label="Namespace"
            value={session.namespace ?? ""}
            placeholder="Search namespaces"
            options={[{ value: "", label: "All namespaces" }, ...session.namespaces.map((namespace) => ({ value: namespace, label: namespace }))]}
            onPick={(namespace) => void client.setNamespace(namespace === "" ? null : namespace)}
          />
        </div>
        <nav className="rail" aria-label="Resources">
          <button type="button" className="nav-item" aria-current={view === "Overview" ? "page" : undefined} onClick={() => onView("Overview")}>
            <span>Overview</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Team" ? "page" : undefined} onClick={() => onView("Team")}>
            <span>Namespace page</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Map" ? "page" : undefined} onClick={() => onView("Map")}>
            <span>Map</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Projects" ? "page" : undefined} onClick={() => onView("Projects")}>
            <span>Projects</span>
          </button>
          {hasArgo ? (
            <button type="button" className="nav-item" aria-current={view === "Argo" ? "page" : undefined} onClick={() => onView("Argo")}>
              <span>Argo CD</span>
            </button>
          ) : null}
          <button type="button" className="nav-item" aria-current={view === "Helm" ? "page" : undefined} onClick={() => onView("Helm")}>
            <span>Helm releases</span>
          </button>
          <p className="nav-label">Tools</p>
          <button type="button" className="nav-item" aria-current={view === "Compare" ? "page" : undefined} onClick={() => onView("Compare")}>
            <span>Compare</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Images" ? "page" : undefined} onClick={() => onView("Images")}>
            <span>Image versions</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "LogSearch" ? "page" : undefined} onClick={() => onView("LogSearch")}>
            <span>Log search</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Cost" ? "page" : undefined} onClick={() => onView("Cost")}>
            <span>Cost</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Certificates" ? "page" : undefined} onClick={() => onView("Certificates")}>
            <span>Certificates</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Forwards" ? "page" : undefined} onClick={() => onView("Forwards")}>
            <span>Port forwards</span>
          </button>
          <button type="button" className="nav-item" aria-current={view === "Activity" ? "page" : undefined} onClick={() => onView("Activity")}>
            <span>Activity</span>
          </button>
          {pins.pins.length > 0 ? (
            <div className="nav-group pinned">
              <p className="nav-label">Pinned</p>
              <div className="nav-items">
                {pins.pins.map((ref) => (
                  <button
                    key={`${ref.kind}/${ref.namespace ?? ""}/${ref.name}`}
                    type="button"
                    className="nav-item pin-item"
                    title={`${ref.kind}${ref.namespace ? ` · ${ref.namespace}` : ""}`}
                    aria-current={selected && selected.kind === ref.kind && selected.name === ref.name && (selected.namespace ?? null) === (ref.namespace ?? null) ? "page" : undefined}
                    onClick={() => onNavigate(ref)}
                  >
                    <span>{ref.name}</span>
                    <em>{catalogEntry(ref.kind)?.label ?? ref.kind}</em>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {catalogGroups.map((group) => {
            const expanded = openGroups.includes(group);
            return (
              <div key={group} className="nav-group">
                <button
                  type="button"
                  className="nav-toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpenGroups((current) => expanded ? current.filter((item) => item !== group) : [...current, group])}
                >
                  <span>{group}</span>
                  <i aria-hidden="true">{expanded ? "▾" : "▸"}</i>
                </button>
                {expanded ? (
                  <div className="nav-items">
                    {catalog.filter((item) => item.group === group).map((item) => {
                      const total = countFor(item.kind);
                      return (
                        <button key={item.kind} type="button" className="nav-item" aria-current={view === item.kind ? "page" : undefined} onClick={() => onView(item.kind)}>
                          <span>{item.label}</span>
                          {total === null ? null : <em>{total}</em>}
                        </button>
                      );
                    })}
                    {group === "Access" ? (
                      <button type="button" className="nav-item" aria-current={view === "Access" ? "page" : undefined} onClick={() => onView("Access")}>
                        <span>Access check</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {(session.customKinds?.length ?? 0) > 0 ? (
            <div className="nav-group">
              <button
                type="button"
                className="nav-toggle"
                aria-expanded={openGroups.includes("Custom")}
                onClick={() => setOpenGroups((current) => current.includes("Custom") ? current.filter((item) => item !== "Custom") : [...current, "Custom"])}
              >
                <span>Custom resources</span>
                <i aria-hidden="true">{openGroups.includes("Custom") ? "▾" : "▸"}</i>
              </button>
              {openGroups.includes("Custom") ? (
                <div className="nav-items">
                  {customAll.length > 8 ? (
                    <input
                      className="nav-search"
                      role="searchbox"
                      aria-label="Find custom resource"
                      placeholder={`Search ${customAll.length} kinds`}
                      value={customQuery}
                      onChange={(event) => setCustomQuery(event.target.value)}
                    />
                  ) : null}
                  {customCounted && emptyKinds > 0 ? (
                    <label className="check nav-check" title={session.namespace ? `Counted in ${session.namespace}` : "Counted in all namespaces"}>
                      <input
                        type="checkbox"
                        checked={hideEmpty}
                        onChange={(event) => {
                          setHideEmpty(event.target.checked);
                          try {
                            localStorage.setItem("podgaze.hideEmptyCustom", event.target.checked ? "1" : "0");
                          } catch {
                            // Only for this session then.
                          }
                        }}
                      />
                      Hide {emptyKinds} empty{session.namespace ? ` in ${session.namespace}` : ""}
                    </label>
                  ) : null}
                  {customGroups.length === 0 ? <p className="nav-empty">No kind matches.</p> : null}
                  {customGroups.map(([apiGroup, entries]) => (
                    <div key={apiGroup} className="nav-subgroup">
                      <p className="nav-label" title={apiGroup}>{apiGroup}</p>
                      {entries.map((item) => (
                        <button
                          key={item.kind}
                          type="button"
                          className={counts[item.kind] === 0 ? "nav-item empty" : "nav-item"}
                          title={item.kind}
                          aria-current={view === item.kind ? "page" : undefined}
                          onClick={() => onView(item.kind)}
                        >
                          <span>{item.label}</span>
                          {countFor(item.kind) === null ? null : <em>{countFor(item.kind)}</em>}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="ghost sidebar-settings" aria-label="Settings" title="Settings (Ctrl+,)" onClick={onSettings}>
            <Icon name="gear" />
            <span>Settings</span>
          </button>
          <ThemeToggle />
        </div>
        <div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" onPointerDown={onSidebarResize} />
      </aside>
      <div className="workspace">
        {(session.open?.length ?? 0) > 0 ? (
          <div className="cluster-tabs" role="tablist" aria-label="Open clusters">
            {session.open!.map((tab) => (
              <div key={tab.id} className={tab.id === session.clusterId ? "cluster-tab active" : "cluster-tab"}>
                <button type="button" role="tab" aria-selected={tab.id === session.clusterId} title={`${tab.id} · ${tab.state}`} onClick={() => onSwitchCluster?.(tab.id)}>
                  <span className={`cluster-dot ${tab.state}`} aria-hidden="true" />
                  {tab.id}
                </button>
                <button type="button" className="tab-close" aria-label={`Close ${tab.id}`} title="Disconnect this cluster" onClick={() => onCloseCluster?.(tab.id)}>
                  <Icon name="x" />
                </button>
              </div>
            ))}
            <button type="button" className="tab-add" aria-label="Open another cluster" title="Open another cluster from Home" onClick={onHome}>
              <Icon name="plus" />
            </button>
          </div>
        ) : null}
        {namespaceGuard.readOnly ? (
          <p className="guard-band readonly" role="status">
            Read-only · {session.clusterId}{session.guard.namespaces?.[session.namespace ?? ""] === "readOnly" ? ` / ${session.namespace}` : ""}. Podgaze will not change {session.guard.namespaces?.[session.namespace ?? ""] === "readOnly" ? "this namespace" : "this cluster"}.
          </p>
        ) : session.guard.readOnly && session.namespace ? (
          <p className="guard-band" role="status">{session.namespace} is writable on read-only {session.clusterId}. Changes here are allowed.</p>
        ) : session.guard.protected ? (
          <p className="guard-band" role="status">Protected · {session.clusterId}. Destructive actions ask you to type the name.</p>
        ) : null}
        {session.state === "reconnecting" ? <p className="banner">Reconnecting. The list is the last update.</p> : null}
        {session.problem && session.state !== "disconnected" ? <p className="banner problem">{session.problem}</p> : null}
        <div className="work">
          <section className="stage">
            <header className="stage-head">
              <div className="history-nav">
                <button type="button" aria-label="Go back" title="Back (Alt+←)" disabled={!canBack} onClick={onBack}>‹</button>
                <button type="button" aria-label="Go forward" title="Forward (Alt+→)" disabled={!canForward} onClick={onForward}>›</button>
              </div>
              <div>
                <h1>{title}</h1>
                <p>
                  {count}
                  {view === "Pod" && nodeFilter ? (
                    <button type="button" className="chip filter-chip" aria-label={`Clear node filter ${nodeFilter}`} onClick={() => setNodeFilter(null)}>
                      node {nodeFilter} ×
                    </button>
                  ) : null}
                </p>
              </div>
              {view === "Overview" || view === "Access" || view === "Map" || view === "Projects" || view === "Compare" || view === "Forwards" ? <span className="head-spacer" /> : <label className="filter">
                <span className="sr">Filter by name</span>
                <input
                  ref={filterRef}
                  role="searchbox"
                  aria-label="Filter by name"
                  title="A name, labels like app=api or tier!=cache, or env in (dev,test)"
                  placeholder={isToolView(view) ? "Filter" : "Name or label: app=api"}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>}
              {view === "Event" ? (
                <label className="check">
                  <input type="checkbox" checked={warningsOnly} onChange={(event) => setWarningsOnly(event.target.checked)} />
                  Warnings only
                </label>
              ) : !isToolView(view) ? (
                <label className="check" title="Hide everything that is healthy">
                  <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
                  Problems only
                </label>
              ) : null}
              {!isToolView(view) ? (
                <button
                  type="button"
                  className="ghost search icon-btn"
                  title="Create objects from YAML"
                  disabled={session.state !== "connected" && session.state !== "reconnecting"}
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" />
                  Create
                </button>
              ) : null}
              <button type="button" className="ghost search icon-btn" title="A terminal on this computer, with kubectl pointed at this cluster" onClick={openShell}>
                <Icon name="terminal" />
                Local shell
              </button>
              <button type="button" className="ghost search icon-btn" title="Find any object by name, or jump to a kind, namespace, or cluster" onClick={onOpenPalette}>
                <Icon name="command" />
                Search
                <kbd>Ctrl K</kbd>
              </button>
            </header>
            {connecting ? (
              <GazeLoader label={`Connecting to ${session.clusterId ?? "the cluster"}`} detail="Reading pods, nodes, and deployments" />
            ) : null}
            {blocked ? <p className="empty-state" role="status">{blocked}</p> : null}
            {checkedRows.length > 0 && !isToolView(view) ? (
              <BulkBar
                client={client}
                kind={view}
                rows={checkedRows.map((row) => ({ uid: row.uid, name: row.name, namespace: "namespace" in row ? row.namespace || null : null }))}
                guard={session.guard}
                onClear={() => setChecked(new Set())}
              />
            ) : null}
            {!connecting && view === "Map" ? (
              <MapView client={client} scope={{ namespaces: session.namespace ? [session.namespace] : null }} refreshKey={usageKey} onNavigate={onNavigate} />
            ) : null}
            {!connecting && view === "Projects" ? (
              <ProjectsView client={client} clusterId={session.clusterId} namespaces={session.namespaces} refreshKey={session.clusterId ?? ""} onNavigate={onNavigate} />
            ) : null}
            {!connecting && view === "Argo" ? (
              <ArgoView client={client} guard={session.guard} filter={filter} refreshKey={session.clusterId ?? ""} onNavigate={onNavigate} clusters={clusters} onOpenCluster={onSwitchCluster} />
            ) : null}
            {!connecting && view === "Compare" ? <CompareView client={client} clusterIds={openClusterIds} activeCluster={session.clusterId} /> : null}
            {!connecting && view === "Images" ? (
              <ImagesView client={client} clusterIds={openClusterIds} activeCluster={session.clusterId} filter={filter} onOpen={(clusterId, ref) => onOpenIn?.(clusterId, ref)} />
            ) : null}
            {!connecting && view === "Certificates" ? <CertificatesView client={client} filter={filter} refreshKey={usageKey} onNavigate={onNavigate} clusters={clusters} /> : null}
            {!connecting && view === "Team" ? (
              <TeamView
                client={client}
                clusterId={session.clusterId}
                namespaces={session.namespaces}
                currentNamespace={session.namespace}
                pods={pods}
                nodes={nodes}
                deployments={deployments}
                refreshKey={`${session.clusterId ?? ""}`}
                onNavigate={onNavigate}
                onOpenView={(next) => onView(next)}
              />
            ) : null}
            {!connecting && view === "LogSearch" ? (
              <LogSearchView client={client} clusterId={session.clusterId} namespaces={session.namespaces} currentNamespace={session.namespace} start={logSearchStart} />
            ) : null}
            {!connecting && view === "Cost" ? <CostView client={client} clusterId={session.clusterId} pods={pods} nodes={nodes} namespace={session.namespace} filter={filter} onNavigate={onNavigate} /> : null}
            {!connecting && view === "Forwards" ? <ForwardsView client={client} clusterId={session.clusterId} /> : null}
            {!connecting && view === "Helm" ? <HelmView client={client} namespace={session.namespace} guard={session.guard} filter={filter} refreshKey={usageKey} /> : null}
            {!connecting && view === "Activity" ? <ActivityView client={client} clusterId={session.clusterId} filter={filter} /> : null}
            {!connecting && view === "Access" ? <AccessView client={client} namespace={session.namespace} /> : null}
            {!connecting && view === "Overview" ? (
              <Overview
                client={client}
                refreshKey={`${session.clusterId ?? ""}:${session.namespace ?? ""}`}
                pods={pods}
                nodes={nodes}
                deployments={deployments}
                onNavigate={onNavigate}
                onOpenView={(next, options) => {
                  setProblemsOnly(Boolean(options?.problems));
                  setWarningsOnly(Boolean(options?.warnings));
                  setFilter("");
                  onView(next);
                }}
              />
            ) : null}
            {!blocked && !connecting && view === "Pod" ? (
              <ResourceTable
                rows={visiblePods}
                tableId="Pod"
                columns={podColumns(session.namespace === null)}
                selectedUid={selectedPod?.uid ?? null}
                checked={checked}
                onCheck={onCheck}
                onSelect={(pod) => select({ kind: "Pod", namespace: pod.namespace, name: pod.name })}
                onContextMenu={(pod, x, y) => openMenu({ kind: "Pod", namespace: pod.namespace, name: pod.name }, pod.uid, x, y)}
                markedUid={menu?.uid ?? null}
              />
            ) : null}
            {!blocked && !connecting && view === "Node" ? (
              <ResourceTable
                rows={visibleNodes}
                tableId="Node"
                columns={nodeColumns}
                selectedUid={selectedNode?.uid ?? null}
                checked={checked}
                onCheck={onCheck}
                onSelect={(node) => select({ kind: "Node", namespace: null, name: node.name })}
                onContextMenu={(node, x, y) => openMenu({ kind: "Node", namespace: null, name: node.name }, node.uid, x, y)}
                markedUid={menu?.uid ?? null}
              />
            ) : null}
            {!blocked && !connecting && view === "Deployment" ? (
              <ResourceTable
                rows={visibleDeployments}
                tableId="Deployment"
                columns={deploymentColumns(session.namespace === null)}
                selectedUid={selectedDeployment?.uid ?? null}
                checked={checked}
                onCheck={onCheck}
                onSelect={(deployment) => select({ kind: "Deployment", namespace: deployment.namespace, name: deployment.name })}
                onContextMenu={(deployment, x, y) => openMenu({ kind: "Deployment", namespace: deployment.namespace, name: deployment.name }, deployment.uid, x, y)}
                markedUid={menu?.uid ?? null}
              />
            ) : null}
            {!blocked && !connecting && !isToolView(view) && (view === "Pod" || view === "Node" || view === "Deployment" ? session.state === "connected" : resourcesLoaded)
              && (view === "Pod" ? visiblePods : view === "Node" ? visibleNodes : view === "Deployment" ? visibleDeployments : visibleResources).length === 0 ? (
              <div className="empty-state" role="status">
                <p>
                  {filter.trim() || problemsOnly || nodeFilter
                    ? `Nothing matches the filter${session.namespace && entry?.namespaced ? ` in ${session.namespace}` : ""}.`
                    : `No ${entry?.label ?? view} ${session.namespace && entry?.namespaced ? `in ${session.namespace}` : "in this cluster"}.`}
                </p>
                {session.namespace && entry?.namespaced ? (
                  <button type="button" className="ghost" onClick={() => void client.setNamespace(null)}>Show all namespaces</button>
                ) : null}
              </div>
            ) : null}
            {!blocked && !connecting && !isToolView(view) && view !== "Pod" && view !== "Node" && view !== "Deployment" ? (
              <ResourceTable
                rows={visibleResources}
                tableId={view}
                columns={resourceColumns(view, session.namespace === null)}
                selectedUid={selectedResource?.uid ?? null}
                checked={checked}
                onCheck={onCheck}
                onSelect={(row) => select({ kind: row.kind, namespace: row.namespace || null, name: row.name })}
                onContextMenu={(row, x, y) => openMenu({ kind: row.kind, namespace: row.namespace || null, name: row.name }, row.uid, x, y)}
                markedUid={menu?.uid ?? null}
              />
            ) : null}
          </section>
          {dockVisible ? (
            <div className={minimized ? "dock dock-min" : "dock"} style={minimized ? undefined : { height: dockHeight }}>
              {minimized ? null : <div className="dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize details" onPointerDown={onResizePointerDown} />}
              <div className="dock-tabs">
                {open && selected ? (
                  <div className="dock-object">
                    <span className="eyebrow">{selected.kind}{selected.namespace ? ` · ${selected.namespace}` : ""}</span>
                    <h2 title={selected.name}>{selected.name}</h2>
                    <button
                      type="button"
                      className="dock-icon"
                      aria-label="Copy name"
                      title={nameCopied ? "Copied" : "Copy name"}
                      onClick={() => {
                        void navigator.clipboard?.writeText(selected.name).then(() => {
                          setNameCopied(true);
                          window.setTimeout(() => setNameCopied(false), 1200);
                        }, () => undefined);
                      }}
                    >
                      <Icon name={nameCopied ? "check" : "copy"} />
                    </button>
                    <button
                      type="button"
                      className={pins.pinned(selected) ? "dock-icon pin on" : "dock-icon pin"}
                      aria-label={pins.pinned(selected) ? "Unpin" : "Pin to sidebar"}
                      aria-pressed={pins.pinned(selected)}
                      title={pins.pinned(selected) ? "Unpin from the sidebar" : "Pin to the sidebar"}
                      onClick={() => pins.toggle(selected)}
                    >
                      <Icon name="star" />
                    </button>
                  </div>
                ) : null}
                {shellOn ? (
                  <div className="dock-switch" role="tablist" aria-label="Panel">
                    {open ? <button type="button" role="tab" aria-selected={activeTab === "details"} onClick={() => { setMinimized(false); setDockTab("details"); }}>Details</button> : null}
                    <button type="button" role="tab" aria-selected={activeTab === "shell"} onClick={() => { setMinimized(false); setDockTab("shell"); }}><Icon name="terminal" /> Local shell</button>
                    <button type="button" className="dock-icon" aria-label="Close local shell" title="Close local shell" onClick={closeShell}><Icon name="x" /></button>
                  </div>
                ) : null}
                <div className="dock-actions">
                  <button type="button" aria-label={minimized ? "Restore panel" : "Minimize panel"} onClick={() => setMinimized((value) => !value)}>
                    {minimized ? (
                      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8l4-4 4 4" /></svg>
                    ) : (
                      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" /></svg>
                    )}
                    {minimized ? "Restore" : "Minimize"}
                  </button>
                  <button
                    type="button"
                    className="dock-tool-close"
                    aria-label="Close panel"
                    title="Close (Esc)"
                    onClick={() => {
                      if (activeTab === "shell" && shellOn) closeShell();
                      else {
                        onSelect(null);
                        if (shellOn) setDockTab("shell");
                      }
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              </div>
              <div className={activeTab === "shell" ? "dock-pane" : "dock-pane hidden"} hidden={minimized || activeTab !== "shell"}>
                {shellOn ? <TerminalPane client={client} request={shellRequest} /> : null}
              </div>
              <div className={activeTab === "details" ? "dock-pane" : "dock-pane hidden"} hidden={minimized || activeTab !== "details"}>
                {open ? (
                  <Inspector
                    client={client}
                    pod={selectedPod}
                    node={selectedNode}
                    deployment={selectedDeployment}
                    resource={selectedResource}
                    nodes={nodes}
                    podsOnNode={selectedNode ? pods.filter((pod) => pod.nodeName === selectedNode.name).length : 0}
                    epoch={epoch}
                    pending={pending}
                    terminalToken={terminalToken}
                    usageKey={usageKey}
                    guard={effectiveGuard(session.guard, selected?.namespace)}
                    onNavigate={onNavigate}
                    onPodsOnNode={(name) => {
                      setNodeFilter(name);
                      setFilter("");
                      onView("Pod");
                    }}
                    onPendingHandled={() => setPending(null)}
                  />
                ) : (
                  <p className="muted dock-empty">
                    Select a resource to inspect it. Keys: <kbd>l</kbd> logs · <kbd>s</kbd> terminal · <kbd>y</kbd> YAML · <kbd>d</kbd> describe · <kbd>e</kbd> events · <kbd>/</kbd> filter · <kbd>Esc</kbd> close · <kbd>Alt ←/→</kbd> back and forward.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {creating ? (
        <CreateDialog
          client={client}
          namespace={session.namespace}
          guard={session.guard}
          suggestedKind={isToolView(view) ? undefined : catalogEntry(view)?.kind}
          onClose={() => setCreating(false)}
          onCreated={(refs) => {
            setCreating(false);
            const first = refs.find((ref) => catalogEntry(ref.kind));
            if (first) onNavigate(first);
          }}
        />
      ) : null}
      {menu ? (
        <RowMenu
          x={menu.x}
          y={menu.y}
          title={`${catalogEntry(menu.ref.kind)?.label.replace(/s$/, "") ?? menu.ref.kind} · ${menu.ref.name}`}
          sections={menu.sections}
          onClose={() => setMenu(null)}
          onPick={(action) => {
            runMenuAction(menu.ref, menu.uid, action);
            setMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

// Custom kinds grouped by API group for the sidebar, filtered by kind or group.
export function groupCustom(entries: CatalogEntry[], query: string): [string, CatalogEntry[]][] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    if (needle && !`${entry.label} ${entry.apiGroup ?? ""} ${entry.plural}`.toLowerCase().includes(needle)) continue;
    const key = entry.apiGroup ?? "custom";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()];
}

type BulkRow = { uid: string; name: string; namespace: string | null };

// Acts on every checked row: one request after another, so a failure in the middle is reported, not hidden.
function BulkBar({ client, kind, rows, guard, onClear }: { client: ClusterClient; kind: ResourceKind; rows: BulkRow[]; guard: ContextGuard; onClear: () => void }) {
  const commands = catalogEntry(kind)?.commands ?? [];
  const [armed, setArmed] = useState<"delete" | "rollout-restart" | null>(null);
  const [typed, setTyped] = useState("");
  const [progress, setProgress] = useState<{ done: number; failed: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const canRestart = kind === "Deployment" && commands.includes("rollout-restart");
  const canDelete = commands.includes("delete");
  const blocked = rows.some((row) => effectiveGuard(guard, row.namespace).readOnly);
  const confirmWord = String(rows.length);

  async function run(action: "delete" | "rollout-restart") {
    const failed: string[] = [];
    setProgress({ done: 0, failed });
    for (const [index, row] of rows.entries()) {
      try {
        await client.runCommand({ name: action, kind, resourceName: row.name, namespace: row.namespace });
      } catch (reason) {
        failed.push(`${row.name}: ${reason instanceof Error ? reason.message : "failed"}`);
      }
      setProgress({ done: index + 1, failed: failed.slice() });
    }
    setArmed(null);
    setTyped("");
    if (failed.length === 0) onClear();
  }

  const running = progress !== null && progress.done < rows.length;
  return (
    <div className="bulk-bar" role="region" aria-label="Selected rows">
      <strong>{rows.length} selected</strong>
      {canRestart ? (
        <button type="button" className="icon-btn" disabled={blocked || running} onClick={() => setArmed("rollout-restart")}><Icon name="refresh" /> Restart</button>
      ) : null}
      {canDelete ? (
        <button type="button" className="danger icon-btn" disabled={blocked || running} onClick={() => setArmed("delete")}><Icon name="x" /> Delete</button>
      ) : null}
      <button
        type="button"
        className="icon-btn"
        onClick={() => void navigator.clipboard?.writeText(rows.map((row) => row.name).join("\n")).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }, () => undefined)}
      >
        <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy names"}
      </button>
      <button type="button" className="ghost" onClick={onClear}>Clear</button>
      {blocked ? <span className="muted">Read-only: changes are off for some of these.</span> : null}
      {armed ? (
        <form
          className="bulk-confirm"
          onSubmit={(event) => {
            event.preventDefault();
            if (!guard.protected || typed === confirmWord) void run(armed);
          }}
        >
          <span>{armed === "delete" ? "Delete" : "Restart"} {rows.length} {catalogEntry(kind)?.label.toLowerCase() ?? kind}?</span>
          {guard.protected ? (
            <input aria-label="Confirm count" placeholder={`type ${confirmWord}`} value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
          ) : null}
          <button type="submit" className="danger" disabled={running || (guard.protected && typed !== confirmWord)}>
            {running ? `${progress!.done}/${rows.length}` : armed === "delete" ? `Delete ${rows.length} now` : `Restart ${rows.length} now`}
          </button>
          <button type="button" onClick={() => setArmed(null)}>Cancel</button>
        </form>
      ) : null}
      {progress && !running && progress.failed.length > 0 ? (
        <p className="problem bulk-failures">{progress.failed.length} failed: {progress.failed.join("; ")}</p>
      ) : null}
    </div>
  );
}
