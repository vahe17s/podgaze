import { parseAllDocuments, parse as parseYaml } from "yaml";
import type { CertInfo, ResourceRow, WorkloadImages, SecretWrite, ArgoAction, ArgoApp, HelmChart, HelmInstallRequest, HelmRepo, HubChart, MapScope, NodeShell, ResourceMap } from "@podgaze/contracts";
import { catalog, catalogEntry, entryForApiKind, kubectlName, mutatingCommands, registerCustomKinds, type AccessRule, type AuditEntry, type CommandResult as HelmResult, type CreateRequest, type CreateResult, type HelmActionRequest, type HelmRelease, type HelmReleaseDetail, type WhoCanRequest, type WhoCanSubject, type ContextDetails, type ContextEdit, type ContextRemoved, type ContextSaved, type Timeline, type LogSearchRequest, type LogSearchResult, type VolumeReport, type ClusterWarning, type AccessMap, type ApplyRequest, type ApplyResult, type ClusterSummary, type ClusterUsage, type CommandRequest, type CommandResult, type ContextGuard, type DebugRequest, type ExecTarget, type LogBundle, type LogRequest, type ObjectEvent, type RelatedRef, type ResourceKind, type ResourceRef, type RowBatch, type SecretReveal, type Session } from "@podgaze/contracts";
import { deploymentToRow, nodeToRow, objectToRow, podToRow, type DeploymentLike, type NodeLike, type PodLike } from "./project.js";
import { defaultKubeconfigPath, loadKubeConfig, readKubeconfigSummaries } from "./summaries.js";
import { describeContext, removeContext, updateContext } from "./kubeconfig-edit.js";
import { shellCommand } from "./commands.js";
import { helmCommandLine, installCommandLine } from "./helm.js";
import {
  BACKOFF_MS,
  RowBatcher,
  messageOf,
  realClock,
  statusOf,
  type Clock,
  type ClusterBackend,
  type WatchHandle,
} from "./batch.js";

export type ClusterApp = {
  listClusters(): Promise<ClusterSummary[]>;
  connect(clusterId: string): Promise<void>;
  disconnect(): Promise<void>;
  setNamespace(namespace: string | null): Promise<void>;
  subscribeRows(onBatch: (batch: RowBatch) => void): () => void;
  getYaml(ref: ResourceRef): Promise<string>;
  runCommand(request: CommandRequest): Promise<CommandResult>;
  setFocus(kind: ResourceKind): Promise<void>;
  listCounts(): Promise<Record<string, number>>;
  getLogs(request: LogRequest): Promise<LogBundle>;
  applyYaml(request: ApplyRequest): Promise<ApplyResult>;
  listRelated(ref: ResourceRef): Promise<RelatedRef[]>;
  listEvents(ref: ResourceRef): Promise<ObjectEvent[]>;
  listWarnings(): Promise<ClusterWarning[]>;
  checkAccess(ref: ResourceRef): Promise<AccessMap>;
  startDebug(request: DebugRequest): Promise<{ container: string }>;
  getGuards(): Promise<Record<string, ContextGuard>>;
  describeContext(clusterId: string): Promise<ContextDetails>;
  updateContext(clusterId: string, edit: ContextEdit): Promise<ContextSaved>;
  removeContext(clusterId: string): Promise<ContextRemoved>;
  setGuard(clusterId: string, guard: ContextGuard): Promise<void>;
  assertWritable(namespace?: string | null): void;
  createYaml(request: CreateRequest): Promise<CreateResult>;
  listHelmReleases(): Promise<HelmRelease[]>;
  getHelmRelease(namespace: string, name: string): Promise<HelmReleaseDetail>;
  helmAction(request: HelmActionRequest): Promise<HelmResult>;
  helmRepos(): Promise<HelmRepo[]>;
  helmAddRepo(repo: HelmRepo): Promise<void>;
  helmSearch(term: string): Promise<HelmChart[]>;
  helmChartValues(chart: string, version?: string): Promise<string>;
  helmInstall(request: HelmInstallRequest): Promise<HelmResult>;
  getMap(scope: MapScope): Promise<ResourceMap>;
  listArgoApps(): Promise<ArgoApp[]>;
  argoAction(request: ArgoAction): Promise<HelmResult>;
  hubSearch(term: string): Promise<HubChart[]>;
  startNodeShell(node: string): Promise<NodeShell>;
  stopNodeShell(namespace: string, pod: string): Promise<void>;
  listCertificates(): Promise<CertInfo[]>;
  getTimeline(ref: ResourceRef): Promise<Timeline>;
  searchLogs(request: LogSearchRequest): Promise<LogSearchResult>;
  listVolumes(): Promise<VolumeReport>;
  listImages(): Promise<WorkloadImages[]>;
  findWorkloads(needle: string): Promise<ResourceRow[]>;
  // The session as it is now, for the hub's per-cluster bookkeeping.
  current(): Session;
  listAudit(): Promise<AuditEntry[]>;
  // For actions that run outside the session, like exec terminals, so they still show in the history.
  record(entry: Omit<AuditEntry, "id" | "time" | "cluster">): void;
  whoCan(request: WhoCanRequest): Promise<WhoCanSubject[]>;
  myRules(namespace: string | null): Promise<AccessRule[]>;
  listExecTargets(ref: ResourceRef): Promise<ExecTarget[]>;
  readSecret(namespace: string, name: string): Promise<SecretReveal>;
  writeSecret(request: SecretWrite): Promise<SecretReveal>;
  readUsage(): Promise<ClusterUsage>;
  onSession(listener: (session: Session) => void): () => void;
  setKubeconfigPath(filePath: string): void;
};

const openGuard = (): ContextGuard => ({ protected: false, readOnly: false });

const emptySession = (): Session => ({
  state: "disconnected",
  clusterId: null,
  namespace: null,
  kubeconfigPath: null,
  problem: null,
  namespaces: [],
  guard: openGuard(),
  forbidden: {},
});

function forbidden(server: string, message: string): string {
  return `This account cannot list resources on ${server}. ${message}`;
}

// Contexts that look like production start protected until the user says otherwise.
export function defaultGuard(contextName: string): ContextGuard {
  return { protected: /(^|[^a-z])(prod|prd|production|live)([^a-z]|$)/i.test(contextName), readOnly: false };
}

export type GuardStore = {
  load(): Record<string, ContextGuard>;
  save(guards: Record<string, ContextGuard>): void;
};

export type AuditStore = {
  append(entry: AuditEntry): void;
  list(): AuditEntry[];
};

export function memoryAudit(limit = 1000): AuditStore {
  let entries: AuditEntry[] = [];
  return {
    append(entry) {
      entries = [entry, ...entries].slice(0, limit);
    },
    list: () => entries.slice(),
  };
}

let auditCounter = 0;

function memoryGuards(): GuardStore {
  let saved: Record<string, ContextGuard> = {};
  return {
    load: () => saved,
    save(next) {
      saved = next;
    },
  };
}

export function createClusterApp(options: {
  resolvePath?: () => string;
  backendFor: (filePath: string, contextName: string) => ClusterBackend;
  clock?: Clock;
  batchMs?: number;
  guards?: GuardStore;
  audit?: AuditStore;
}): ClusterApp {
  const guards = options.guards ?? memoryGuards();
  const audit = options.audit ?? memoryAudit();
  const clock = options.clock ?? realClock;
  // Coalescing watch events for 150ms keeps a churning cluster from re-rendering the window 20 times a second.
  const batchMs = options.batchMs ?? 150;
  let pathOverride: string | null = null;
  let session = emptySession();
  let backend: ClusterBackend | null = null;
  let life = 0;
  let podLife = 0;
  let podWatch: WatchHandle | null = null;
  let nodeWatch: WatchHandle | null = null;
  let deploymentWatch: WatchHandle | null = null;
  let podTimer: (() => void) | null = null;
  let nodeTimer: (() => void) | null = null;
  let deploymentTimer: (() => void) | null = null;
  let podAttempt = 0;
  let nodeAttempt = 0;
  let deploymentAttempt = 0;
  let deploymentLife = 0;
  let focusKind: ResourceKind = "Pod";
  let focusLife = 0;
  let focusWatch: WatchHandle | null = null;
  let focusTimer: (() => void) | null = null;
  let focusAttempt = 0;
  const sessionListeners = new Set<(session: Session) => void>();
  const rowListeners = new Set<(batch: RowBatch) => void>();
  const batcher = new RowBatcher((batch) => {
    for (const listener of rowListeners) listener(batch);
  }, clock, batchMs);

  function path(): string {
    return pathOverride ?? options.resolvePath?.() ?? defaultKubeconfigPath();
  }

  function guardFor(clusterId: string): ContextGuard {
    return { ...defaultGuard(clusterId), ...(guards.load()[clusterId] ?? {}) };
  }

  // A namespace exception wins over the cluster setting; cluster-scoped objects follow the cluster.
  function readOnlyFor(namespace: string | null | undefined): boolean {
    const exception = namespace ? session.guard.namespaces?.[namespace] : undefined;
    if (exception === "readOnly") return true;
    if (exception === "writable") return false;
    return session.guard.readOnly;
  }

  function writable(namespace?: string | null) {
    if (readOnlyFor(namespace)) {
      const where = namespace && session.guard.namespaces?.[namespace] === "readOnly" ? `Namespace ${namespace} on ${session.clusterId}` : session.clusterId ?? "This context";
      throw new Error(`${where} is read-only. Change it in the sidebar's Safety settings to allow changes.`);
    }
  }

  async function audited<T>(
    info: { action: string; target: string; namespace: string | null; kubectl: string; dryRun?: boolean },
    run: () => Promise<T>,
    changed: (result: T) => boolean = () => true,
  ): Promise<T> {
    const base = { id: `${Date.now()}-${++auditCounter}`, time: new Date().toISOString(), cluster: session.clusterId ?? "", ...info };
    try {
      const out = await run();
      if (changed(out)) audit.append({ ...base, ok: true });
      return out;
    } catch (error) {
      audit.append({ ...base, ok: false, error: messageOf(error) });
      throw error;
    }
  }

  // The namespace each document of a manifest lands in, or null for cluster-scoped kinds.
  function manifestTargets(yaml: string, fallback: string | null): { kind: string; name: string; namespace: string | null }[] {
    return parseAllDocuments(yaml).flatMap((doc) => {
      const value = doc.toJSON() as { kind?: string; apiVersion?: string; metadata?: { name?: string; namespace?: string } } | null;
      if (!value?.kind) return [];
      const entry = entryForApiKind(value.kind, value.apiVersion);
      const namespace = entry && !entry.namespaced ? null : value.metadata?.namespace ?? fallback ?? "default";
      return [{ kind: value.kind, name: value.metadata?.name ?? "", namespace }];
    });
  }

  function markForbidden(kind: ResourceKind, server: string, message: string) {
    session.forbidden = { ...session.forbidden, [kind]: forbidden(server, message) };
    emitSession();
  }

  function clearForbidden(kind: ResourceKind) {
    if (!session.forbidden[kind]) return;
    const next = { ...session.forbidden };
    delete next[kind];
    session.forbidden = next;
    emitSession();
  }

  function emitSession() {
    const snapshot = { ...session, namespaces: session.namespaces.slice(), guard: { ...session.guard }, forbidden: { ...session.forbidden } };
    for (const listener of sessionListeners) listener(snapshot);
  }

  function clearPodTimer() {
    podTimer?.();
    podTimer = null;
  }

  function clearNodeTimer() {
    nodeTimer?.();
    nodeTimer = null;
  }

  function clearDeploymentTimer() {
    deploymentTimer?.();
    deploymentTimer = null;
  }

  function stopPodWatch() {
    podWatch?.stop();
    podWatch = null;
  }

  function stopNodeWatch() {
    nodeWatch?.stop();
    nodeWatch = null;
  }

  function stopDeploymentWatch() {
    deploymentWatch?.stop();
    deploymentWatch = null;
  }

  function clearFocusTimer() {
    focusTimer?.();
    focusTimer = null;
  }

  function stopFocusWatch() {
    focusWatch?.stop();
    focusWatch = null;
  }

  function builtinKind(kind: ResourceKind) {
    return kind === "Pod" || kind === "Node" || kind === "Deployment";
  }

  function applyWatch(kind: "pods" | "nodes" | "deployments", phase: string, object: unknown) {
    if (phase === "BOOKMARK" || phase === "ERROR") return;
    if (kind === "pods") {
      if (phase === "DELETED") {
        const uid = (object as PodLike).metadata?.uid;
        if (uid) batcher.deletePod(uid);
        return;
      }
      const row = podToRow(object as PodLike);
      if (row) batcher.upsertPod(row);
      return;
    }
    if (kind === "deployments") {
      if (phase === "DELETED") {
        const uid = (object as DeploymentLike).metadata?.uid;
        if (uid) batcher.deleteDeployment(uid);
        return;
      }
      const row = deploymentToRow(object as DeploymentLike);
      if (row) batcher.upsertDeployment(row);
      return;
    }
    if (phase === "DELETED") {
      const uid = (object as NodeLike).metadata?.uid;
      if (uid) batcher.deleteNode(uid);
      return;
    }
    const row = nodeToRow(object as NodeLike);
    if (row) batcher.upsertNode(row);
  }

  async function syncPods(myLife: number, myPod: number, server: string) {
    if (!backend) return;
    const namespace = session.namespace;
    try {
      const listed = await backend.listPods(namespace);
      if (myLife !== life || myPod !== podLife) return;
      podAttempt = 0;
      clearForbidden("Pod");
      batcher.resetPods(listed.rows);
      stopPodWatch();
      podWatch = await backend.watchPods(namespace, listed.resourceVersion, {
        onEvent: (phase, object) => {
          if (myLife !== life || myPod !== podLife) return;
          if (phase === "ERROR") {
            const record = object as { code?: number; message?: string };
            void recover("pods", { statusCode: record.code ?? 410, message: record.message ?? "Watch expired" }, server);
            return;
          }
          applyWatch("pods", phase, object);
        },
        onError: (error) => {
          if (myLife !== life || myPod !== podLife) return;
          void recover("pods", error, server);
        },
      });
      if (myLife !== life || myPod !== podLife) {
        stopPodWatch();
      }
    } catch (error) {
      if (myLife !== life || myPod !== podLife) return;
      if (statusOf(error) === 403) {
        batcher.resetPods([]);
        markForbidden("Pod", server, messageOf(error));
        return;
      }
      throw error;
    }
  }

  async function syncNodes(myLife: number, server: string) {
    if (!backend) return;
    try {
      const listed = await backend.listNodes();
      if (myLife !== life) return;
      nodeAttempt = 0;
      clearForbidden("Node");
      batcher.resetNodes(listed.rows);
      stopNodeWatch();
      nodeWatch = await backend.watchNodes(listed.resourceVersion, {
        onEvent: (phase, object) => {
          if (myLife !== life) return;
          if (phase === "ERROR") {
            const record = object as { code?: number; message?: string };
            void recover("nodes", { statusCode: record.code ?? 410, message: record.message ?? "Watch expired" }, server);
            return;
          }
          applyWatch("nodes", phase, object);
        },
        onError: (error) => {
          if (myLife !== life) return;
          void recover("nodes", error, server);
        },
      });
      if (myLife !== life) stopNodeWatch();
    } catch (error) {
      if (myLife !== life) return;
      if (statusOf(error) === 403) {
        batcher.resetNodes([]);
        markForbidden("Node", server, messageOf(error));
        return;
      }
      throw error;
    }
  }

  async function syncDeployments(myLife: number, myDeployment: number, server: string) {
    if (!backend) return;
    const namespace = session.namespace;
    try {
      const listed = await backend.listDeployments(namespace);
      if (myLife !== life || myDeployment !== deploymentLife) return;
      deploymentAttempt = 0;
      clearForbidden("Deployment");
      batcher.resetDeployments(listed.rows);
      stopDeploymentWatch();
      deploymentWatch = await backend.watchDeployments(namespace, listed.resourceVersion, {
        onEvent: (phase, object) => {
          if (myLife !== life || myDeployment !== deploymentLife) return;
          if (phase === "ERROR") {
            const record = object as { code?: number; message?: string };
            void recover("deployments", { statusCode: record.code ?? 410, message: record.message ?? "Watch expired" }, server);
            return;
          }
          applyWatch("deployments", phase, object);
        },
        onError: (error) => {
          if (myLife !== life || myDeployment !== deploymentLife) return;
          void recover("deployments", error, server);
        },
      });
      if (myLife !== life || myDeployment !== deploymentLife) stopDeploymentWatch();
    } catch (error) {
      if (myLife !== life || myDeployment !== deploymentLife) return;
      if (statusOf(error) === 403) {
        batcher.resetDeployments([]);
        markForbidden("Deployment", server, messageOf(error));
        return;
      }
      throw error;
    }
  }

  async function syncFocus(myLife: number, myFocus: number, server: string) {
    if (!backend) return;
    const entry = catalogEntry(focusKind);
    if (!entry || builtinKind(entry.kind)) return;
    const namespace = entry.namespaced ? session.namespace : null;
    try {
      const listed = await backend.listResources(entry.kind, namespace);
      if (myLife !== life || myFocus !== focusLife) return;
      focusAttempt = 0;
      clearForbidden(entry.kind);
      batcher.resetResources(listed.rows);
      stopFocusWatch();
      focusWatch = await backend.watchResources(entry.kind, namespace, listed.resourceVersion, {
        onEvent: (phase, object) => {
          if (myLife !== life || myFocus !== focusLife) return;
          if (phase === "ERROR") {
            const record = object as { code?: number; message?: string };
            void recoverFocus({ statusCode: record.code ?? 410, message: record.message ?? "Watch expired" }, server, myFocus);
            return;
          }
          if (phase === "BOOKMARK") return;
          if (phase === "DELETED") {
            const uid = (object as { metadata?: { uid?: string } }).metadata?.uid;
            if (uid) batcher.deleteResource(uid);
            return;
          }
          const row = objectToRow(entry.kind, object);
          if (row) batcher.upsertResource(row);
        },
        onError: (error) => {
          if (myLife !== life || myFocus !== focusLife) return;
          void recoverFocus(error, server, myFocus);
        },
      });
      if (myLife !== life || myFocus !== focusLife) stopFocusWatch();
    } catch (error) {
      if (myLife !== life || myFocus !== focusLife) return;
      if (statusOf(error) === 403) {
        batcher.resetResources([]);
        markForbidden(entry.kind, server, messageOf(error));
        return;
      }
      throw error;
    }
  }

  async function recoverFocus(error: { statusCode: number | null; message: string }, server: string, myFocus: number) {
    const myLife = life;
    if (myFocus !== focusLife) return;
    session.state = "reconnecting";
    if (error.statusCode === 403) {
      const entry = catalogEntry(focusKind);
      if (entry) session.forbidden = { ...session.forbidden, [entry.kind]: forbidden(server, error.message) };
    }
    emitSession();
    const immediate = error.statusCode === 410;
    const attempt = focusAttempt++;
    const wait = immediate && attempt === 0 ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    await new Promise<void>((resolve) => {
      clearFocusTimer();
      focusTimer = clock.setTimeout(resolve, wait);
    });
    if (myLife !== life || myFocus !== focusLife) return;
    try {
      await syncFocus(myLife, myFocus, server);
      if (myLife !== life || myFocus !== focusLife) return;
      if (session.state === "reconnecting") {
        session.state = "connected";
        if (error.statusCode !== 403) session.problem = null;
        emitSession();
      }
    } catch (next) {
      if (myLife !== life || myFocus !== focusLife) return;
      if (statusOf(next) === 403) return;
      void recoverFocus({ statusCode: statusOf(next), message: messageOf(next) }, server, myFocus);
    }
  }

  async function recover(kind: "pods" | "nodes" | "deployments", error: { statusCode: number | null; message: string }, server: string) {
    const myLife = life;
    session.state = "reconnecting";
    if (error.statusCode === 403) {
      const kindName: ResourceKind = kind === "pods" ? "Pod" : kind === "nodes" ? "Node" : "Deployment";
      session.forbidden = { ...session.forbidden, [kindName]: forbidden(server, error.message) };
    }
    emitSession();
    const immediate = error.statusCode === 410;
    const attempt = kind === "pods" ? podAttempt++ : kind === "nodes" ? nodeAttempt++ : deploymentAttempt++;
    const wait = immediate && attempt === 0 ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    await new Promise<void>((resolve) => {
      const cancel = clock.setTimeout(resolve, wait);
      if (kind === "pods") {
        clearPodTimer();
        podTimer = cancel;
      } else if (kind === "nodes") {
        clearNodeTimer();
        nodeTimer = cancel;
      } else {
        clearDeploymentTimer();
        deploymentTimer = cancel;
      }
    });
    if (myLife !== life) return;
    try {
      if (kind === "pods") await syncPods(myLife, podLife, server);
      else if (kind === "nodes") await syncNodes(myLife, server);
      else await syncDeployments(myLife, deploymentLife, server);
      if (myLife !== life) return;
      if (session.state === "reconnecting") {
        session.state = "connected";
        if (error.statusCode !== 403) session.problem = null;
        emitSession();
      }
    } catch (next) {
      if (myLife !== life) return;
      if (statusOf(next) === 403) return;
      void recover(kind, { statusCode: statusOf(next), message: messageOf(next) }, server);
    }
  }

  return {
    setKubeconfigPath(filePath: string) {
      pathOverride = filePath;
    },

    async listClusters() {
      const filePath = path();
      const result = readKubeconfigSummaries(filePath);
      session = {
        ...session,
        kubeconfigPath: filePath,
        problem: session.state === "disconnected" ? result.error : session.problem,
      };
      if (session.state === "disconnected" && result.error) session.problem = result.error;
      emitSession();
      return result.summaries;
    },

    async connect(clusterId: string) {
      const myLife = ++life;
      const myPod = ++podLife;
      const myDeployment = ++deploymentLife;
      focusLife += 1;
      clearPodTimer();
      clearNodeTimer();
      clearDeploymentTimer();
      clearFocusTimer();
      stopPodWatch();
      stopNodeWatch();
      stopDeploymentWatch();
      stopFocusWatch();
      batcher.cancel();
      const filePath = path();
      const loaded = readKubeconfigSummaries(filePath);
      const summary = loaded.summaries.find((item) => item.id === clusterId);
      session = {
        state: "connecting",
        clusterId,
        namespace: summary?.namespace ?? null,
        kubeconfigPath: filePath,
        problem: null,
        namespaces: summary?.namespace ? [summary.namespace] : [],
        guard: guardFor(clusterId),
        forbidden: {},
      };
      emitSession();
      if (!summary || !summary.usable) {
        session = { ...session, state: "disconnected", problem: summary?.problem ?? "Unknown context." };
        emitSession();
        return;
      }
      try {
        backend = options.backendFor(filePath, clusterId);
        const namespacePromise = backend
          .listNamespaces()
          .then((names) => {
            if (myLife !== life) return;
            session.namespaces = names;
            emitSession();
          })
          .catch((error: unknown) => {
            if (myLife !== life) return;
            // Forbidden only means this account may not list namespaces; anything else (server down, login
            // failed) will fail every other request too, so stop here instead of trying them all.
            if (statusOf(error) !== 403) throw error;
            session.namespaces = summary.namespace ? [summary.namespace] : [];
            emitSession();
          });
        // One request first: a kubeconfig that signs in through an exec plugin (kubelogin, aws, gcloud) runs the
        // plugin for every request that starts before the first token is cached. Waiting for this one makes the
        // rest reuse its token instead of starting the plugin six times at once.
        await namespacePromise;
        if (myLife !== life) return;
        backend.listCustomKinds?.().then((entries) => {
          if (myLife !== life) return;
          registerCustomKinds(entries);
          session.customKinds = entries;
          emitSession();
        }).catch(() => {
          // No permission to read CRDs: the custom section just stays empty.
        });
        await Promise.all([
          syncPods(myLife, myPod, summary.server),
          syncNodes(myLife, summary.server),
          syncDeployments(myLife, myDeployment, summary.server),
          namespacePromise,
        ]);
        if (myLife !== life) return;
        session.state = "connected";
        emitSession();
      } catch (error) {
        if (myLife !== life) return;
        stopPodWatch();
        stopNodeWatch();
        stopDeploymentWatch();
        stopFocusWatch();
        backend = null;
        session = {
          ...session,
          state: "disconnected",
          problem: `${messageOf(error)} (${summary.server})`,
        };
        emitSession();
      }
    },

    async disconnect() {
      life += 1;
      podLife += 1;
      deploymentLife += 1;
      focusLife += 1;
      clearPodTimer();
      clearNodeTimer();
      clearDeploymentTimer();
      clearFocusTimer();
      stopPodWatch();
      stopNodeWatch();
      stopDeploymentWatch();
      stopFocusWatch();
      batcher.cancel();
      backend = null;
      session = {
        ...emptySession(),
        kubeconfigPath: session.kubeconfigPath,
      };
      emitSession();
    },

    async setNamespace(namespace: string | null) {
      if (session.state === "disconnected" || !backend) return;
      const myLife = life;
      const myPod = ++podLife;
      const myDeployment = ++deploymentLife;
      const entry = catalogEntry(focusKind);
      const restartFocus = Boolean(entry && entry.namespaced && !builtinKind(entry.kind));
      const myFocus = restartFocus ? ++focusLife : focusLife;
      clearPodTimer();
      clearDeploymentTimer();
      stopPodWatch();
      stopDeploymentWatch();
      if (restartFocus) {
        clearFocusTimer();
        stopFocusWatch();
      }
      session.namespace = namespace;
      emitSession();
      const summary = readKubeconfigSummaries(path()).summaries.find((item) => item.id === session.clusterId);
      const server = summary?.server ?? "";
      try {
        await Promise.all([
          syncPods(myLife, myPod, server),
          syncDeployments(myLife, myDeployment, server),
          restartFocus ? syncFocus(myLife, myFocus, server) : Promise.resolve(),
        ]);
      } catch (error) {
        if (myLife !== life) return;
        session.state = "reconnecting";
        session.problem = messageOf(error);
        emitSession();
        void recover("pods", { statusCode: statusOf(error), message: messageOf(error) }, server);
      }
    },

    subscribeRows(onBatch) {
      rowListeners.add(onBatch);
      return () => rowListeners.delete(onBatch);
    },

    async getYaml(ref: ResourceRef) {
      if (!backend) throw new Error("Not connected.");
      return backend.getYaml(ref);
    },

    async runCommand(request: CommandRequest) {
      if (!backend) throw new Error("Not connected.");
      if (!mutatingCommands.has(request.name)) return backend.runCommand(request);
      const entry = catalogEntry(request.kind);
      const namespace = entry?.namespaced === false ? null : request.namespace;
      writable(namespace);
      const target = backend;
      return audited(
        { action: request.name, target: `${kubectlName(request.kind)}/${request.resourceName}`, namespace, kubectl: shellCommand(request) },
        () => target.runCommand(request),
      );
    },

    async getLogs(request: LogRequest) {
      if (!backend) throw new Error("Not connected.");
      return backend.getLogs(request);
    },

    async applyYaml(request: ApplyRequest) {
      if (!backend) throw new Error("Not connected.");
      if (request.dryRun) return backend.applyYaml(request);
      const manifest = (parseYaml(request.base) ?? {}) as { kind?: string; apiVersion?: string; metadata?: { name?: string; namespace?: string } };
      const entry = manifest.kind ? entryForApiKind(manifest.kind, manifest.apiVersion) : undefined;
      const namespace = entry?.namespaced === false ? null : manifest.metadata?.namespace ?? null;
      writable(namespace);
      const target = backend;
      return audited(
        { action: "edit", target: `${(manifest.kind ?? "object").toLowerCase()}/${manifest.metadata?.name ?? ""}`, namespace, kubectl: `kubectl apply -f -  # ${manifest.kind}/${manifest.metadata?.name}` },
        () => target.applyYaml(request),
        // A conflict or "no changes" is an answer, not a change, so it stays out of the history.
        (result) => result.applied,
      );
    },

    async createYaml(request: CreateRequest) {
      if (!backend?.createYaml) throw new Error("Not connected.");
      const fallback = request.namespace ?? session.namespace;
      const targets = manifestTargets(request.yaml, fallback);
      if (!request.dryRun) for (const target of targets) writable(target.namespace);
      const create = backend.createYaml.bind(backend);
      const call = () => create({ ...request, namespace: fallback });
      if (request.dryRun) return call();
      return audited(
        {
          action: "create",
          target: targets.map((target) => `${target.kind.toLowerCase()}/${target.name}`).join(", ") || "manifest",
          namespace: targets[0]?.namespace ?? null,
          kubectl: "kubectl create -f -",
        },
        call,
      );
    },

    async listHelmReleases() {
      if (!backend?.listHelmReleases) throw new Error("Not connected.");
      return backend.listHelmReleases(session.namespace);
    },

    async getHelmRelease(namespace: string, name: string) {
      if (!backend?.getHelmRelease) throw new Error("Not connected.");
      return backend.getHelmRelease(namespace, name);
    },

    async helmAction(request: HelmActionRequest) {
      if (!backend?.helmAction) throw new Error("Not connected.");
      writable(request.namespace);
      const run = backend.helmAction.bind(backend);
      return audited(
        { action: `helm ${request.action}`, target: `release/${request.name}`, namespace: request.namespace, kubectl: helmCommandLine(request.action, request.name, request.namespace, request.revision) },
        () => run(request),
      );
    },

    async helmRepos() {
      if (!backend?.helmRepos) throw new Error("Not connected.");
      return backend.helmRepos();
    },

    async helmAddRepo(repo: HelmRepo) {
      if (!backend?.helmAddRepo) throw new Error("Not connected.");
      return backend.helmAddRepo(repo);
    },

    async helmSearch(term: string) {
      if (!backend?.helmSearch) throw new Error("Not connected.");
      return backend.helmSearch(term);
    },

    async helmChartValues(chart: string, version?: string) {
      if (!backend?.helmChartValues) throw new Error("Not connected.");
      return backend.helmChartValues(chart, version);
    },

    async helmInstall(request: HelmInstallRequest) {
      if (!backend?.helmInstall) throw new Error("Not connected.");
      const install = backend.helmInstall.bind(backend);
      if (request.dryRun) return install(request);
      writable(request.namespace);
      return audited(
        { action: request.upgrade ? "helm upgrade" : "helm install", target: `release/${request.release}`, namespace: request.namespace, kubectl: installCommandLine(request) },
        () => install(request),
      );
    },

    async getMap(scope: MapScope) {
      if (!backend?.getMap) throw new Error("Not connected.");
      return backend.getMap(scope);
    },

    async listArgoApps() {
      if (!backend?.listArgoApps) throw new Error("Not connected.");
      return backend.listArgoApps();
    },

    async argoAction(request: ArgoAction) {
      if (!backend?.argoAction) throw new Error("Not connected.");
      const act = backend.argoAction.bind(backend);
      if (request.action === "refresh" || request.action === "hard-refresh") return act(request);
      writable(request.namespace);
      const kubectl = request.action === "sync" ? `argocd app sync ${request.name}${request.prune ? " --prune" : ""}`
        : request.action === "rollback" ? `argocd app rollback ${request.name}  # to ${request.revision}`
        : `argocd app set ${request.name} --sync-policy none`;
      return audited({ action: `argo ${request.action}`, target: `application/${request.name}`, namespace: request.namespace, kubectl }, () => act(request));
    },

    async hubSearch(term: string) {
      if (!backend?.hubSearch) throw new Error("Not connected.");
      return backend.hubSearch(term);
    },

    async startNodeShell(node: string) {
      if (!backend?.startNodeShell) throw new Error("Not connected.");
      // A root shell on a node can change anything, so it counts as a cluster-wide write.
      writable(null);
      const start = backend.startNodeShell.bind(backend);
      return audited(
        { action: "node shell", target: `node/${node}`, namespace: null, kubectl: `kubectl debug node/${node} -it --image=busybox:1.36 --profile=sysadmin` },
        () => start(node),
      );
    },

    async listVolumes() {
      if (!backend?.listVolumes) throw new Error("Not connected.");
      return backend.listVolumes(session.namespace);
    },

    async searchLogs(request: LogSearchRequest) {
      if (!backend?.searchLogs) throw new Error("Not connected.");
      return backend.searchLogs(request);
    },

    async getTimeline(ref: ResourceRef) {
      if (!backend?.getTimeline) throw new Error("Not connected.");
      return backend.getTimeline(ref);
    },

    async listCertificates() {
      if (!backend?.listCertificates) throw new Error("Not connected.");
      return backend.listCertificates(session.namespace);
    },

    async listImages() {
      if (!backend?.listImages) throw new Error("Not connected.");
      return backend.listImages();
    },

    async findWorkloads(needle: string) {
      if (!backend?.findWorkloads) throw new Error("Not connected.");
      return backend.findWorkloads(needle);
    },

    current() {
      return { ...session };
    },

    async stopNodeShell(namespace: string, pod: string) {
      if (!backend?.stopNodeShell) throw new Error("Not connected.");
      return backend.stopNodeShell(namespace, pod);
    },

    async listAudit() {
      return audit.list();
    },

    record(entry) {
      audit.append({ ...entry, id: `${Date.now()}-${++auditCounter}`, time: new Date().toISOString(), cluster: session.clusterId ?? "" });
    },

    async whoCan(request: WhoCanRequest) {
      if (!backend?.whoCan) throw new Error("Not connected.");
      return backend.whoCan(request);
    },

    async myRules(namespace: string | null) {
      if (!backend?.myRules) throw new Error("Not connected.");
      return backend.myRules(namespace);
    },

    async listRelated(ref: ResourceRef) {
      if (!backend) throw new Error("Not connected.");
      return backend.listRelated(ref);
    },

    async listEvents(ref: ResourceRef) {
      if (!backend) throw new Error("Not connected.");
      return backend.listEvents(ref);
    },

    async listWarnings() {
      if (!backend) throw new Error("Not connected.");
      return backend.listWarnings(session.namespace);
    },

    async checkAccess(ref: ResourceRef) {
      if (!backend) throw new Error("Not connected.");
      return backend.checkAccess(ref);
    },

    async startDebug(request: DebugRequest) {
      if (!backend) throw new Error("Not connected.");
      writable(request.namespace);
      const target = backend;
      return audited(
        {
          action: "debug",
          target: `pod/${request.pod}`,
          namespace: request.namespace,
          kubectl: `kubectl debug -it ${request.pod} -n ${request.namespace} --image=${request.image || "busybox:1.36"}${request.target ? ` --target=${request.target}` : ""}`,
        },
        () => target.startDebug(request),
      );
    },

    async getGuards() {
      const all: Record<string, ContextGuard> = {};
      for (const summary of readKubeconfigSummaries(path()).summaries) all[summary.id] = guardFor(summary.id);
      return all;
    },

    async describeContext(clusterId: string) {
      return describeContext(path(), clusterId);
    },

    async updateContext(clusterId: string, edit: ContextEdit) {
      // The live session holds the context by name; editing it underneath would leave watches on stale settings.
      if (session.clusterId === clusterId && session.state !== "disconnected") {
        throw new Error("Disconnect from this cluster before editing its context.");
      }
      const saved = updateContext(path(), clusterId, edit);
      if (saved.name !== clusterId) {
        const all = { ...guards.load() };
        if (all[clusterId]) {
          all[saved.name] = all[clusterId]!;
          delete all[clusterId];
          guards.save(all);
        }
      }
      return saved;
    },

    async removeContext(clusterId: string) {
      if (session.clusterId === clusterId && session.state !== "disconnected") {
        throw new Error("Disconnect from this cluster before removing its context.");
      }
      const result = removeContext(path(), clusterId);
      const all = { ...guards.load() };
      if (all[clusterId]) {
        delete all[clusterId];
        guards.save(all);
      }
      return result;
    },

    async setGuard(clusterId: string, guard: ContextGuard) {
      const namespaces = Object.fromEntries(Object.entries(guard.namespaces ?? {}).filter(([, value]) => value === "readOnly" || value === "writable"));
      guards.save({
        ...guards.load(),
        [clusterId]: { protected: guard.protected, readOnly: guard.readOnly, ...(Object.keys(namespaces).length > 0 ? { namespaces } : {}) },
      });
      if (session.clusterId === clusterId) {
        session.guard = guardFor(clusterId);
        emitSession();
      }
    },

    assertWritable(namespace?: string | null) {
      writable(namespace);
    },

    async listExecTargets(ref: ResourceRef) {
      if (!backend) throw new Error("Not connected.");
      return backend.listExecTargets(ref);
    },

    async writeSecret(request: SecretWrite) {
      if (!backend?.writeSecret) throw new Error("Not connected.");
      writable(request.namespace);
      const write = backend.writeSecret.bind(backend);
      const keys = [...request.set.map((change) => change.key), ...request.remove.map((key) => `-${key}`)];
      // The history names the keys that changed, never their values.
      return audited(
        { action: "edit secret", target: `secret/${request.name}`, namespace: request.namespace, kubectl: `kubectl edit secret ${request.name} -n ${request.namespace}  # keys: ${keys.join(", ")}` },
        () => write(request),
      );
    },

    async readSecret(namespace: string, name: string) {
      if (!backend) throw new Error("Not connected.");
      return backend.readSecret(namespace, name);
    },

    async readUsage() {
      if (!backend) throw new Error("Not connected.");
      return backend.readUsage(session.namespace);
    },

    async listCounts() {
      if (!backend || session.state === "disconnected") return {};
      const namespace = session.namespace;
      const kinds = catalog.filter((entry) => !builtinKind(entry.kind));
      const counts: Record<string, number> = {};
      let cursor = 0;
      async function worker() {
        while (cursor < kinds.length) {
          const entry = kinds[cursor];
          cursor += 1;
          try {
            const listed = await backend!.listResources(entry.kind, entry.namespaced ? namespace : null);
            counts[entry.kind] = listed.rows.length;
          } catch {
            // A forbidden kind stays blank instead of showing a fake zero.
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, kinds.length) }, () => worker()));
      // Custom kinds can number in the hundreds, so they are counted with one-item requests, not full lists.
      const count = backend.countResources?.bind(backend);
      const custom = count ? (session.customKinds ?? []).slice() : [];
      let next = 0;
      async function customWorker() {
        while (next < custom.length) {
          const entry = custom[next]!;
          next += 1;
          try {
            counts[entry.kind] = await count!(entry.kind, entry.namespaced ? namespace : null);
          } catch {
            // Forbidden or gone: no number rather than a wrong one.
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, custom.length) }, () => customWorker()));
      return counts;
    },

    async setFocus(kind: ResourceKind) {
      focusKind = kind;
      const myLife = life;
      const myFocus = ++focusLife;
      clearFocusTimer();
      stopFocusWatch();
      if (!backend || session.state === "disconnected") return;
      if (builtinKind(kind)) {
        batcher.resetResources([]);
        return;
      }
      const summary = readKubeconfigSummaries(path()).summaries.find((item) => item.id === session.clusterId);
      const server = summary?.server ?? "";
      try {
        await syncFocus(myLife, myFocus, server);
      } catch (error) {
        if (myLife !== life || myFocus !== focusLife) return;
        void recoverFocus({ statusCode: statusOf(error), message: messageOf(error) }, server, myFocus);
      }
    },

    onSession(listener) {
      sessionListeners.add(listener);
      listener({ ...session, namespaces: session.namespaces.slice(), guard: { ...session.guard }, forbidden: { ...session.forbidden } });
      return () => sessionListeners.delete(listener);
    },
  };
}

export function loadContextConfig(filePath: string, contextName: string) {
  const kc = loadKubeConfig(filePath);
  kc.setCurrentContext(contextName);
  return kc;
}
