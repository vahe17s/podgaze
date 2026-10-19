import type { CatalogEntry, CommandName, ResourceKind } from "./catalog.js";

export type ClusterSummary = {
  id: string;
  name: string;
  server: string;
  namespace: string | null;
  usable: boolean;
  problem: string | null;
  // When the context logs in with a client certificate: when it stops being valid (ISO time).
  certExpires: string | null;
};

export type ContainerSnap = {
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  state: string;
};

export type PodRow = {
  uid: string;
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  nodeName: string;
  ageStart: string;
  images: string[];
  ip: string;
  qos: string;
  controlledBy: string;
  ports: string[];
  containers: ContainerSnap[];
  // Why the most-restarted container last stopped, e.g. "OOMKilled (137)".
  lastExit: string;
  labels: Record<string, string>;
  // Summed over containers; 0 when no container sets it.
  requests: Resources;
  limits: Resources;
};

export type Resources = { cpuMillicores: number; memoryBytes: number };

export type NodeRow = {
  uid: string;
  name: string;
  status: string;
  roles: string[];
  kubeletVersion: string;
  ageStart: string;
  internalIP: string;
  cpu: string;
  memory: string;
  podCapacity: string;
  os: string;
  runtime: string;
  unschedulable: boolean;
  labels: Record<string, string>;
};

export type DeploymentRow = {
  uid: string;
  name: string;
  namespace: string;
  status: string;
  ready: string;
  updated: string;
  available: string;
  ageStart: string;
  images: string[];
  labels: Record<string, string>;
  paused: boolean;
};

export type ResourceRow = {
  uid: string;
  kind: ResourceKind;
  name: string;
  namespace: string;
  status: string;
  ageStart: string;
  columns: Record<string, string>;
  labels: Record<string, string>;
};

export type RowChange<T> = {
  reset?: boolean;
  upsert: T[];
  delete: string[];
};

export type RowBatch = {
  pods?: RowChange<PodRow>;
  nodes?: RowChange<NodeRow>;
  deployments?: RowChange<DeploymentRow>;
  resources?: RowChange<ResourceRow>;
};

export type { BuiltinKind, CatalogColumn, CatalogEntry, CommandName, PrinterColumn, ResourceKind } from "./catalog.js";
export { apiKindOf, canExec, catalog, catalogEntry, catalogGroups, customKinds, entryForApiKind, kubectlName, mutatingCommands, resourcePath, registerCustomKinds } from "./catalog.js";

export type ResourceRef = {
  kind: ResourceKind;
  namespace: string | null;
  name: string;
};

export type CommandRequest = {
  name: CommandName;
  kind: ResourceKind;
  resourceName: string;
  namespace: string | null;
  container?: string;
  replicas?: number;
  revision?: number;
  // set-image: the new image for container.
  image?: string;
};

export type CommandResult = {
  title: string;
  command: string;
  output: string;
};

// What a kubeconfig context is made of. Never carries a secret: tokens, keys, and passwords stay in the main process.
export type ContextDetails = {
  id: string;
  file: string;
  current: boolean;
  cluster: string;
  user: string;
  server: string;
  namespace: string | null;
  auth: string;
  certExpires: string | null;
  skipTLSVerify: boolean;
  ca: string;
  // Other contexts that use the same cluster entry; changing the server changes them too.
  sharedWith: string[];
  // The context, cluster, and user entries as YAML, with secrets replaced.
  yaml: string;
};

export type ContextEdit = {
  name?: string;
  namespace?: string | null;
  server?: string;
};

// What deleting a context took with it: its cluster and user entries go too when no other context uses them.
export type ContextRemoved = {
  file: string;
  backup: string;
  removed: string[];
};

export type ContextSaved = {
  name: string;
  file: string;
  backup: string;
};

export type SessionState = "disconnected" | "connecting" | "connected" | "reconnecting";

// Per-context safety settings. Protected adds typed confirmation; read-only refuses every write.
export type ContextGuard = {
  protected: boolean;
  readOnly: boolean;
  // Per-namespace exceptions: keep one namespace writable on a read-only cluster, or lock one down on a writable one.
  namespaces?: Record<string, NamespaceGuard>;
};

export type NamespaceGuard = "readOnly" | "writable";

// A cluster kept connected in the background, shown as a tab.
export type OpenCluster = { id: string; state: SessionState };

export type Session = {
  state: SessionState;
  clusterId: string | null;
  namespace: string | null;
  kubeconfigPath: string | null;
  problem: string | null;
  namespaces: string[];
  guard: ContextGuard;
  // Kinds this account may not list, with the reason, so one 403 does not blank the whole app.
  forbidden: Partial<Record<ResourceKind, string>>;
  // The cluster's CustomResourceDefinitions, discovered on connect.
  customKinds?: CatalogEntry[];
  open?: OpenCluster[];
};

export type LogRequest = {
  namespace: string;
  pod: string;
  containers: string[];
  tailLines?: number;
  previous?: boolean;
};

export type LogFollowRequest = {
  namespace: string;
  pod: string;
  container: string;
  previous?: boolean;
  tailLines?: number;
  // A time window instead of a line count: only lines newer than this many seconds.
  sinceSeconds?: number;
  // Everything the container has written since it started (capped in size).
  all?: boolean;
};

export type LogEvent =
  | { id: string; type: "data"; data: string }
  | { id: string; type: "end" }
  | { id: string; type: "error"; message: string };

export type LogBundle = {
  filename: string;
  text: string;
};

export type ApplyRequest = {
  // The manifest as it was when editing started. Only fields that differ from it are sent.
  base: string;
  draft: string;
  dryRun?: boolean;
  // Apply even when a changed field was also changed on the server since editing started.
  force?: boolean;
};

export type ApplyResult = {
  applied: boolean;
  // Live object before the change, and the object the server returned (or would return on a dry run).
  live: string;
  yaml: string;
  message: string;
  // Fields this edit touches that someone else changed after editing started.
  conflicts: string[];
};

export type RelatedRef = ResourceRef & {
  relation: string;
  status?: string;
};

export type ObjectEvent = {
  time: string;
  type: string;
  reason: string;
  message: string;
  count: number;
  source: string;
};

// A Warning event anywhere in view, with the object it is about so the UI can open it.
export type ClusterWarning = {
  time: string;
  reason: string;
  message: string;
  count: number;
  namespace: string;
  object: ResourceRef | null;
  objectLabel: string;
};

export type AccessVerb = "delete" | "patch" | "exec" | "portforward" | "logs";

export type AccessMap = Partial<Record<AccessVerb, boolean>>;

export type DebugRequest = {
  namespace: string;
  pod: string;
  target: string;
  image: string;
};

export type ExecTarget = {
  namespace: string;
  pod: string;
  containers: string[];
};

export type SecretValue = {
  key: string;
  // Decoded text; empty for binary values.
  value: string;
  binary: boolean;
  // The stored base64, exactly as in the Secret.
  encoded: string;
};

export type SecretReveal = {
  type: string;
  values: SecretValue[];
  // The version that was read; a save is refused if the Secret changed since.
  resourceVersion?: string;
  immutable?: boolean;
  // Who owns the content (Helm, Argo CD, External Secrets, Sealed Secrets); edits there are usually overwritten.
  managedBy?: string;
};

export type SecretChange = {
  key: string;
  value: string;
  // "text" is encoded to base64 for you; "base64" is stored as given.
  encoding: "text" | "base64";
};

export type SecretWrite = {
  namespace: string;
  name: string;
  resourceVersion: string;
  set: SecretChange[];
  remove: string[];
};

export type ForwardKind = "Pod" | "Service" | "Deployment" | "StatefulSet";

export type PortForwardRequest = {
  namespace: string;
  // For a Service or workload, a ready pod is picked for every new connection, so restarts do not break the forward.
  kind?: ForwardKind;
  // The pod name, or the Service or workload name when kind says so.
  pod: string;
  remotePort: number;
  localPort?: number;
};

export type PortForwardInfo = {
  id: string;
  namespace: string;
  kind: ForwardKind;
  pod: string;
  remotePort: number;
  localPort: number;
};

export type UsagePoint = {
  name: string;
  namespace: string;
  cpuMillicores: number;
  memoryBytes: number;
};

export type ClusterUsage = {
  available: boolean;
  nodes: UsagePoint[];
  pods: UsagePoint[];
};

export { cpuMillicores, memoryBytes } from "./quantity.js";

export type TerminalRequest =
  | { mode: "shell" }
  // command defaults to a shell; a node shell passes its nsenter line.
  | { mode: "exec"; namespace: string; pod: string; container: string; command?: string[] };

export type TerminalEvent =
  | { id: string; type: "data"; data: string }
  | { id: string; type: "exit"; code: number | null };

export type CreateRequest = {
  // One or more YAML documents.
  yaml: string;
  dryRun?: boolean;
  // Used for namespaced objects that do not name one.
  namespace?: string | null;
};

export type CreateResult = {
  created: ResourceRef[];
  dryRun: boolean;
  message: string;
};

export type HelmRelease = {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chartVersion: string;
  appVersion: string;
  updated: string;
  description: string;
};

export type HelmRevision = {
  revision: number;
  status: string;
  updated: string;
  chartVersion: string;
  appVersion: string;
  description: string;
};

export type HelmReleaseDetail = HelmRelease & {
  // User-supplied values only, as YAML; secrets in values are shown as they are stored.
  values: string;
  manifest: string;
  notes: string;
  history: HelmRevision[];
};

export type HelmActionRequest = {
  name: string;
  namespace: string;
  action: "rollback" | "uninstall";
  revision?: number;
};

export type HelmRepo = { name: string; url: string };

export type HelmChart = {
  // "repo/chart", as helm install takes it.
  name: string;
  version: string;
  appVersion: string;
  description: string;
};

export type HelmInstallRequest = {
  release: string;
  namespace: string;
  // "repo/chart", "oci://registry/path/chart", or a chart URL.
  chart: string;
  version?: string;
  // The full values file to install with.
  values: string;
  createNamespace?: boolean;
  dryRun?: boolean;
  // Upgrade an existing release instead of installing a new one.
  upgrade?: boolean;
};

export type MapNode = {
  id: string;
  kind: ResourceKind;
  name: string;
  namespace: string | null;
  status: string;
  // Objects that belong to the same app share a group; config shared by several apps sits in the first one.
  group: number;
};

export type MapEdge = { from: string; to: string; relation: string };

export type ResourceMap = { nodes: MapNode[]; edges: MapEdge[]; truncated: boolean };

export type MapScope = {
  // null means every namespace.
  namespaces: string[] | null;
  labelSelector?: string;
};

export type ArgoResource = {
  kind: string;
  group: string;
  name: string;
  namespace: string;
  sync: string;
  health: string;
  message: string;
};

export type ArgoApp = {
  name: string;
  namespace: string;
  project: string;
  sync: string;
  health: string;
  healthMessage: string;
  repo: string;
  path: string;
  chart: string;
  targetRevision: string;
  revision: string;
  destServer: string;
  destNamespace: string;
  autoSync: boolean;
  operation: { phase: string; message: string; startedAt: string; finishedAt: string } | null;
  conditions: { type: string; message: string }[];
  resources: ArgoResource[];
  reconciledAt: string;
  // Past syncs, newest first.
  history: { id: number; revision: string; deployedAt: string; source: string }[];
};

export type ArgoAction = {
  name: string;
  namespace: string;
  action: "sync" | "refresh" | "hard-refresh" | "rollback" | "disable-autosync";
  prune?: boolean;
  // rollback: the Git revision of a history entry to sync to.
  revision?: string;
};

export type HubChart = {
  name: string;
  version: string;
  appVersion: string;
  description: string;
  stars: number;
  repo: { name: string; url: string; official: boolean; verified: boolean };
};

export type NodeShell = { namespace: string; pod: string; container: string; command: string[] };

export type WorkloadImages = {
  kind: ResourceKind;
  namespace: string;
  name: string;
  containers: { name: string; image: string }[];
};

export type CertInfo = {
  // TLS Secrets and cert-manager Certificates, plus the other things that stop working on a date: webhook and
  // APIService CA bundles, External Secrets syncs, and kubeconfig client certificates.
  source: "Secret" | "Certificate" | "Webhook" | "APIService" | "ExternalSecret" | "Kubeconfig";
  namespace: string;
  name: string;
  // For a cert-manager Certificate, the Secret that holds it; for a Secret, the Certificate that manages it.
  secretName: string;
  certificateName: string;
  subject: string;
  dnsNames: string[];
  issuer: string;
  notAfter: string;
  renewalTime: string;
  ready: string;
  problem: string;
};

export type ClusterAlert = {
  id: string;
  clusterId: string;
  kind: ResourceKind;
  namespace: string | null;
  name: string;
  reason: string;
  message: string;
  time: string;
};

export type CloudProvider = "azure" | "aws" | "gcp";

// An Azure subscription, an AWS CLI profile, or a Google Cloud project.
export type CloudAccount = { id: string; name: string; isDefault: boolean };

export type CloudCluster = {
  provider: CloudProvider;
  name: string;
  // Resource group (Azure), region (AWS), or location (Google Cloud): what get-credentials needs besides the name.
  group: string;
  location: string;
  version: string;
  state: string;
  note: string;
  accountId: string;
};

export type CloudAddRequest = {
  provider: CloudProvider;
  accountId: string;
  group: string;
  name: string;
  // Azure only: use the az login (kubelogin -l azurecli) instead of device-code prompts.
  azureCliLogin?: boolean;
};

// One thing that happened to an app: a rollout, a sync, scaling, a crash. Merged onto one time axis.
export type TimelineCategory = "deploy" | "sync" | "scale" | "crash" | "oom" | "warning" | "info";

export type TimelineEntry = {
  time: string;
  category: TimelineCategory;
  title: string;
  detail: string;
  // The object it came from, like "Pod api-7c9f" or "ReplicaSet api-5d8".
  object: string;
};

export type Timeline = {
  entries: TimelineEntry[];
  // Kubernetes keeps events for about an hour by default; older warnings are gone, rollouts and syncs are not.
  eventsSince: string | null;
};

// grep across many pods at once: every replica of a workload, or every pod in a namespace.
export type LogSearchRequest = {
  namespace: string;
  workload?: ResourceRef;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  sinceSeconds: number;
};

export type LogMatch = {
  pod: string;
  container: string;
  time: string;
  line: string;
  // Character ranges of the hits within line, for highlighting.
  ranges: [number, number][];
};

export type LogSearchResult = {
  matches: LogMatch[];
  pods: number;
  containers: number;
  lines: number;
  // More matched than are returned; the newest are kept.
  truncated: boolean;
  problems: string[];
};

// A PersistentVolumeClaim with what it costs depends on: its class and size, and who mounts it.
export type VolumeInfo = {
  namespace: string;
  name: string;
  storageClass: string;
  sizeBytes: number;
  phase: string;
  // Pods that mount it right now; empty for a claim nothing uses.
  usedBy: string[];
};

export type StorageClassInfo = { name: string; provisioner: string; sku: string; isDefault: boolean };

export type VolumeReport = { volumes: VolumeInfo[]; classes: StorageClassInfo[] };

export type PriceRequest = { region: string; instanceType: string; spot: boolean };
export type PriceQuote = PriceRequest & { hourly: number | null; note: string };

export type AuditEntry = {
  id: string;
  time: string;
  cluster: string;
  namespace: string | null;
  action: string;
  target: string;
  kubectl: string;
  ok: boolean;
  error?: string;
  dryRun?: boolean;
};

export type WhoCanRequest = {
  verb: string;
  resource: string;
  group: string;
  namespace: string | null;
};

export type WhoCanSubject = {
  kind: string;
  name: string;
  namespace?: string;
  binding: string;
  role: string;
  scope: "cluster" | "namespace";
};

export type AccessRule = {
  verbs: string[];
  apiGroups: string[];
  resources: string[];
  resourceNames: string[];
};

// Self-update from GitHub releases. Windows and AppImage download and install; a .deb and an unsigned macOS app
// can only be told that a new version exists, and link to it.
export type UpdateState = {
  status: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "unsupported";
  current: string;
  version?: string;
  // 0 to 100 while downloading.
  progress?: number;
  // Where to get it by hand when this install cannot update itself.
  releaseUrl?: string;
  canInstall: boolean;
  automatic: boolean;
  message?: string;
};

export interface ClusterClient {
  listClusters(): Promise<ClusterSummary[]>;
  pickKubeconfig(): Promise<string | null>;
  connect(clusterId: string): Promise<void>;
  disconnect(): Promise<void>;
  setNamespace(namespace: string | null): Promise<void>;
  subscribeRows(onBatch: (batch: RowBatch) => void): () => void;
  getYaml(ref: ResourceRef): Promise<string>;
  runCommand(request: CommandRequest): Promise<CommandResult>;
  setFocus(kind: ResourceKind): Promise<void>;
  listCounts(): Promise<Record<string, number>>;
  getLogs(request: LogRequest): Promise<LogBundle>;
  followLogs(request: LogFollowRequest): Promise<{ id: string }>;
  stopFollow(id: string): Promise<void>;
  onLogs(listener: (event: LogEvent) => void): () => void;
  applyYaml(request: ApplyRequest): Promise<ApplyResult>;
  listRelated(ref: ResourceRef): Promise<RelatedRef[]>;
  listEvents(ref: ResourceRef): Promise<ObjectEvent[]>;
  listWarnings(): Promise<ClusterWarning[]>;
  checkAccess(ref: ResourceRef): Promise<AccessMap>;
  getGuards(): Promise<Record<string, ContextGuard>>;
  describeContext(clusterId: string): Promise<ContextDetails>;
  updateContext(clusterId: string, edit: ContextEdit): Promise<ContextSaved>;
  removeContext(clusterId: string): Promise<ContextRemoved>;
  setGuard(clusterId: string, guard: ContextGuard): Promise<void>;
  startDebug(request: DebugRequest): Promise<{ container: string }>;
  listExecTargets(ref: ResourceRef): Promise<ExecTarget[]>;
  readSecret(namespace: string, name: string): Promise<SecretReveal>;
  writeSecret(request: SecretWrite): Promise<SecretReveal>;
  openPortForward(request: PortForwardRequest): Promise<PortForwardInfo>;
  closePortForward(id: string): Promise<void>;
  listPortForwards(): Promise<PortForwardInfo[]>;
  readUsage(): Promise<ClusterUsage>;
  openTerminal(request: TerminalRequest): Promise<{ id: string }>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminal(listener: (event: TerminalEvent) => void): () => void;
  onSession(listener: (session: Session) => void): () => void;
  createYaml(request: CreateRequest): Promise<CreateResult>;
  listHelmReleases(): Promise<HelmRelease[]>;
  getHelmRelease(namespace: string, name: string): Promise<HelmReleaseDetail>;
  helmAction(request: HelmActionRequest): Promise<CommandResult>;
  helmRepos(): Promise<HelmRepo[]>;
  helmAddRepo(repo: HelmRepo): Promise<void>;
  helmSearch(term: string): Promise<HelmChart[]>;
  helmChartValues(chart: string, version?: string): Promise<string>;
  helmInstall(request: HelmInstallRequest): Promise<CommandResult>;
  getMap(scope: MapScope): Promise<ResourceMap>;
  listArgoApps(): Promise<ArgoApp[]>;
  argoAction(request: ArgoAction): Promise<CommandResult>;
  hubSearch(term: string): Promise<HubChart[]>;
  startNodeShell(node: string): Promise<NodeShell>;
  // Reads from any cluster that is open in a tab, not only the one on screen.
  findWorkloads(clusterId: string, needle: string): Promise<ResourceRow[]>;
  getYamlIn(clusterId: string, ref: ResourceRef): Promise<string>;
  listImagesIn(clusterId: string): Promise<WorkloadImages[]>;
  listCertificates(): Promise<CertInfo[]>;
  // Rollouts, syncs, scaling, crashes, and warnings of one workload, newest first.
  getTimeline(ref: ResourceRef): Promise<Timeline>;
  searchLogs(request: LogSearchRequest): Promise<LogSearchResult>;
  // PersistentVolumeClaims in view with their storage class and size, for storage cost.
  listVolumes(): Promise<VolumeReport>;
  updateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  setAutomaticUpdates(enabled: boolean): Promise<UpdateState>;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  // Public list prices per node instance type (Azure Retail Prices API). Nothing about the cluster is sent but the type and region.
  lookupPrices(requests: PriceRequest[]): Promise<PriceQuote[]>;
  // Pods that start failing in any open cluster, and Argo CD apps that turn Degraded.
  onAlert(listener: (alert: ClusterAlert) => void): () => void;
  // A desktop notification was clicked: open what it was about.
  onAlertOpen(listener: (alert: ClusterAlert) => void): () => void;
  setNotifications(enabled: boolean): Promise<void>;
  // Adding clusters from a cloud account, through that cloud's own CLI and sign-in.
  cloudAccounts(provider: CloudProvider): Promise<CloudAccount[]>;
  cloudDefaultRegion(accountId: string): Promise<string>;
  cloudClusters(provider: CloudProvider, accountId: string, region?: string): Promise<CloudCluster[]>;
  cloudAddCluster(request: CloudAddRequest): Promise<{ context: string; message: string }>;
  stopNodeShell(namespace: string, pod: string): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  whoCan(request: WhoCanRequest): Promise<WhoCanSubject[]>;
  myRules(namespace: string | null): Promise<AccessRule[]>;
  // Disconnects one background cluster tab without touching the one on screen.
  closeCluster(clusterId: string): Promise<void>;
}
