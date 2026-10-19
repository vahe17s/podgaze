import { registerCustomKinds, type PriceQuote, type PriceRequest, type ArgoApp, type CloudAccount, type CloudAddRequest, type CloudCluster, type CloudProvider, type ClusterAlert, type DeploymentRow, type NodeRow, type OpenCluster, type PodRow, type ResourceRow, type RowBatch, type RowChange, type Session } from "@podgaze/contracts";
import type { ClusterApp } from "./session.js";
import fs from "node:fs";
import path from "node:path";
import { backupKubeconfig } from "./kubeconfig-edit.js";

export type ClusterHub = ClusterApp & {
  closeCluster(clusterId: string): Promise<void>;
  findWorkloadsIn(clusterId: string, needle: string): ReturnType<ClusterApp["findWorkloads"]>;
  getYamlIn(clusterId: string, ref: Parameters<ClusterApp["getYaml"]>[0]): Promise<string>;
  listImagesIn(clusterId: string): ReturnType<ClusterApp["listImages"]>;
  onAlert(listener: (alert: ClusterAlert) => void): () => void;
  cloudAccounts(provider: CloudProvider): Promise<CloudAccount[]>;
  cloudDefaultRegion(accountId: string): Promise<string>;
  cloudClusters(provider: CloudProvider, accountId: string, region?: string): Promise<CloudCluster[]>;
  cloudAddCluster(request: CloudAddRequest): Promise<{ context: string; message: string }>;
  lookupPrices(requests: PriceRequest[]): Promise<PriceQuote[]>;
  // Sends the current session and the on-screen cluster's rows again, for a window that just (re)loaded.
  resend(): void;
  isOpen(clusterId: string): boolean;
  stopNodeShellIn(clusterId: string, namespace: string, pod: string): Promise<void>;
  // The session of the cluster on screen, for things like terminals that need its kubeconfig.
  activeSession(): Session | null;
};

type Rows = {
  pods: Map<string, PodRow>;
  nodes: Map<string, NodeRow>;
  deployments: Map<string, DeploymentRow>;
  resources: Map<string, ResourceRow>;
};

type Tab = {
  id: string;
  app: ClusterApp;
  session: Session | null;
  rows: Rows;
  used: number;
  stop: () => void;
  // Alerts only fire after the first full list, so connecting to a broken cluster is not a flood.
  primed: boolean;
  argoHealth: Map<string, string> | null;
};

// Pod states worth interrupting someone for.
const FAILING = new Set(["CrashLoopBackOff", "Error", "OOMKilled", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "Evicted"]);
const ALERT_QUIET_MS = 10 * 60_000;

export function podAlert(previous: PodRow | undefined, next: PodRow): { reason: string; message: string } | null {
  if (FAILING.has(next.status) && previous?.status !== next.status) {
    return { reason: next.status, message: next.lastExit ? `Last exit: ${next.lastExit}` : `${next.restarts} restarts` };
  }
  if (previous && next.restarts > previous.restarts && next.lastExit.startsWith("OOMKilled")) {
    return { reason: "OOMKilled", message: `Out of memory, restart ${next.restarts}` };
  }
  return null;
}

function emptyRows(): Rows {
  return { pods: new Map(), nodes: new Map(), deployments: new Map(), resources: new Map() };
}

function apply<T extends { uid: string }>(rows: Map<string, T>, change: RowChange<T> | undefined) {
  if (!change) return;
  if (change.reset) rows.clear();
  else for (const uid of change.delete) rows.delete(uid);
  for (const row of change.upsert) rows.set(row.uid, row);
}

function replay(rows: Rows): RowBatch {
  return {
    pods: { reset: true, upsert: [...rows.pods.values()], delete: [] },
    nodes: { reset: true, upsert: [...rows.nodes.values()], delete: [] },
    deployments: { reset: true, upsert: [...rows.deployments.values()], delete: [] },
    resources: { reset: true, upsert: [...rows.resources.values()], delete: [] },
  };
}

// Several clusters stay connected; one is on screen. Switching swaps which one the window hears from and replays
// its rows from memory, so going back to a tab is instant instead of a reconnect.
export function createClusterHub(options: {
  makeApp: () => ClusterApp;
  maxOpen?: number;
  // Cloud CLI access and the kubeconfig file it writes to; desktop only.
  cloud?: {
    accounts(provider: CloudProvider): Promise<CloudAccount[]>;
    defaultRegion(accountId: string): Promise<string>;
    clusters(provider: CloudProvider, accountId: string, region?: string): Promise<CloudCluster[]>;
    add(request: CloudAddRequest, kubeconfig: string): Promise<{ context: string; message: string }>;
  };
  kubeconfigFile?: () => string;
  // Public VM list prices; desktop only, since it reaches the internet.
  prices?: (requests: PriceRequest[]) => Promise<PriceQuote[]>;
  argoPollMs?: number;
  // Runs before a cluster's tab closes, by the user or when the oldest tab is dropped at the limit: the desktop
  // stops that cluster's forwards, logs, shells, and node-shell pods here, while its connection still works.
  beforeTabClose?: (clusterId: string) => Promise<void> | void;
  now?: () => number;
}): ClusterHub {
  const now = options.now ?? Date.now;
  const alertListeners = new Set<(alert: ClusterAlert) => void>();
  const lastAlert = new Map<string, number>();
  let alertSeq = 0;

  function alert(clusterId: string, kind: string, namespace: string | null, name: string, reason: string, message: string) {
    const key = `${clusterId}/${kind}/${namespace ?? ""}/${name}/${reason}`;
    const at = now();
    if ((lastAlert.get(key) ?? 0) > at - ALERT_QUIET_MS) return;
    lastAlert.set(key, at);
    const event: ClusterAlert = { id: `alert-${++alertSeq}`, clusterId, kind, namespace, name, reason, message, time: new Date(at).toISOString() };
    for (const listener of alertListeners) listener(event);
  }
  const maxOpen = options.maxOpen ?? 6;
  const idle = options.makeApp();
  const tabs = new Map<string, Tab>();
  let active: string | null = null;
  let idleSession: Session | null = null;
  let kubeconfigPath: string | null = null;
  let clock = 0;
  const sessionListeners = new Set<(session: Session) => void>();
  const rowListeners = new Set<(batch: RowBatch) => void>();

  function openList(): OpenCluster[] {
    return [...tabs.values()].map((tab) => ({ id: tab.id, state: tab.session?.state ?? "connecting" }));
  }

  function current(): Session | null {
    const tab = active ? tabs.get(active) : undefined;
    return tab?.session ?? idleSession;
  }

  function publish() {
    const session = current();
    if (!session) return;
    const snapshot = { ...session, open: openList() };
    for (const listener of sessionListeners) listener(snapshot);
  }

  function sendRows(batch: RowBatch) {
    for (const listener of rowListeners) listener(batch);
  }

  idle.onSession((session) => {
    idleSession = session;
    if (!active) publish();
  });

  function activeApp(): ClusterApp {
    const tab = active ? tabs.get(active) : undefined;
    if (!tab) throw new Error("Not connected.");
    tab.used = ++clock;
    return tab.app;
  }

  function show(id: string | null) {
    active = id;
    const tab = id ? tabs.get(id) : undefined;
    if (tab?.session?.customKinds) registerCustomKinds(tab.session.customKinds);
    publish();
    if (tab) sendRows(replay(tab.rows));
  }

  async function close(id: string) {
    const tab = tabs.get(id);
    if (!tab) return;
    try {
      await options.beforeTabClose?.(id);
    } catch {
      // Cleanup is best effort; the tab still closes.
    }
    tabs.delete(id);
    tab.stop();
    await tab.app.disconnect();
    if (active === id) show(null);
    else publish();
  }

  function open(id: string): Tab {
    const app = options.makeApp();
    if (kubeconfigPath) app.setKubeconfigPath(kubeconfigPath);
    const tab: Tab = { id, app, session: null, rows: emptyRows(), used: ++clock, stop: () => undefined, primed: false, argoHealth: null };
    const stopSession = app.onSession((session) => {
      if (tabs.get(id) !== tab) return;
      tab.session = session;
      // A failed connect leaves nothing to keep open; its problem still reaches the screen once.
      if (session.state === "disconnected" && session.clusterId === id && session.problem) {
        tabs.delete(id);
        tab.stop();
        if (active === id) {
          active = null;
          for (const listener of sessionListeners) listener({ ...session, open: openList() });
        } else publish();
        return;
      }
      if (session.customKinds && active === id) registerCustomKinds(session.customKinds);
      if (active === id) publish();
      else for (const listener of sessionListeners) listener({ ...(current() ?? session), open: openList() });
    });
    const stopRows = app.subscribeRows((batch) => {
      if (tabs.get(id) !== tab) return;
      if (batch.pods && !batch.pods.reset && tab.primed) {
        for (const row of batch.pods.upsert) {
          const found = podAlert(tab.rows.pods.get(row.uid), row);
          if (found) alert(id, "Pod", row.namespace, row.name, found.reason, found.message);
        }
      }
      if (batch.pods?.reset) tab.primed = true;
      apply(tab.rows.pods, batch.pods);
      apply(tab.rows.nodes, batch.nodes);
      apply(tab.rows.deployments, batch.deployments);
      apply(tab.rows.resources, batch.resources);
      if (active === id) sendRows(batch);
    });
    tab.stop = () => {
      stopSession();
      stopRows();
    };
    return tab;
  }

  // Argo CD apps that turn Degraded or Missing, checked once a minute in every open cluster that runs Argo CD.
  async function pollArgo() {
    for (const tab of tabs.values()) {
      if (tab.session?.state !== "connected" || !tab.session.customKinds?.some((item) => item.kind === "applications.argoproj.io")) continue;
      let apps: ArgoApp[];
      try {
        apps = await tab.app.listArgoApps();
      } catch {
        continue;
      }
      const before = tab.argoHealth;
      tab.argoHealth = new Map(apps.map((app) => [`${app.namespace}/${app.name}`, app.health]));
      if (!before) continue;
      for (const app of apps) {
        const was = before.get(`${app.namespace}/${app.name}`);
        if ((app.health === "Degraded" || app.health === "Missing") && was !== undefined && was !== app.health) {
          alert(tab.id, "applications.argoproj.io", app.namespace, app.name, `Argo CD: ${app.health}`, app.healthMessage || app.operation?.message || "");
        }
      }
    }
  }
  const pollMs = options.argoPollMs ?? 60_000;
  if (pollMs > 0) {
    const timer = setInterval(() => void pollArgo(), pollMs);
    (timer as { unref?: () => void }).unref?.();
  }

  function requireCloud() {
    if (!options.cloud) throw new Error("Adding cloud clusters is only available in the desktop app.");
    return options.cloud;
  }

  function tabFor(clusterId: string): ClusterApp {
    const tab = tabs.get(clusterId);
    if (!tab) throw new Error(`Open ${clusterId} in a tab first.`);
    return tab.app;
  }

  return {
    activeSession: () => current(),
    resend: () => show(active),
    isOpen: (clusterId) => tabs.has(clusterId),
    async stopNodeShellIn(clusterId, namespace, pod) {
      await tabs.get(clusterId)?.app.stopNodeShell(namespace, pod);
    },
    findWorkloadsIn: (clusterId, needle) => tabFor(clusterId).findWorkloads(needle),
    getYamlIn: (clusterId, ref) => tabFor(clusterId).getYaml(ref),
    listImagesIn: (clusterId) => tabFor(clusterId).listImages(),
    onAlert(listener) {
      alertListeners.add(listener);
      return () => alertListeners.delete(listener);
    },
    async lookupPrices(requests) {
      if (!options.prices) throw new Error("Looking up prices is only available in the desktop app.");
      return options.prices(requests);
    },
    async cloudAccounts(provider) {
      return requireCloud().accounts(provider);
    },
    async cloudDefaultRegion(accountId) {
      return requireCloud().defaultRegion(accountId);
    },
    async cloudClusters(provider, accountId, region) {
      return requireCloud().clusters(provider, accountId, region);
    },
    async cloudAddCluster(request) {
      if (!options.kubeconfigFile) throw new Error("Adding cloud clusters is only available in the desktop app.");
      const file = (kubeconfigPath ?? options.kubeconfigFile()).split(path.delimiter)[0]!;
      // The cloud CLIs merge into the file in place (az with --overwrite-existing); keep a private copy first.
      if (fs.existsSync(file)) backupKubeconfig(file);
      return requireCloud().add(request, file);
    },
    listCertificates: () => activeApp().listCertificates(),
    getTimeline: (ref) => activeApp().getTimeline(ref),
    searchLogs: (request) => activeApp().searchLogs(request),
    listVolumes: () => activeApp().listVolumes(),
    listImages: () => activeApp().listImages(),
    findWorkloads: (needle) => activeApp().findWorkloads(needle),
    current: () => current() ?? idle.current(),
    listClusters: () => idle.listClusters(),
    setKubeconfigPath(filePath) {
      kubeconfigPath = filePath;
      idle.setKubeconfigPath(filePath);
      for (const tab of tabs.values()) tab.app.setKubeconfigPath(filePath);
    },
    async connect(clusterId) {
      const existing = tabs.get(clusterId);
      if (existing) {
        existing.used = ++clock;
        show(clusterId);
        return;
      }
      if (tabs.size >= maxOpen) {
        const oldest = [...tabs.values()].filter((tab) => tab.id !== active).sort((left, right) => left.used - right.used)[0];
        if (oldest) await close(oldest.id);
      }
      const tab = open(clusterId);
      tabs.set(clusterId, tab);
      active = clusterId;
      await tab.app.connect(clusterId);
    },
    async disconnect() {
      if (active) await close(active);
    },
    closeCluster: (clusterId) => close(clusterId),
    onSession(listener) {
      sessionListeners.add(listener);
      const session = current();
      if (session) listener({ ...session, open: openList() });
      return () => sessionListeners.delete(listener);
    },
    subscribeRows(listener) {
      rowListeners.add(listener);
      return () => rowListeners.delete(listener);
    },
    async getGuards() {
      return idle.getGuards();
    },
    async describeContext(clusterId) {
      return idle.describeContext(clusterId);
    },
    async updateContext(clusterId, edit) {
      if (tabs.has(clusterId)) throw new Error("Close this cluster's tab before editing its context.");
      return idle.updateContext(clusterId, edit);
    },
    async removeContext(clusterId) {
      if (tabs.has(clusterId)) throw new Error("Close this cluster's tab before removing it.");
      return idle.removeContext(clusterId);
    },
    async setGuard(clusterId, guard) {
      await idle.setGuard(clusterId, guard);
      // Each open session holds its own copy of the guard; refresh the one that matches.
      await tabs.get(clusterId)?.app.setGuard(clusterId, guard);
    },
    listAudit: () => idle.listAudit(),
    record(entry) {
      (active ? tabs.get(active)?.app : undefined)?.record(entry) ?? idle.record(entry);
    },
    setNamespace: (namespace) => activeApp().setNamespace(namespace),
    getYaml: (ref) => activeApp().getYaml(ref),
    runCommand: (request) => activeApp().runCommand(request),
    setFocus: async (kind) => {
      if (active) await activeApp().setFocus(kind);
    },
    listCounts: async () => (active ? activeApp().listCounts() : {}),
    getLogs: (request) => activeApp().getLogs(request),
    applyYaml: (request) => activeApp().applyYaml(request),
    listRelated: (ref) => activeApp().listRelated(ref),
    listEvents: (ref) => activeApp().listEvents(ref),
    listWarnings: () => activeApp().listWarnings(),
    checkAccess: (ref) => activeApp().checkAccess(ref),
    startDebug: (request) => activeApp().startDebug(request),
    assertWritable: (namespace) => activeApp().assertWritable(namespace),
    listExecTargets: (ref) => activeApp().listExecTargets(ref),
    readSecret: (namespace, name) => activeApp().readSecret(namespace, name),
    writeSecret: (request) => activeApp().writeSecret(request),
    readUsage: () => activeApp().readUsage(),
    createYaml: (request) => activeApp().createYaml(request),
    listHelmReleases: () => activeApp().listHelmReleases(),
    getHelmRelease: (namespace, name) => activeApp().getHelmRelease(namespace, name),
    helmAction: (request) => activeApp().helmAction(request),
    helmRepos: () => activeApp().helmRepos(),
    helmAddRepo: (repo) => activeApp().helmAddRepo(repo),
    helmSearch: (term) => activeApp().helmSearch(term),
    helmChartValues: (chart, version) => activeApp().helmChartValues(chart, version),
    helmInstall: (request) => activeApp().helmInstall(request),
    getMap: (scope) => activeApp().getMap(scope),
    listArgoApps: () => activeApp().listArgoApps(),
    argoAction: (request) => activeApp().argoAction(request),
    hubSearch: (term) => activeApp().hubSearch(term),
    startNodeShell: (node) => activeApp().startNodeShell(node),
    stopNodeShell: (namespace, pod) => activeApp().stopNodeShell(namespace, pod),
    whoCan: (request) => activeApp().whoCan(request),
    myRules: (namespace) => activeApp().myRules(namespace),
  };
}
