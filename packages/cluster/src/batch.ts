import type { VolumeReport, LogSearchRequest, LogSearchResult, Timeline, CertInfo, WorkloadImages, ArgoAction, ArgoApp, HubChart, MapScope, NodeShell, ResourceMap, HelmChart, HelmInstallRequest, HelmRepo, AccessRule, CatalogEntry, ClusterWarning, AccessMap, ApplyRequest, ApplyResult, ClusterUsage, CommandRequest, CommandResult, CreateRequest, CreateResult, DebugRequest, DeploymentRow, ExecTarget, HelmActionRequest, HelmRelease, HelmReleaseDetail, LogBundle, LogRequest, NodeRow, ObjectEvent, PodRow, RelatedRef, ResourceKind, ResourceRef, ResourceRow, RowBatch, RowChange, SecretReveal, SecretWrite, WhoCanRequest, WhoCanSubject } from "@podgaze/contracts";

export type Listed<T> = { resourceVersion: string; rows: T[] };

export type WatchError = { statusCode: number | null; message: string };

export type WatchHandlers = {
  onEvent: (phase: string, object: unknown) => void;
  onError: (error: WatchError) => void;
};

export type WatchHandle = { stop: () => void };

export interface ClusterBackend {
  listPods(namespace: string | null): Promise<Listed<PodRow>>;
  watchPods(namespace: string | null, resourceVersion: string, handlers: WatchHandlers): Promise<WatchHandle>;
  listNodes(): Promise<Listed<NodeRow>>;
  watchNodes(resourceVersion: string, handlers: WatchHandlers): Promise<WatchHandle>;
  listNamespaces(): Promise<string[]>;
  listDeployments(namespace: string | null): Promise<Listed<DeploymentRow>>;
  watchDeployments(namespace: string | null, resourceVersion: string, handlers: WatchHandlers): Promise<WatchHandle>;
  listResources(kind: ResourceKind, namespace: string | null): Promise<Listed<ResourceRow>>;
  watchResources(kind: ResourceKind, namespace: string | null, resourceVersion: string, handlers: WatchHandlers): Promise<WatchHandle>;
  getYaml(ref: ResourceRef): Promise<string>;
  runCommand(request: CommandRequest): Promise<CommandResult>;
  getLogs(request: LogRequest): Promise<LogBundle>;
  applyYaml(request: ApplyRequest): Promise<ApplyResult>;
  listRelated(ref: ResourceRef): Promise<RelatedRef[]>;
  listEvents(ref: ResourceRef): Promise<ObjectEvent[]>;
  listWarnings(namespace: string | null): Promise<ClusterWarning[]>;
  checkAccess(ref: ResourceRef): Promise<AccessMap>;
  startDebug(request: DebugRequest): Promise<{ container: string }>;
  listExecTargets(ref: ResourceRef): Promise<ExecTarget[]>;
  readSecret(namespace: string, name: string): Promise<SecretReveal>;
  writeSecret?(request: SecretWrite): Promise<SecretReveal>;
  readUsage(namespace: string | null): Promise<ClusterUsage>;
  // Optional so test doubles only implement what they exercise.
  listCustomKinds?(): Promise<CatalogEntry[]>;
  // How many objects of a kind exist, from one tiny request (remainingItemCount), without listing them.
  countResources?(kind: ResourceKind, namespace: string | null): Promise<number>;
  createYaml?(request: CreateRequest): Promise<CreateResult>;
  listHelmReleases?(namespace: string | null): Promise<HelmRelease[]>;
  getHelmRelease?(namespace: string, name: string): Promise<HelmReleaseDetail>;
  helmAction?(request: HelmActionRequest): Promise<CommandResult>;
  helmRepos?(): Promise<HelmRepo[]>;
  helmAddRepo?(repo: HelmRepo): Promise<void>;
  helmSearch?(term: string): Promise<HelmChart[]>;
  helmChartValues?(chart: string, version?: string): Promise<string>;
  helmInstall?(request: HelmInstallRequest): Promise<CommandResult>;
  getMap?(scope: MapScope): Promise<ResourceMap>;
  listArgoApps?(): Promise<ArgoApp[]>;
  argoAction?(request: ArgoAction): Promise<CommandResult>;
  hubSearch?(term: string): Promise<HubChart[]>;
  startNodeShell?(node: string): Promise<NodeShell>;
  stopNodeShell?(namespace: string, pod: string): Promise<void>;
  listCertificates?(namespace: string | null): Promise<CertInfo[]>;
  getTimeline?(ref: ResourceRef): Promise<Timeline>;
  searchLogs?(request: LogSearchRequest): Promise<LogSearchResult>;
  listVolumes?(namespace: string | null): Promise<VolumeReport>;
  listImages?(): Promise<WorkloadImages[]>;
  findWorkloads?(needle: string): Promise<ResourceRow[]>;
  whoCan?(request: WhoCanRequest): Promise<WhoCanSubject[]>;
  myRules?(namespace: string | null): Promise<AccessRule[]>;
}

export type Clock = {
  setTimeout(fn: () => void, ms: number): () => void;
};

export const realClock: Clock = {
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export const BACKOFF_MS = [1000, 2000, 4000, 15000];

type KindBuffer<T extends { uid: string }> = {
  reset: T[] | null;
  upsert: Map<string, T>;
  delete: Set<string>;
};

function emptyKind<T extends { uid: string }>(): KindBuffer<T> {
  return { reset: null, upsert: new Map(), delete: new Set() };
}

function noteReset<T extends { uid: string }>(buffer: KindBuffer<T>, rows: T[]) {
  buffer.reset = rows.slice();
  buffer.upsert.clear();
  buffer.delete.clear();
}

function noteUpsert<T extends { uid: string }>(buffer: KindBuffer<T>, row: T) {
  if (buffer.reset) {
    const index = buffer.reset.findIndex((item) => item.uid === row.uid);
    if (index >= 0) buffer.reset[index] = row;
    else buffer.reset.push(row);
    return;
  }
  buffer.delete.delete(row.uid);
  buffer.upsert.set(row.uid, row);
}

function noteDelete<T extends { uid: string }>(buffer: KindBuffer<T>, uid: string) {
  if (buffer.reset) {
    buffer.reset = buffer.reset.filter((item) => item.uid !== uid);
    return;
  }
  buffer.upsert.delete(uid);
  buffer.delete.add(uid);
}

function drain<T extends { uid: string }>(buffer: KindBuffer<T>): RowChange<T> | null {
  if (!buffer.reset && buffer.upsert.size === 0 && buffer.delete.size === 0) return null;
  const change: RowChange<T> = {
    upsert: buffer.reset ? buffer.reset.slice() : [...buffer.upsert.values()],
    delete: buffer.reset ? [] : [...buffer.delete],
  };
  if (buffer.reset) change.reset = true;
  buffer.reset = null;
  buffer.upsert.clear();
  buffer.delete.clear();
  return change;
}

export class RowBatcher {
  private pods = emptyKind<PodRow>();
  private nodes = emptyKind<NodeRow>();
  private deployments = emptyKind<DeploymentRow>();
  private resources = emptyKind<ResourceRow>();
  private timer: (() => void) | null = null;

  constructor(
    private readonly emit: (batch: RowBatch) => void,
    private readonly clock: Clock,
    private readonly batchMs: number,
  ) {}

  resetPods(rows: PodRow[]) {
    noteReset(this.pods, rows);
    this.schedule();
  }

  resetNodes(rows: NodeRow[]) {
    noteReset(this.nodes, rows);
    this.schedule();
  }

  resetDeployments(rows: DeploymentRow[]) {
    noteReset(this.deployments, rows);
    this.schedule();
  }

  resetResources(rows: ResourceRow[]) {
    noteReset(this.resources, rows);
    this.schedule();
  }

  upsertPod(row: PodRow) {
    noteUpsert(this.pods, row);
    this.schedule();
  }

  upsertNode(row: NodeRow) {
    noteUpsert(this.nodes, row);
    this.schedule();
  }

  upsertDeployment(row: DeploymentRow) {
    noteUpsert(this.deployments, row);
    this.schedule();
  }

  upsertResource(row: ResourceRow) {
    noteUpsert(this.resources, row);
    this.schedule();
  }

  deletePod(uid: string) {
    noteDelete(this.pods, uid);
    this.schedule();
  }

  deleteNode(uid: string) {
    noteDelete(this.nodes, uid);
    this.schedule();
  }

  deleteDeployment(uid: string) {
    noteDelete(this.deployments, uid);
    this.schedule();
  }

  deleteResource(uid: string) {
    noteDelete(this.resources, uid);
    this.schedule();
  }

  cancel() {
    this.timer?.();
    this.timer = null;
    this.pods = emptyKind();
    this.nodes = emptyKind();
    this.deployments = emptyKind();
    this.resources = emptyKind();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batchMs);
  }

  private flush() {
    const pods = drain(this.pods);
    const nodes = drain(this.nodes);
    const deployments = drain(this.deployments);
    const resources = drain(this.resources);
    if (!pods && !nodes && !deployments && !resources) return;
    const batch: RowBatch = {};
    if (pods) batch.pods = pods;
    if (nodes) batch.nodes = nodes;
    if (deployments) batch.deployments = deployments;
    if (resources) batch.resources = resources;
    this.emit(batch);
  }
}

export function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof error.code === "number") return error.code;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return null;
}

function bodyMessage(body: unknown): string | null {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message) return body.message;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    } catch {
      // Not JSON.
    }
  }
  return null;
}

export function messageOf(error: unknown): string {
  const body = error && typeof error === "object" && "body" in error ? (error as { body?: unknown }).body : null;
  const code = statusOf(error);
  // 401 means the server never got as far as deciding permissions: the credentials themselves were refused.
  if (code === 401) {
    return "The cluster rejected this context's credentials (401 Unauthorized). The token or client certificate is expired or revoked. Get a fresh kubeconfig for this context and reconnect.";
  }
  // The API server's own message ("pods is forbidden: ...") beats the client's generic HTTP text.
  const fromServer = bodyMessage(body);
  if (fromServer) return fromServer;
  if (error instanceof Error && error.message) {
    // The client's ApiException text dumps every response header; keep only the status line.
    const http = /^HTTP-Code: (\d+)\s*Message: ([^\n]*)/.exec(error.message);
    if (http) return `${http[2]?.trim() || "Request failed"} (HTTP ${http[1]})`;
    return friendlyAuthError(error.message);
  }
  return "Request failed";
}

// Cloud logins run a helper program from the kubeconfig. When it is missing, say which one.
export function friendlyAuthError(message: string): string {
  const missing = /spawn(?:Sync)? (\S+) ENOENT/.exec(message);
  if (missing) {
    return `Could not run "${missing[1]}", which this kubeconfig uses to log in. Install it or add its folder to PATH, then reconnect.`;
  }
  return message;
}
