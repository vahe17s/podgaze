import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState, VolumeReport, LogSearchRequest, LogSearchResult, PriceQuote, PriceRequest, Timeline, CloudAccount, CloudAddRequest, CloudCluster, CloudProvider, CertInfo, ClusterAlert, ResourceRef, ResourceRow, WorkloadImages, SecretReveal, SecretWrite, ArgoApp, HubChart, MapScope, ResourceMap, HelmInstallRequest, AccessRule, AuditEntry, CreateRequest, CreateResult, HelmActionRequest, HelmRelease, HelmReleaseDetail, WhoCanSubject, ContextDetails, ContextEdit, ContextSaved, ClusterWarning, AccessMap, ApplyRequest, ClusterClient, ExecTarget, LogEvent, LogFollowRequest, ClusterSummary, PodRow, RelatedRef, RowBatch, Session } from "@podgaze/contracts";
import { EditorView } from "@codemirror/view";
import { App } from "./App";
import { clearUsageHistory } from "./usage";
import { resetSettings } from "./settings";
import { recordUsage } from "./usage";
import { setZoom } from "./zoom";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const clusters: ClusterSummary[] = [
  {
    id: "prod",
    name: "prod",
    server: "https://prod.example:6443",
    namespace: "default",
    usable: true,
    problem: null,
    certExpires: null,
  },
  {
    id: "staging",
    name: "staging",
    server: "https://staging.example:6443",
    namespace: null,
    usable: true,
    problem: null,
    certExpires: "2026-08-14T06:53:25.000Z",
  },
  {
    id: "bad",
    name: "bad",
    server: "",
    namespace: null,
    usable: false,
    problem: "This context has no cluster or user.",
    certExpires: null,
  },
];

const disconnected: Session = {
  state: "disconnected",
  clusterId: null,
  namespace: null,
  kubeconfigPath: "/home/dev/.kube/config",
  problem: null,
  namespaces: [],
  guard: { protected: false, readOnly: false },
  forbidden: {},
};

function pod(name: string, namespace = "default"): PodRow {
  return {
    uid: name,
    name,
    namespace,
    status: name === "worker-2ab1" ? "CrashLoopBackOff" : "Running",
    ready: "1/1",
    restarts: name === "worker-2ab1" ? 14 : 0,
    nodeName: "ip-10-0-4",
    ageStart: "2026-01-01T00:00:00.000Z",
    images: ["api:1.8.2"],
    ip: "10.0.1.8",
    qos: "Burstable",
    controlledBy: "ReplicaSet/api",
    ports: ["8080/TCP"],
    containers: [{ name: "api", image: "api:1.8.2", ready: true, restarts: 0, state: "Running" }],
    lastExit: name === "worker-2ab1" ? "OOMKilled (137)" : "",
    labels: { app: name.split("-")[0]!, tier: name === "cache-11f0" ? "cache" : "web" },
    requests: { cpuMillicores: 100, memoryBytes: 128 * 1024 ** 2 },
    limits: { cpuMillicores: 500, memoryBytes: 256 * 1024 ** 2 },
  };
}

function createClient() {
  let onSession: (session: Session) => void = () => undefined;
  let onRows: (batch: RowBatch) => void = () => undefined;
  let onAlert: (alert: ClusterAlert) => void = () => undefined;
  let onUpdate: (state: UpdateState) => void = () => undefined;
  const client = {
    listClusters: vi.fn(async () => clusters),
    pickKubeconfig: vi.fn(async () => null),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => onSession(disconnected)),
    setNamespace: vi.fn(async () => undefined),
    getYaml: vi.fn(async () => "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api-7d9c\n"),
    runCommand: vi.fn(async () => ({
      title: "Describe",
      command: "kubectl describe pod api-7d9c -n default",
      output: "Name: api-7d9c\nStatus: Running\nIP: 10.0.1.8\n",
    })),
    setFocus: vi.fn(async () => undefined),
    listCounts: vi.fn(async () => ({ ConfigMap: 4, Secret: 2, Service: 1 })),
    getLogs: vi.fn(async () => ({ filename: "api-7d9c-api.log", text: "listening\n" })),
    applyYaml: vi.fn(async (request: ApplyRequest) => ({
      applied: !request.dryRun,
      live: request.base,
      yaml: request.draft,
      message: request.dryRun ? "The API server accepted this change. Nothing is saved yet." : "Live manifest updated.",
      conflicts: [] as string[],
    })),
    listRelated: vi.fn(async (): Promise<RelatedRef[]> => [
      { kind: "Deployment", namespace: "default", name: "api", relation: "Owner", status: "Available" },
      { kind: "Node", namespace: null, name: "ip-10-0-4", relation: "Node" },
    ]),
    listEvents: vi.fn(async () => [
      { time: "2026-01-01T00:00:00.000Z", type: "Warning", reason: "BackOff", message: "Back-off restarting failed container", count: 3, source: "kubelet" },
    ]),
    listWarnings: vi.fn(async (): Promise<ClusterWarning[]> => [
      { time: "2026-01-01T00:00:00.000Z", reason: "BackOff", message: "Back-off restarting failed container app", count: 14, namespace: "default", object: { kind: "Pod", namespace: "default", name: "worker-2ab1" }, objectLabel: "Pod/worker-2ab1" },
    ]),
    checkAccess: vi.fn(async (): Promise<AccessMap> => ({ delete: true, patch: true, exec: true })),
    describeContext: vi.fn(async (id: string): Promise<ContextDetails> => ({
      id,
      file: "/home/dev/.kube/config",
      current: id === "prod",
      cluster: `${id}-cluster`,
      user: `${id}-admin`,
      server: `https://${id}.example:6443`,
      namespace: id === "prod" ? "default" : null,
      auth: "Client certificate",
      certExpires: "2026-08-14T06:53:25.000Z",
      skipTLSVerify: false,
      ca: "Embedded",
      sharedWith: ["prod-readonly"],
      yaml: "users:\n  - name: prod-admin\n    user:\n      client-key-data: <hidden>\n",
    })),
    updateContext: vi.fn(async (id: string, change: ContextEdit): Promise<ContextSaved> => ({ name: change.name ?? id, file: "/home/dev/.kube/config", backup: "/home/dev/.kube/config.podgaze-1.bak" })),
    removeContext: vi.fn(async (id: string) => ({ file: "/home/dev/.kube/config", backup: "/home/dev/.kube/config.podgaze-2.bak", removed: [`context ${id}`] })),
    getGuards: vi.fn(async () => ({ prod: { protected: true, readOnly: false }, staging: { protected: false, readOnly: false } })),
    setGuard: vi.fn(async () => undefined),
    startDebug: vi.fn(async () => ({ container: "debugger-abc12" })),
    listExecTargets: vi.fn(async (): Promise<ExecTarget[]> => []),
    readSecret: vi.fn(async (_namespace: string, _name: string): Promise<SecretReveal> => ({
      type: "Opaque",
      resourceVersion: "7",
      values: [
        { key: "password", value: "s3cret", binary: false, encoded: "czNjcmV0" },
        { key: "old", value: "x", binary: false, encoded: "eA==" },
      ],
    })),
    writeSecret: vi.fn(async (request: SecretWrite): Promise<SecretReveal> => ({ type: "Opaque", resourceVersion: "8", values: request.set.map((change) => ({ key: change.key, value: change.value, binary: false, encoded: "" })) })),
    openPortForward: vi.fn(async (request: { namespace: string; pod: string; remotePort: number; localPort?: number }) => ({
      id: "pf1",
      kind: "Pod" as const,
      namespace: request.namespace,
      pod: request.pod,
      remotePort: request.remotePort,
      localPort: request.localPort ?? 18080,
    })),
    closePortForward: vi.fn(async () => undefined),
    listPortForwards: vi.fn(async () => []),
    readUsage: vi.fn(async () => ({
      available: true,
      nodes: [{ name: "ip-10-0-4", namespace: "", cpuMillicores: 800, memoryBytes: 2 * 1024 ** 3 }],
      pods: [{ name: "api-7d9c", namespace: "default", cpuMillicores: 84, memoryBytes: 210 * 1024 ** 2 }],
    })),
    followLogs: vi.fn(async (_request: LogFollowRequest) => ({ id: "log-1" })),
    stopFollow: vi.fn(async () => undefined),
    onLogs(_listener: (event: LogEvent) => void) {
      return () => undefined;
    },
    openTerminal: vi.fn(async () => ({ id: "term" })),
    writeTerminal: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    closeTerminal: vi.fn(async () => undefined),
    onTerminal() {
      return () => undefined;
    },
    onSession(listener: (session: Session) => void) {
      onSession = listener;
      listener(disconnected);
      return () => undefined;
    },
    subscribeRows(listener: (batch: RowBatch) => void) {
      onRows = listener;
      return () => undefined;
    },
    createYaml: vi.fn(async (request: CreateRequest): Promise<CreateResult> => ({
      created: [{ kind: "ConfigMap", namespace: request.namespace ?? "default", name: "settings" }],
      dryRun: Boolean(request.dryRun),
      message: request.dryRun ? "The API server accepts ConfigMap/settings. Nothing is created yet." : "Created ConfigMap/settings.",
    })),
    listHelmReleases: vi.fn(async (): Promise<HelmRelease[]> => [
      { name: "shop-api", namespace: "default", revision: 3, status: "deployed", chart: "shop-api", chartVersion: "0.3.0", appVersion: "1.8.2", updated: "2026-10-14T16:40:00.000Z", description: "Upgrade complete" },
    ]),
    getHelmRelease: vi.fn(async (namespace: string, name: string): Promise<HelmReleaseDetail> => ({
      name, namespace, revision: 3, status: "deployed", chart: "shop-api", chartVersion: "0.3.0", appVersion: "1.8.2", updated: "2026-10-14T16:40:00.000Z", description: "Upgrade complete",
      values: "replicaCount: 3\n", manifest: "kind: Deployment\n", notes: "Thanks",
      history: [
        { revision: 3, status: "deployed", updated: "2026-10-14T16:40:00.000Z", chartVersion: "0.3.0", appVersion: "1.8.2", description: "Upgrade complete" },
        { revision: 2, status: "superseded", updated: "2026-10-10T16:40:00.000Z", chartVersion: "0.2.0", appVersion: "1.8.1", description: "Upgrade complete" },
      ],
    })),
    helmAction: vi.fn(async (request: HelmActionRequest) => ({ title: request.action, command: `helm rollback ${request.name} ${request.revision ?? ""} -n ${request.namespace}`.replace("  ", " "), output: "Rollback was a success!" })),
    listAudit: vi.fn(async (): Promise<AuditEntry[]> => [
      { id: "1", time: "2026-10-15T10:00:00.000Z", cluster: "prod", namespace: "default", action: "rollout-restart", target: "deployment/api", kubectl: "kubectl rollout restart deployment/api -n default", ok: true },
      { id: "2", time: "2026-10-15T09:00:00.000Z", cluster: "staging", namespace: "shop", action: "delete", target: "pod/batch", kubectl: "kubectl delete pod batch -n shop", ok: false, error: "forbidden" },
    ]),
    whoCan: vi.fn(async (): Promise<WhoCanSubject[]> => [
      { kind: "Group", name: "system:masters", binding: "ClusterRoleBinding/cluster-admin", role: "ClusterRole/cluster-admin", scope: "cluster" },
    ]),
    myRules: vi.fn(async (): Promise<AccessRule[]> => [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods"], resourceNames: [] }]),
    closeCluster: vi.fn(async () => undefined),
    helmRepos: vi.fn(async () => [{ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }]),
    helmAddRepo: vi.fn(async () => undefined),
    helmSearch: vi.fn(async (term: string) => [
      { name: "bitnami/redis", version: "19.6.1", appVersion: "7.2.5", description: "Redis" },
      { name: "bitnami/shop-api", version: "0.4.0", appVersion: "1.9.0", description: "Shop API" },
    ].filter((chart) => chart.name.includes(term.replace(/\/$/, "")))),
    helmChartValues: vi.fn(async () => "architecture: replication\nauth:\n  enabled: true\n"),
    getMap: vi.fn(async (_scope: MapScope): Promise<ResourceMap> => ({
      nodes: [
        { id: "Service/default/api", kind: "Service", name: "api", namespace: "default", status: "Active", group: 0 },
        { id: "Deployment/default/api", kind: "Deployment", name: "api", namespace: "default", status: "Available", group: 0 },
        { id: "Pod/default/worker-2ab1", kind: "Pod", name: "worker-2ab1", namespace: "default", status: "CrashLoopBackOff", group: 1 },
        { id: "ReplicaSet/default/api-7d9", kind: "ReplicaSet", name: "api-7d9", namespace: "default", status: "Available", group: 0 },
        { id: "Pod/default/api-7d9-x", kind: "Pod", name: "api-7d9-x", namespace: "default", status: "Running", group: 0 },
      ],
      edges: [
        { from: "Service/default/api", to: "Deployment/default/api", relation: "routes to" },
        { from: "Deployment/default/api", to: "ReplicaSet/default/api-7d9", relation: "owns" },
        { from: "ReplicaSet/default/api-7d9", to: "Pod/default/api-7d9-x", relation: "owns" },
      ],
      truncated: false,
    })),
    listArgoApps: vi.fn(async (): Promise<ArgoApp[]> => [{
      name: "shop", namespace: "argocd", project: "default", sync: "OutOfSync", health: "Degraded", healthMessage: "", repo: "https://git/deploy.git", path: "apps/shop", chart: "",
      targetRevision: "main", revision: "abc1234567", destServer: "https://kubernetes.default.svc", destNamespace: "default", autoSync: false,
      operation: { phase: "Failed", message: "sync failed", startedAt: "", finishedAt: "" }, conditions: [], reconciledAt: "",
      resources: [{ kind: "Deployment", group: "apps", name: "api", namespace: "default", sync: "OutOfSync", health: "Degraded", message: "" }],
      history: [
        { id: 4, revision: "abc1234567", deployedAt: "2026-10-15T10:00:00.000Z", source: "apps/shop" },
        { id: 3, revision: "0ld9876543", deployedAt: "2026-10-14T10:00:00.000Z", source: "apps/shop" },
      ],
    }]),
    argoAction: vi.fn(async (request: { name: string; action: string }) => ({ title: request.action, command: `argocd app sync ${request.name}`, output: "Sync requested." })),
    hubSearch: vi.fn(async (): Promise<HubChart[]> => [{ name: "redis", version: "20.1.0", appVersion: "7.4.0", description: "Redis", stars: 300, repo: { name: "bitnami", url: "https://charts.bitnami.com/bitnami", official: false, verified: true } }]),
    startNodeShell: vi.fn(async (node: string) => ({ namespace: "kube-system", pod: `podgaze-node-shell-${node}`, container: "shell", command: ["nsenter", "-t", "1", "--", "sh"] })),
    stopNodeShell: vi.fn(async () => undefined),
    findWorkloads: vi.fn(async (clusterId: string, needle: string): Promise<ResourceRow[]> => [
      { uid: `${clusterId}-dev`, kind: "Deployment", name: `${needle}-development`, namespace: "development", status: "Ready", ageStart: "", columns: {}, labels: {} },
      { uid: `${clusterId}-prod`, kind: "Deployment", name: `${needle}-production`, namespace: "production", status: "Ready", ageStart: "", columns: {}, labels: {} },
    ]),
    getYamlIn: vi.fn(async (_clusterId: string, ref: ResourceRef) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${ref.name}
spec:
  replicas: ${ref.namespace === "production" ? 3 : 1}
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: app
          image: acr.io/api:${ref.namespace === "production" ? "1.4.0" : "1.5.0"}
          env:
            - name: LOG_LEVEL
              value: ${ref.namespace === "production" ? "info" : "debug"}
            - name: REGION
              value: westeurope
`),
    listImagesIn: vi.fn(async (clusterId: string): Promise<WorkloadImages[]> => [
      { kind: "Deployment", namespace: "development", name: "api", containers: [{ name: "app", image: "acr.io/api:1.5.0" }] },
      { kind: "Deployment", namespace: "production", name: "api", containers: [{ name: "app", image: `acr.io/api:${clusterId === "prod" ? "1.4.0" : "1.5.0"}` }] },
      { kind: "Deployment", namespace: "production", name: "web", containers: [{ name: "web", image: "acr.io/web:2.0.0" }] },
    ]),
    lookupPrices: vi.fn(async (requests: PriceRequest[]): Promise<PriceQuote[]> => requests.map((request) => ({ ...request, hourly: request.instanceType.startsWith("Standard_") ? 0.2 : null, note: "" }))),
    listVolumes: vi.fn(async (): Promise<VolumeReport> => ({
      volumes: [
        { namespace: "default", name: "data-api-0", storageClass: "managed-csi-premium", sizeBytes: 128 * 1024 ** 3, phase: "Bound", usedBy: ["api-7d9c"] },
        { namespace: "default", name: "orphaned-backup", storageClass: "managed-csi-premium", sizeBytes: 64 * 1024 ** 3, phase: "Bound", usedBy: [] },
      ],
      classes: [{ name: "managed-csi-premium", provisioner: "disk.csi.azure.com", sku: "Premium_LRS", isDefault: false }],
    })),
    updateState: vi.fn(async (): Promise<UpdateState> => ({ status: "idle", current: "0.1.1", canInstall: true, automatic: true })),
    checkForUpdates: vi.fn(async (): Promise<UpdateState> => ({ status: "none", current: "0.1.1", canInstall: true, automatic: true })),
    installUpdate: vi.fn(async () => undefined),
    setAutomaticUpdates: vi.fn(async (enabled: boolean): Promise<UpdateState> => ({ status: "idle", current: "0.1.1", canInstall: true, automatic: enabled })),
    onUpdate(listener: (state: UpdateState) => void) {
      onUpdate = listener;
      return () => undefined;
    },
    searchLogs: vi.fn(async (request: LogSearchRequest): Promise<LogSearchResult> => ({
      matches: [
        { pod: "api-1", container: "api", time: "2026-10-16T10:00:01.000Z", line: "ERROR timeout calling payments", ranges: [[6, 13]] },
        { pod: "api-2", container: "api", time: "2026-10-16T10:00:02.000Z", line: `retry after ${request.pattern}`, ranges: [[12, 12 + request.pattern.length]] },
      ],
      pods: 2, containers: 2, lines: 840, truncated: false, problems: [],
    })),
    getTimeline: vi.fn(async (): Promise<Timeline> => ({
      entries: [
        { time: "2026-10-16T10:05:00Z", category: "oom", title: "api was OOM-killed", detail: "Used more memory than its limit", object: "Pod api-1" },
        { time: "2026-10-16T10:00:00Z", category: "deploy", title: "Rolled out revision 2", detail: "api 1.4.0 → 1.5.0", object: "ReplicaSet api-2" },
        { time: "2026-10-16T09:00:00Z", category: "info", title: "Something routine", detail: "", object: "Deployment api" },
      ],
      eventsSince: "2026-10-16T09:00:00Z",
    })),
    listCertificates: vi.fn(async (): Promise<CertInfo[]> => [
      { source: "Certificate", namespace: "shop", name: "shop-tls", secretName: "shop-tls", certificateName: "shop-tls", subject: "shop.example.com", dnsNames: ["shop.example.com"], issuer: "ClusterIssuer/letsencrypt", notAfter: new Date(Date.now() + 5 * 86_400_000).toISOString(), renewalTime: "", ready: "True", problem: "" },
      { source: "Secret", namespace: "legacy", name: "old-cert", secretName: "old-cert", certificateName: "", subject: "old.example.com", dnsNames: ["old.example.com"], issuer: "DigiCert", notAfter: new Date(Date.now() + 200 * 86_400_000).toISOString(), renewalTime: "", ready: "", problem: "" },
    ]),
    onAlert(listener: (alert: ClusterAlert) => void) {
      onAlert = listener;
      return () => undefined;
    },
    onAlertOpen() {
      return () => undefined;
    },
    setNotifications: vi.fn(async () => undefined),
    cloudAccounts: vi.fn(async (provider: CloudProvider): Promise<CloudAccount[]> => (provider === "aws"
      ? [{ id: "default", name: "default", isDefault: true }, { id: "team-a", name: "team-a", isDefault: false }]
      : [{ id: "sub-1", name: "Demo Dev", isDefault: true }])),
    cloudDefaultRegion: vi.fn(async () => "eu-west-1"),
    cloudClusters: vi.fn(async (provider: CloudProvider, accountId: string, region?: string): Promise<CloudCluster[]> => (provider === "aws"
      ? [{ provider, name: "shop", group: region ?? "", location: region ?? "", version: "", state: "", note: "", accountId }]
      : [{ provider, name: "aks-demo-dev", group: "rg-dev", location: "westeurope", version: "1.30.3", state: "Running", note: "Entra ID", accountId }])),
    cloudAddCluster: vi.fn(async (request: CloudAddRequest) => ({ context: request.name, message: "Merged into /home/dev/.kube/config" })),
    helmInstall: vi.fn(async (request: HelmInstallRequest) => ({ title: request.dryRun ? "Dry run" : "Install", command: `helm install ${request.release} ${request.chart} -n ${request.namespace}`, output: request.dryRun ? "kind: StatefulSet" : "STATUS: deployed" })),
  } satisfies ClusterClient;
  return {
    client,
    emitSession: (session: Session) => onSession(session),
    emitRows: (batch: RowBatch) => onRows(batch),
    emitAlert: (alert: ClusterAlert) => onAlert(alert),
    emitUpdate: (state: UpdateState) => onUpdate(state),
  };
}

function live(extra: Partial<Session> = {}): Session {
  return {
    state: "connected",
    clusterId: "prod",
    namespace: null,
    kubeconfigPath: disconnected.kubeconfigPath,
    problem: null,
    namespaces: ["default", "kube-system"],
    guard: { protected: false, readOnly: false },
    forbidden: {},
    ...extra,
  };
}

async function connectAndLoad(api: ReturnType<typeof createClient>, extra: Partial<Session> = {}) {
  fireEvent.click(await screen.findByRole("button", { name: "Connect prod" }));
  act(() => api.emitSession(live(extra)));
  api.emitRows({
    pods: {
      reset: true,
      upsert: [pod("api-7d9c"), pod("worker-2ab1"), pod("cache-11f0", "kube-system")],
      delete: [],
    },
  });
  await screen.findByText("api-7d9c");
}

function clickRow(name: string) {
  const label = screen.getByText(name);
  const row = label.closest("button");
  if (!row) throw new Error(`No row for ${name}`);
  fireEvent.click(row);
}

afterEach(() => {
  clearUsageHistory();
  resetSettings();
  setZoom(1);
  document.documentElement.dataset.theme = "dark";
  localStorage.clear();
  cleanup();
});

describe("App", () => {
  it("searches clusters and builds a group from its settings", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search clusters" }), { target: { value: "staging" } });
    expect(screen.queryByRole("button", { name: "Connect prod" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect staging" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search clusters" }), { target: { value: "" } });
    // No per-card group picker any more.
    expect(screen.queryByRole("combobox", { name: /^Group / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    const settings = screen.getByRole("dialog", { name: "Group New group" });
    const name = within(settings).getByRole("textbox", { name: "Group name" });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Europe" } });
    fireEvent.change(within(settings).getByRole("searchbox", { name: "Find clusters to add" }), { target: { value: "pro" } });
    expect(within(settings).queryByRole("button", { name: /Add staging/ })).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "Add prod to Europe" }));
    expect(within(settings).getByRole("button", { name: "Remove prod from Europe" })).toBeTruthy();
    fireEvent.click(within(settings).getByRole("button", { name: "Close group settings" }));
    const europe = screen.getByRole("region", { name: "Europe" });
    expect(europe.textContent).toContain("prod");
    expect(screen.getByRole("region", { name: "Ungrouped" }).textContent).not.toContain("prod");

    fireEvent.click(within(europe).getByRole("button", { name: "Settings for group Europe" }));
    const again = screen.getByRole("dialog", { name: "Group Europe" });
    fireEvent.click(within(again).getByRole("button", { name: "Remove prod from Europe" }));
    fireEvent.click(within(again).getByRole("button", { name: "Delete group" }));
    expect(screen.getByRole("region", { name: "Europe" })).toBeTruthy();
    fireEvent.click(within(again).getByRole("button", { name: "Click again to delete" }));
    expect(screen.queryByRole("region", { name: "Europe" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect prod" })).toBeTruthy();
  });

  it("drags a cluster into a group, and onto the new-group zone", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), { target: { value: "Europe" } });
    fireEvent.click(screen.getByRole("button", { name: "Close group settings" }));
    const card = screen.getByRole("heading", { name: "prod" }).closest("li")!;
    const transfer = { data: "", setData(_type: string, value: string) { this.data = value; }, getData() { return this.data; }, effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card, { dataTransfer: transfer });
    const europe = screen.getByRole("region", { name: "Europe" });
    const title = europe.querySelector("h2")!;
    fireEvent.dragEnter(europe, { dataTransfer: transfer });
    // Crossing onto a child fires enter on the child, then leave on the zone; the highlight must stay.
    fireEvent.dragEnter(title, { dataTransfer: transfer });
    fireEvent.dragLeave(europe, { dataTransfer: transfer });
    fireEvent.dragOver(title, { dataTransfer: transfer });
    expect(europe.className).toContain(" drop");
    fireEvent.drop(europe, { dataTransfer: transfer });
    expect(screen.getByRole("region", { name: "Europe" }).textContent).toContain("prod");

    const staging = screen.getByRole("heading", { name: "staging" }).closest("li")!;
    fireEvent.dragStart(staging, { dataTransfer: transfer });
    const fresh = await screen.findByRole("region", { name: "Start a new group" });
    fireEvent.dragOver(fresh, { dataTransfer: transfer });
    fireEvent.drop(fresh, { dataTransfer: transfer });
    const settings = screen.getByRole("dialog", { name: "Group New group" });
    expect(within(settings).getByRole("button", { name: "Remove staging from New group" })).toBeTruthy();
  });

  it("shows sidebar counts before a kind is opened", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("button", { name: /Config Maps\s*4/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Secrets\s*2/ })).toBeTruthy();
  });

  it("switches between dark and light", () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(screen.getByRole("switch", { name: "Switch to light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("switch", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("zooms the interface from the keyboard", () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("1.1");
    expect(document.documentElement.style.zoom).toBe("");
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("1");
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("1");
  });

  it("copies a pod manifest and forwards a port", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    expect(await screen.findByText(/84m \/ 500m limit/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Port forward" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(api.client.openPortForward).toHaveBeenCalledWith({
      namespace: "default",
      pod: "api-7d9c",
      remotePort: 8080,
      localPort: undefined,
    });
    expect(await screen.findByText("127.0.0.1:18080")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy YAML" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("kind: Pod")));
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Exec pod" })).toBeNull();
  });

  it("shows the newly selected secret's values instead of the previous one's", async () => {
    const api = createClient();
    api.client.readSecret.mockImplementation(async (_namespace: string, name: string) => ({
      type: "Opaque",
      resourceVersion: "1",
      values: [{ key: `${name}-key`, value: `${name}-value`, binary: false, encoded: "" }],
    }));
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(await screen.findByRole("button", { name: /Secrets/ }));
    const secret = (name: string) => ({ uid: name, kind: "Secret", name, namespace: "default", status: "Opaque", ageStart: "", columns: { keys: `${name}-key`, type: "Opaque" }, labels: {} });
    act(() => {
      api.emitRows({ resources: { reset: true, upsert: [secret("first"), secret("second")], delete: [] } });
    });
    clickRow("first");
    fireEvent.click(await screen.findByRole("button", { name: "Decode values" }));
    expect(await screen.findByText("first-value")).toBeTruthy();

    clickRow("second");
    await waitFor(() => expect(api.client.readSecret).toHaveBeenLastCalledWith("default", "second"));
    expect(await screen.findByText("second-value")).toBeTruthy();
    expect(screen.queryByText("first-value")).toBeNull();

    // Never decoded on its own on a Protected cluster.
    act(() => api.emitSession(live({ guard: { protected: true, readOnly: false } })));
    const before = api.client.readSecret.mock.calls.length;
    clickRow("first");
    expect(await screen.findByRole("button", { name: "Decode values" })).toBeTruthy();
    expect(api.client.readSecret.mock.calls.length).toBe(before);
    act(() => api.emitSession(live({ guard: { protected: false, readOnly: false } })));
    clickRow("second");
    expect(await screen.findByText("second-value")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Hide values/ }));
    expect(screen.queryByText("second-value")).toBeNull();
    const calls = api.client.readSecret.mock.calls.length;
    clickRow("first");
    expect(await screen.findByRole("button", { name: "Decode values" })).toBeTruthy();
    expect(api.client.readSecret.mock.calls.length).toBe(calls);
  });

  it("decodes a secret when asked", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(await screen.findByRole("button", { name: /Secrets\s*2/ }));
    act(() => {
      api.emitRows({
        resources: {
          reset: true,
          upsert: [{
            uid: "sec",
            kind: "Secret",
            name: "db",
            namespace: "default",
            status: "Opaque",
            ageStart: "2026-01-01T00:00:00.000Z",
            columns: { keys: "password", type: "Opaque" },
            labels: {},
          }],
          delete: [],
        },
      });
    });
    expect(await screen.findByText("db")).toBeTruthy();
    clickRow("db");
    fireEvent.click(screen.getByRole("button", { name: "Decode values" }));
    expect(api.client.readSecret).toHaveBeenCalledWith("default", "db");
    expect(await screen.findByText("s3cret")).toBeTruthy();

    // Edit: change a value as text, add a key, remove one. Podgaze sends text and does the encoding server side.
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const editor = screen.getByLabelText("Edit secret");
    const value = within(editor).getByRole("textbox", { name: "Value of password" }) as HTMLTextAreaElement;
    expect(value.className).toContain("masked");
    fireEvent.change(value, { target: { value: "pässwörd" } });
    expect(within(editor).getByText(btoa(unescape(encodeURIComponent("pässwörd"))))).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "Remove old" }));
    fireEvent.click(within(editor).getByRole("button", { name: /Add key/ }));
    const keys = within(editor).getAllByRole("textbox", { name: "Secret key" });
    fireEvent.change(keys[keys.length - 1]!, { target: { value: "bad key" } });
    expect(within(editor).getByText(/may only use letters/)).toBeTruthy();
    fireEvent.change(keys[keys.length - 1]!, { target: { value: "API_TOKEN" } });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Value of API_TOKEN" }), { target: { value: "abc" } });
    expect(within(editor).getByText("1 changed · 1 added · 1 removed")).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: /Save secret/ }));
    await waitFor(() => expect(api.client.writeSecret).toHaveBeenCalledWith({
      namespace: "default",
      name: "db",
      resourceVersion: "7",
      set: [{ key: "password", value: "pässwörd", encoding: "text" }, { key: "API_TOKEN", value: "abc", encoding: "text" }],
      remove: ["old"],
    }));
    expect(await screen.findByText(/Pods that read this Secret as environment variables/)).toBeTruthy();
  });

  it("encodes and decodes base64 locally", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "Command" }), { target: { value: "base64" } });
    fireEvent.click(screen.getByRole("button", { name: /Base64 encode/ }));
    const tool = screen.getByRole("region", { name: "Base64 tool" });
    fireEvent.change(within(tool).getByRole("textbox", { name: "Text to encode" }), { target: { value: "hunter2" } });
    expect(within(tool).getByLabelText("Base64 result").textContent).toBe("aHVudGVyMg==");
    fireEvent.click(within(tool).getByRole("button", { name: "Decode" }));
    fireEvent.change(within(tool).getByRole("textbox", { name: "Base64 to decode" }), { target: { value: "w6TDtsO8" } });
    expect(within(tool).getByLabelText("Base64 result").textContent).toBe("äöü");
    fireEvent.change(within(tool).getByRole("textbox", { name: "Base64 to decode" }), { target: { value: "not base64!" } });
    expect(within(tool).getByText("Not valid base64.")).toBeTruthy();
  });

  it("refuses to edit a secret on a read-only cluster", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { guard: { protected: false, readOnly: true } });
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    fireEvent.click(await screen.findByRole("button", { name: /Secrets\s*2/ }));
    act(() => {
      api.emitRows({ resources: { reset: true, delete: [], upsert: [{ uid: "sec", kind: "Secret", name: "db", namespace: "default", status: "Opaque", ageStart: "", columns: {}, labels: {} }] } });
    });
    clickRow(await screen.findByText("db").then(() => "db"));
    fireEvent.click(screen.getByRole("button", { name: "Decode values" }));
    await screen.findByText("s3cret");
    expect((screen.getByRole("button", { name: /Edit/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Podgaze does not change secrets here/)).toBeTruthy();
  });

  it("renders contexts and disables connect when a context is unusable", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    expect(await screen.findByRole("heading", { name: "prod" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect prod" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Connect bad" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("connects, keeps the table while the inspector is open, and filters by name", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    expect(api.client.connect).toHaveBeenCalledWith("prod");
    clickRow("api-7d9c");
    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    expect(screen.getAllByText("api-7d9c").length).toBeGreaterThan(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter by name" }), { target: { value: "cache" } });
    expect(document.querySelector('.table-row[aria-label="api-7d9c"]')).toBeNull();
    expect(document.querySelector('.table-row[aria-label="cache-11f0"]')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
  });

  it("changes namespace and loads YAML for the selected pod", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Choose namespace" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Namespace" })).getByRole("option", { name: "kube-system" }));
    expect(api.client.setNamespace).toHaveBeenCalledWith("kube-system");
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect(api.client.getYaml).toHaveBeenCalledWith({ kind: "Pod", namespace: "default", name: "api-7d9c" });
    const manifest = await screen.findByRole("textbox", { name: "Manifest" });
    await waitFor(() => expect(manifest.textContent).toMatch(/kind:\s*Pod/));
  });

  it("keeps rows visible while reconnecting", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => api.emitSession(live({ state: "reconnecting" })));
    expect(await screen.findByText(/Reconnecting/)).toBeTruthy();
    expect(screen.getByText("api-7d9c")).toBeTruthy();
  });

  it("opens details on click, minimizes on request, and reopens on the next pick", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    expect(screen.queryByRole("button", { name: "Close panel" })).toBeNull();
    clickRow("api-7d9c");
    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "api-7d9c" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Local shell" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Minimize panel" }));
    expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();
    // The bar stays, so the selection is still visible while minimized.
    expect(screen.getByRole("heading", { name: "api-7d9c" })).toBeTruthy();
    clickRow("worker-2ab1");
    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "worker-2ab1" })).toBeNull();
  });

  it("keeps the local shell out of the dock until it is opened", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("button", { name: "Local shell" }));
    expect(screen.getByRole("tab", { name: "Local shell" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close local shell" }));
    expect(screen.queryByRole("tab", { name: "Local shell" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
  });

  it("goes home without disconnecting, and comes back through the open cluster", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { open: [{ id: "prod", state: "connected" }] });
    expect(screen.queryByRole("button", { name: "Choose cluster" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(api.client.disconnect).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Clusters" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open prod" }));
    expect(api.client.connect).toHaveBeenLastCalledWith("prod");
    expect(await screen.findByText("api-7d9c")).toBeTruthy();
  });

  it("switches and closes cluster tabs", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { open: [{ id: "prod", state: "connected" }, { id: "staging", state: "connected" }] });
    const tabs = screen.getByRole("tablist", { name: "Open clusters" });
    expect(within(tabs).getByRole("tab", { name: /prod/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(tabs).getByRole("tab", { name: /staging/ }));
    expect(api.client.connect).toHaveBeenLastCalledWith("staging");
    fireEvent.click(within(tabs).getByRole("button", { name: "Close staging" }));
    expect(api.client.closeCluster).toHaveBeenCalledWith("staging");
  });

  it("filters by label and shows a labels column on request", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter by name" }), { target: { value: "tier=cache" } });
    expect(screen.queryByText("api-7d9c")).toBeNull();
    expect(screen.getByText("cache-11f0")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter by name" }), { target: { value: "app in (api,worker)" } });
    expect(screen.getByText("api-7d9c")).toBeTruthy();
    expect(screen.queryByText("cache-11f0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Columns" })).getByRole("checkbox", { name: "Labels" }));
    expect(screen.getByText("app=api, tier=web")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("podgaze.columns.shown.Pod") ?? "{}")).toEqual({ labels: true });
  });

  it("deletes several checked rows after one confirmation", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select api-7d9c" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select worker-2ab1" }));
    const bar = screen.getByRole("region", { name: "Selected rows" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Delete 2 now" }));
    await waitFor(() => expect(api.client.runCommand).toHaveBeenCalledTimes(2));
    expect(api.client.runCommand).toHaveBeenCalledWith({ name: "delete", kind: "Pod", resourceName: "worker-2ab1", namespace: "default" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull());
  });

  it("asks for the count before a bulk delete on a protected cluster", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { guard: { protected: true, readOnly: false } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    const bar = screen.getByRole("region", { name: "Selected rows" });
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    const go = within(bar).getByRole("button", { name: "Delete 3 now" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(bar).getByRole("textbox", { name: "Confirm count" }), { target: { value: "3" } });
    expect(go.disabled).toBe(false);
  });

  it("pins an object to the sidebar and opens it from there", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("worker-2ab1");
    fireEvent.click(screen.getByRole("button", { name: "Pin to sidebar" }));
    expect(screen.getByRole("button", { name: "Unpin" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    const rail = screen.getByRole("navigation", { name: "Resources" });
    fireEvent.click(within(rail).getByRole("button", { name: /worker-2ab1/ }));
    expect(await screen.findByRole("heading", { name: "worker-2ab1" })).toBeTruthy();
  });

  it("lists custom resources from the cluster's CRDs", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, {
      customKinds: [{
        kind: "certificates.cert-manager.io", group: "Custom", label: "Certificate", namespaced: true, apiVersion: "cert-manager.io/v1", plural: "certificates",
        apiKind: "Certificate", apiGroup: "cert-manager.io", commands: ["describe", "events", "delete"], columns: [{ key: "ready", header: "Ready", width: "0.5fr" }],
      }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Custom resources" }));
    fireEvent.click(screen.getByRole("button", { name: "Certificate" }));
    await waitFor(() => expect(api.client.setFocus).toHaveBeenCalledWith("certificates.cert-manager.io"));
    act(() => api.emitRows({ resources: { reset: true, delete: [], upsert: [{ uid: "c1", kind: "certificates.cert-manager.io", name: "shop-tls", namespace: "default", status: "Ready", ageStart: "", columns: { ready: "True" }, labels: {} }] } }));
    expect(await screen.findByText("shop-tls")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Certificate" })).toBeTruthy();
    expect(screen.getByText("True")).toBeTruthy();
  });

  it("creates objects from YAML after a dry run", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    const dialog = screen.getByRole("dialog", { name: "Create from YAML" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "ConfigMap" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Check \(dry run\)/ }));
    await waitFor(() => expect(api.client.createYaml).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, namespace: "default" })));
    expect(await within(dialog).findByText(/Nothing is created yet/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/ }));
    await waitFor(() => expect(api.client.createYaml).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create from YAML" })).toBeNull());
    expect(api.client.setFocus).toHaveBeenCalledWith("ConfigMap");
  });

  it("shows Helm releases and rolls one back", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Helm releases" }));
    fireEvent.click(await screen.findByRole("row", { name: "shop-api" }));
    const panel = await screen.findByRole("region", { name: "Release shop-api" });
    fireEvent.click(await within(panel).findByRole("button", { name: /Roll back here/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Roll back to revision 2 now" }));
    await waitFor(() => expect(api.client.helmAction).toHaveBeenCalledWith({ name: "shop-api", namespace: "default", action: "rollback", revision: 2 }));
    expect(await within(panel).findByText("Rollback was a success!")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("tab", { name: "Values" }));
    expect(within(panel).getByLabelText("Values").textContent).toContain("replicaCount: 3");
  });

  it("installs a chart from a repository with edited values", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Helm releases" }));
    fireEvent.click(await screen.findByRole("button", { name: /Install chart/ }));
    const dialog = screen.getByRole("dialog", { name: "Install a Helm chart" });
    expect(await within(dialog).findByRole("button", { name: "bitnami" })).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Find a chart" }), { target: { value: "redis" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /bitnami\/redis/ }, { timeout: 2000 }));
    await waitFor(() => expect(api.client.helmChartValues).toHaveBeenCalledWith("bitnami/redis", "19.6.1"));
    expect((within(dialog).getByRole("textbox", { name: "Release name" }) as HTMLInputElement).value).toBe("redis");
    fireEvent.click(within(dialog).getByRole("button", { name: /Dry run/ }));
    expect(await within(dialog).findByText("kind: StatefulSet")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Install$/ }));
    await waitFor(() => expect(api.client.helmInstall).toHaveBeenLastCalledWith(expect.objectContaining({
      release: "redis", namespace: "default", chart: "bitnami/redis", version: "19.6.1", dryRun: false, upgrade: false,
      values: "architecture: replication\nauth:\n  enabled: true\n",
    })));
  });

  it("upgrades a release with its current values", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Helm releases" }));
    fireEvent.click(await screen.findByRole("row", { name: "shop-api" }));
    const panel = await screen.findByRole("region", { name: "Release shop-api" });
    await within(panel).findByRole("button", { name: /Roll back here/ });
    const detail = await api.client.getHelmRelease("default", "shop-api");
    api.client.getHelmRelease.mockResolvedValue({ ...detail, manifest: "---\n# Source: shop-api/templates/d.yaml\nkind: Deployment\nmetadata:\n  name: shop-api\nspec:\n  replicas: 3\n" });
    fireEvent.click(within(panel).getByRole("button", { name: /Upgrade \/ edit values/ }));
    const dialog = screen.getByRole("dialog", { name: "Upgrade shop-api" });
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "Chart" }) as HTMLInputElement).value).toBe("bitnami/shop-api"));
    api.client.helmInstall.mockImplementation(async (request: HelmInstallRequest) => ({
      title: request.dryRun ? "Dry run" : "Upgrade",
      command: `helm upgrade ${request.release} ${request.chart} -n ${request.namespace}`,
      output: request.dryRun ? "NAME: shop-api\nMANIFEST:\n---\n# Source: shop-api/templates/d.yaml\nkind: Deployment\nmetadata:\n  name: shop-api\nspec:\n  replicas: 4\n" : "STATUS: deployed",
    }));
    const upgradeButton = within(dialog).getByRole("button", { name: /^Upgrade$/ }) as HTMLButtonElement;
    expect(upgradeButton.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /Dry run/ }));
    const changes = await within(dialog).findByRole("region", { name: "What the upgrade changes" });
    expect(within(changes).getByText("1 changed")).toBeTruthy();
    const diff = within(changes).getByLabelText("Diff of Deployment shop-api");
    expect(diff.textContent).toContain("-   replicas: 3");
    expect(diff.textContent).toContain("+   replicas: 4");
    await waitFor(() => expect(upgradeButton.disabled).toBe(false));
    fireEvent.click(upgradeButton);
    await waitFor(() => expect(api.client.helmInstall).toHaveBeenLastCalledWith(expect.objectContaining({ release: "shop-api", upgrade: true, dryRun: false, values: "replicaCount: 3\n", chart: "bitnami/shop-api" })));
  });

  it("draws the map for the namespace and opens an object from it", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { namespace: "default" });
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await waitFor(() => expect(api.client.getMap).toHaveBeenCalledWith({ namespaces: ["default"] }));
    const map = await screen.findByRole("group", { name: "Resource map" });
    expect(within(map).getByRole("button", { name: "Deployment api" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find on map" }), { target: { value: "worker" } });
    expect(within(map).getByRole("button", { name: "Service api" }).getAttribute("class")).toContain("dim");
    // A press without movement must not capture the pointer, or the click lands on the canvas instead of the object.
    const capture = vi.fn();
    Object.defineProperty(map, "setPointerCapture", { value: capture, configurable: true });
    const podNode = within(map).getByRole("button", { name: "Pod worker-2ab1" });
    fireEvent.pointerDown(podNode, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(podNode, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.click(podNode);
    expect(await screen.findByRole("heading", { name: "worker-2ab1" })).toBeTruthy();
  });

  it("shows one team's health, cost, traffic, and expiring items on one page", async () => {
    localStorage.setItem("podgaze.projects", JSON.stringify({ prod: [{ id: "p1", name: "Checkout team", namespaces: ["default", "shop"], labels: "" }] }));
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({ deployments: { reset: true, delete: [], upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "0/2", updated: "2", available: "0", ageStart: "", images: ["api:1"], labels: {}, paused: false }] } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Namespace page" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose namespace or project" }));
    fireEvent.click(screen.getByRole("option", { name: /Checkout team/ }));
    expect(api.client.setNamespace).toHaveBeenLastCalledWith(null);
    const attention = screen.getByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText("0/2")).toBeTruthy();
    expect(screen.getByText("1 deployment down")).toBeTruthy();
    const warnings = screen.getByRole("region", { name: "Recent warnings" });
    expect(await within(warnings).findByText("BackOff ×14")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Traffic" })).toBeNull();
    const expiring = screen.getByRole("region", { name: "Expiring" });
    expect(await within(expiring).findByText("shop-tls")).toBeTruthy();
    expect(within(expiring).queryByText("old-cert")).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "Cost" })).getByRole("button", { name: /Set prices|All costs/ }));
    expect(await screen.findByRole("region", { name: "Node prices" })).toBeTruthy();
  });

  it("saves a project and shows its health", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: /New project/ }));
    const dialog = screen.getByRole("dialog", { name: "Project" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), { target: { value: "Shop" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "default" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project labels" }), { target: { value: "team" } });
    expect(within(dialog).getByText(/key=value/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project labels" }), { target: { value: "team=shop" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save project" }));
    expect(await screen.findByRole("heading", { name: "Shop" })).toBeTruthy();
    await waitFor(() => expect(api.client.getMap).toHaveBeenCalledWith({ namespaces: ["default"], labelSelector: "team=shop" }));
    expect(await screen.findByText("need attention")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /All projects/ }));
    expect(await screen.findByRole("button", { name: "Open project Shop" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("podgaze.projects") ?? "{}").prod[0]).toMatchObject({ name: "Shop", namespaces: ["default"], labels: "team=shop" });
  });

  it("syncs an Argo CD application after confirming", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, {
      customKinds: [{ kind: "applications.argoproj.io", group: "Custom", label: "Application", namespaced: true, apiVersion: "argoproj.io/v1alpha1", plural: "applications", apiKind: "Application", apiGroup: "argoproj.io", commands: [], columns: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Argo CD" }));
    fireEvent.click(await screen.findByRole("row", { name: "shop" }));
    const panel = await screen.findByRole("region", { name: "Application shop" });
    expect(within(panel).getByText(/sync failed/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /^Sync$/ }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: /Prune/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(api.client.argoAction).toHaveBeenCalledWith({ name: "shop", namespace: "argocd", action: "sync", prune: true }));
    // Argo lists only the Deployment; its ReplicaSet and Pod are found through ownership.
    expect(await within(panel).findByRole("button", { name: /Pod.*api-7d9-x/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /ReplicaSet.*api-7d9/ })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /^Deployment.*api/ }));
    await waitFor(() => expect(api.client.setFocus).toHaveBeenCalledWith("Deployment"));
  });

  it("installs a chart found on Artifact Hub, adding its repository first", async () => {
    const api = createClient();
    api.client.helmRepos.mockResolvedValue([]);
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Helm releases" }));
    fireEvent.click(await screen.findByRole("button", { name: /Install chart/ }));
    const dialog = screen.getByRole("dialog", { name: "Install a Helm chart" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Artifact Hub" }));
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Find a chart" }), { target: { value: "redis" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /redis/ }, { timeout: 2000 }));
    await waitFor(() => expect(api.client.helmAddRepo).toHaveBeenCalledWith({ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }));
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "Chart" }) as HTMLInputElement).value).toBe("bitnami/redis"));
    expect((within(dialog).getByRole("textbox", { name: "Chart version" }) as HTMLInputElement).value).toBe("20.1.0");
  });

  it("opens a node shell and removes its pod on close", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({ nodes: { reset: true, delete: [], upsert: [{ uid: "n1", name: "ip-10-0-4", status: "Ready", roles: ["worker"], kubeletVersion: "v1.32.1", ageStart: "", internalIP: "10.0.0.4", cpu: "4", memory: "8Gi", podCapacity: "110", os: "Ubuntu", runtime: "containerd", unschedulable: false, labels: {} }] } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    fireEvent.click(screen.getByRole("button", { name: /^Nodes/ }));
    clickRow("ip-10-0-4");
    fireEvent.click(screen.getByRole("tab", { name: "Node shell" }));
    fireEvent.click(screen.getByRole("button", { name: /Open node shell/ }));
    await waitFor(() => expect(api.client.startNodeShell).toHaveBeenCalledWith("ip-10-0-4"));
    fireEvent.click(await screen.findByRole("button", { name: /Close and remove pod/ }));
    await waitFor(() => expect(api.client.stopNodeShell).toHaveBeenCalledWith("kube-system", "podgaze-node-shell-ip-10-0-4"));
  });

  it("searches inside the details panel", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    const related = await screen.findByRole("region", { name: "Related" });
    await within(related).findByRole("button", { name: "Open Deployment api" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search in panel" }), { target: { value: "node" } });
    expect(within(related).queryByRole("button", { name: "Open Deployment api" })).toBeNull();
    expect(within(related).getByRole("button", { name: "Open Node ip-10-0-4" })).toBeTruthy();
    const events = screen.getByRole("region", { name: "Recent events" });
    expect(within(events).getByText("No event matches.")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search in panel" }), { target: { value: "backoff" } });
    expect(within(events).getByText("BackOff")).toBeTruthy();
    clickRow("worker-2ab1");
    expect((await screen.findByRole("searchbox", { name: "Search in panel" }) as HTMLInputElement).value).toBe("");
  });

  it("finds a pod inside an Argo CD application and a word in a Helm manifest", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, {
      customKinds: [{ kind: "applications.argoproj.io", group: "Custom", label: "Application", namespaced: true, apiVersion: "argoproj.io/v1alpha1", plural: "applications", apiKind: "Application", apiGroup: "argoproj.io", commands: [], columns: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Argo CD" }));
    fireEvent.click(await screen.findByRole("row", { name: "shop" }));
    const panel = await screen.findByRole("region", { name: "Application shop" });
    await within(panel).findByRole("button", { name: /Pod.*api-7d9-x/ });
    fireEvent.change(within(panel).getByRole("searchbox", { name: "Find in application" }), { target: { value: "7d9-x" } });
    expect(within(panel).getByRole("button", { name: /^Deployment.*api/ })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /ReplicaSet/ })).toBeNull();
    fireEvent.change(within(panel).getByRole("searchbox", { name: "Find in application" }), { target: { value: "nothing-here" } });
    expect(within(panel).getByText("Nothing in this application matches.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Helm releases" }));
    fireEvent.click(await screen.findByRole("row", { name: "shop-api" }));
    const release = await screen.findByRole("region", { name: "Release shop-api" });
    await within(release).findByRole("button", { name: /Roll back here/ });
    fireEvent.change(within(release).getByRole("searchbox", { name: "Find in release" }), { target: { value: "deployment" } });
    fireEvent.click(within(release).getByRole("tab", { name: /Manifest/ }));
    expect(within(release).getByLabelText("Manifest").querySelector("mark")?.textContent).toBe("Deployment");
  });

  it("builds a right-click menu that fits each kind and state", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({ deployments: { reset: true, delete: [], upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "2/2", updated: "2", available: "2", ageStart: "", images: ["api:1"], labels: {}, paused: true }] } });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Deployments/ }));
    fireEvent.contextMenu(screen.getByRole("row", { name: "api" }), { clientX: 20, clientY: 20 });
    const menu = screen.getByRole("menu", { name: "Actions for Deployment · api" });
    const items = within(menu).getAllByRole("menuitem").map((item) => item.querySelector("span")?.textContent);
    expect(items).toEqual(expect.arrayContaining(["Logs", "Shell", "Port forward…", "Restart", "Scale…", "Set image…", "Resume rollout", "Roll back…", "Copy name", "Delete…"]));
    expect(items).not.toContain("Pause rollout");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy kubectl command" }));
    expect(writeText).toHaveBeenCalledWith("kubectl get deployment api -n default -o yaml");

    fireEvent.click(screen.getByRole("button", { name: /^Pods/ }));
    fireEvent.contextMenu(screen.getByRole("row", { name: "api-7d9c" }), { clientX: 20, clientY: 20 });
    const podMenu = screen.getByRole("menu");
    expect(within(podMenu).getAllByRole("menuitem").map((item) => item.querySelector("span")?.textContent)).toEqual(expect.arrayContaining(["Previous logs", "Evict…", "Force delete…"]));
    fireEvent.click(within(podMenu).getByRole("menuitem", { name: "Force delete…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Force delete now" }));
    await waitFor(() => expect(api.client.runCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "force-delete", kind: "Pod", resourceName: "api-7d9c" })));
  });

  it("searches the logs of every pod of a workload from the menu", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({ deployments: { reset: true, delete: [], upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "2/2", updated: "2", available: "2", ageStart: "", images: ["api:1"], labels: {}, paused: false }] } });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Deployments/ }));
    fireEvent.contextMenu(screen.getByRole("row", { name: "api" }), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Search logs…" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Text to find in logs" }), { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    await waitFor(() => expect(api.client.searchLogs).toHaveBeenCalledWith({
      namespace: "default", workload: { kind: "Deployment", namespace: "default", name: "api" }, pattern: "timeout", regex: false, caseSensitive: false, sinceSeconds: 3600,
    }));
    const hits = await screen.findByRole("list", { name: "Matching lines" });
    expect(within(hits).getAllByRole("listitem")).toHaveLength(2);
    expect(hits.querySelector("mark")?.textContent).toBe("timeout");
    fireEvent.click(within(screen.getByRole("group", { name: "Matches per pod" })).getByRole("button", { name: /api-2/ }));
    expect(within(hits).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Save query/ }));
    expect(within(screen.getByRole("group", { name: "Saved queries" })).getByRole("button", { name: "timeout" })).toBeTruthy();
  });

  it("sets a new image from the menu", async () => {
    const api = createClient();
    api.client.getYaml.mockResolvedValue("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: api:1\n        - name: proxy\n          image: envoy:1\n");
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({ deployments: { reset: true, delete: [], upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "2/2", updated: "2", available: "2", ageStart: "", images: ["api:1"], labels: {}, paused: false }] } });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Deployments/ }));
    fireEvent.contextMenu(screen.getByRole("row", { name: "api" }), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Set image…" }));
    const select = await screen.findByRole("combobox", { name: "Container to update" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "proxy" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New image" }), { target: { value: "envoy:1.31" } });
    fireEvent.click(screen.getByRole("button", { name: "Set image" }));
    await waitFor(() => expect(api.client.runCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "set-image", container: "proxy", image: "envoy:1.31" })));
  });

  it("compares the same app across environments", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "App to compare" }), { target: { value: "checkout-api" } });
    await waitFor(() => expect(api.client.getYamlIn).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(await screen.findByText("3 differences")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByText("acr.io/api:1.5.0")).toBeTruthy();
    expect(within(table).getByText("acr.io/api:1.4.0")).toBeTruthy();
    expect(within(table).getByText("env LOG_LEVEL")).toBeTruthy();
    expect(within(table).queryByText("env REGION")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Only differences" }));
    expect(within(table).getByText("env REGION")).toBeTruthy();
  });

  it("does not pick unrelated apps for a broad search, and offers quick picks", async () => {
    const api = createClient();
    const row = (name: string, namespace: string) => ({ uid: name + namespace, kind: "Deployment", name, namespace, status: "Ready", ageStart: "", columns: {}, labels: {} });
    api.client.findWorkloads.mockResolvedValue([
      row("checkout-api-development", "development"),
      row("checkout-api-production", "production"),
      row("payments-api", "development"),
      row("orders-api", "development"),
    ]);
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "App to compare" }), { target: { value: "api" } });
    const quick = await screen.findByRole("group", { name: "Apps in several environments" }, { timeout: 2000 });
    expect(screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked && box.closest(".compare-chip"))).toHaveLength(0);
    expect(api.client.getYamlIn).not.toHaveBeenCalled();
    fireEvent.click(within(quick).getByRole("button", { name: /checkout-api/ }));
    await waitFor(() => expect(api.client.getYamlIn).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /^Pods/ }));
    expect(screen.getByRole("button", { name: /Create/ })).toBeTruthy();
  });

  it("watches webhook CAs, secret syncs, and kubeconfig logins next to certificates", async () => {
    const api = createClient();
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    api.client.listClusters.mockResolvedValue((await api.client.listClusters()).map((cluster) => (cluster.id === "staging" ? { ...cluster, certExpires: soon } : cluster)));
    api.client.listCertificates.mockResolvedValue([
      { source: "Webhook", namespace: "", name: "gatekeeper-validating", secretName: "", certificateName: "", subject: "gatekeeper", dnsNames: ["gatekeeper/webhook"], issuer: "gatekeeper-ca", notAfter: "2020-01-01T00:00:00.000Z", renewalTime: "", ready: "", problem: "" },
      { source: "ExternalSecret", namespace: "shop", name: "db-credentials", secretName: "db-credentials", certificateName: "", subject: "db-credentials", dnsNames: [], issuer: "ClusterSecretStore/key-vault", notAfter: "", renewalTime: "", ready: "False", problem: "could not get secret data from provider" },
    ]);
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Certificates" }));
    expect(await screen.findByText("1 expired")).toBeTruthy();
    expect(screen.getByText("1 secret sync failing")).toBeTruthy();
    expect(screen.getByText("Webhook CA")).toBeTruthy();
    expect(screen.getByText("Sync failing")).toBeTruthy();
    expect(screen.getByText("Kubeconfig")).toBeTruthy();
    expect(screen.getByText("1 within 30 days")).toBeTruthy();
  });

  it("lists certificates by expiry and image versions across clusters", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { open: [{ id: "prod", state: "connected" }, { id: "staging", state: "connected" }] });
    fireEvent.click(screen.getByRole("button", { name: "Certificates" }));
    expect(await screen.findByText("1 within 30 days")).toBeTruthy();
    expect(screen.getByText("Expires soon")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Image versions" }));
    await waitFor(() => expect(api.client.listImagesIn).toHaveBeenCalledWith("staging"));
    expect(await screen.findByText("2 versions")).toBeTruthy();
    expect(screen.getByText("acr.io/web")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Only images running different versions/ }));
    expect(screen.queryByText("acr.io/web")).toBeNull();
  });

  it("shows an alert and opens the failing pod from it", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    await waitFor(() => expect(api.client.setNotifications).toHaveBeenCalledWith(true));
    act(() => api.emitAlert({ id: "a1", clusterId: "prod", kind: "Pod", namespace: "default", name: "worker-2ab1", reason: "CrashLoopBackOff", message: "Last exit: Error (1)", time: "" }));
    fireEvent.click(await screen.findByRole("button", { name: /CrashLoopBackOff/ }));
    expect(await screen.findByRole("heading", { name: "worker-2ab1" })).toBeTruthy();
  });

  it("follows logs from a time window", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Log time range" }), { target: { value: "900" } });
    await waitFor(() => expect(api.client.followLogs).toHaveBeenLastCalledWith(expect.objectContaining({ pod: "api-7d9c", sinceSeconds: 900 })));
  });

  it("hides a cluster from Home or deletes it from the kubeconfig", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove staging" }));
    let dialog = screen.getByRole("dialog", { name: "Remove staging" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Hide/ }));
    expect(screen.queryByRole("button", { name: "Connect staging" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show hidden \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show staging on Home" }));
    expect(screen.queryByRole("button", { name: /Show hidden/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove staging" }));
    dialog = screen.getByRole("dialog", { name: "Remove staging" });
    const remove = within(dialog).getByRole("button", { name: /Delete/ }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Type the context name to confirm" }), { target: { value: "staging" } });
    fireEvent.click(remove);
    await waitFor(() => expect(api.client.removeContext).toHaveBeenCalledWith("staging"));
    expect(await screen.findByText(/Deleted context staging/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("turns picked actions into a script", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    fireEvent.click(await screen.findByRole("button", { name: "All clusters" }));
    const copy = screen.getByRole("button", { name: /Copy as script/ }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Pick every shown action" }));
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const script = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain("kubectl --context prod rollout restart deployment/api -n default");
    expect(script).toContain("# failed (forbidden): kubectl --context staging delete pod batch -n shop");
  });

  it("offers a downloaded update, and checks for updates from Settings", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await screen.findByRole("button", { name: "Settings" });
    act(() => api.emitUpdate({ status: "ready", current: "0.1.1", version: "0.2.0", canInstall: true, automatic: true }));
    const notice = screen.getByRole("status", { name: "Update" });
    expect(notice.textContent).toContain("Podgaze 0.2.0 is ready to install.");
    fireEvent.click(within(notice).getByRole("button", { name: "Restart to update" }));
    expect(api.client.installUpdate).toHaveBeenCalled();
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss update" }));
    expect(screen.queryByRole("status", { name: "Update" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(await screen.findByText("Checks a few times a day.")).toBeTruthy();
    act(() => api.emitUpdate({ status: "none", current: "0.1.1", canInstall: true, automatic: true }));
    expect(await screen.findByText("You have the latest version.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check now/ }));
    await waitFor(() => expect(api.client.checkForUpdates).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("switch", { name: "Check automatically" }));
    await waitFor(() => expect(api.client.setAutomaticUpdates).toHaveBeenCalledWith(false));
  });

  it("imports a team settings file from Settings", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Sharing" }));
    const file = new File([JSON.stringify({
      podgaze: 1,
      exportedAt: "2026-10-16T00:00:00.000Z",
      groups: { groups: [{ id: "g", name: "Production" }], membership: { prod: "g" } },
      guards: { prod: { protected: true, readOnly: true } },
      logQueries: [{ pattern: "timeout", regex: false, caseSensitive: false }],
    })], "podgaze-settings.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Settings file to import"), { target: { files: [file] } });
    const preview = await screen.findByRole("group", { name: "What to import" });
    expect(within(preview).getAllByRole("checkbox")).toHaveLength(3);
    fireEvent.click(within(preview).getByRole("checkbox", { name: /Saved log searches/ }));
    fireEvent.click(within(preview).getByRole("button", { name: "Import selected" }));
    expect(await screen.findByText(/Imported: 1 cluster groups, Safety flags tightened for 1 contexts\./)).toBeTruthy();
    expect(api.client.setGuard).toHaveBeenCalledWith("prod", { protected: true, readOnly: true });
    expect(localStorage.getItem("podgaze.log-queries")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(await screen.findByRole("heading", { name: /Production/ })).toBeTruthy();
  });

  it("adds clusters from Azure and AWS through their CLIs", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add cloud cluster/ }));
    const dialog = screen.getByRole("dialog", { name: "Add cloud cluster" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(api.client.cloudAddCluster).toHaveBeenCalledWith({ provider: "azure", accountId: "sub-1", group: "rg-dev", name: "aks-demo-dev", azureCliLogin: true }));
    expect(await within(dialog).findByText(/Added aks-demo-dev/)).toBeTruthy();
    expect(api.client.listClusters).toHaveBeenCalledTimes(2);

    fireEvent.click(within(dialog).getByRole("button", { name: "AWS (EKS)" }));
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: "AWS region" }) as HTMLInputElement).value).toBe("eu-west-1"));
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Add$/ }, { timeout: 2000 }));
    await waitFor(() => expect(api.client.cloudAddCluster).toHaveBeenLastCalledWith({ provider: "aws", accountId: "default", group: "eu-west-1", name: "shop" }));
  });

  it("rolls an Argo CD application back to an earlier sync", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, {
      customKinds: [{ kind: "applications.argoproj.io", group: "Custom", label: "Application", namespaced: true, apiVersion: "argoproj.io/v1alpha1", plural: "applications", apiKind: "Application", apiGroup: "argoproj.io", commands: [], columns: [] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Argo CD" }));
    fireEvent.click(await screen.findByRole("row", { name: "shop" }));
    const panel = await screen.findByRole("region", { name: "Application shop" });
    fireEvent.click(within(panel).getByRole("button", { name: /History · 2 syncs/ }));
    fireEvent.click(within(panel).getByRole("button", { name: /Roll back here/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Roll back now" }));
    await waitFor(() => expect(api.client.argoAction).toHaveBeenCalledWith({ name: "shop", namespace: "argocd", action: "rollback", revision: "0ld9876543" }));
  });

  it("suggests right-sizing from collected usage", async () => {
    const api = createClient();
    const mib = 1024 ** 2;
    // Samples dated after anything earlier tests recorded, so none is dropped as a duplicate.
    const start = Date.now() + 60_000;
    for (let index = 0; index < 5; index += 1) {
      recordUsage("prod", { available: true, nodes: [], pods: [{ name: "api-7d9c", namespace: "default", cpuMillicores: 15 + index, memoryBytes: 240 * mib }] }, start + index * 15_000);
    }
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const card = await screen.findByRole("region", { name: "Right-sizing" });
    expect(await within(card).findByText("Near memory limit")).toBeTruthy();
    expect(within(card).getByText(/Peaks at 240Mi of its 256Mi memory limit/)).toBeTruthy();
  });

  it("shows the change history for this cluster or all of them", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(await screen.findByText("deployment/api")).toBeTruthy();
    expect(screen.queryByText("pod/batch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All clusters" }));
    expect(screen.getByText("pod/batch")).toBeTruthy();
    expect(screen.getByText("forbidden")).toBeTruthy();
  });

  it("checks who can do something and what I can do", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    fireEvent.click(screen.getByRole("button", { name: "Access check" }));
    expect(await screen.findByText("get, list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(api.client.whoCan).toHaveBeenCalledWith({ verb: "delete", resource: "pods", group: "", namespace: null }));
    expect(await screen.findByText("ClusterRoleBinding/cluster-admin")).toBeTruthy();
  });

  it("keeps one namespace writable on a read-only cluster", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { namespace: "default", guard: { protected: false, readOnly: true, namespaces: { default: "writable" } } });
    expect(screen.getByText(/default is writable on read-only prod/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Safety settings" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Safety for namespace default" }), { target: { value: "" } });
    expect(api.client.setGuard).toHaveBeenCalledWith("prod", { protected: false, readOnly: true, namespaces: {} });
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(screen.queryByText(/Read-only context: commands that change the cluster are off/)).toBeNull();
  });

  it("shows requests and limits next to usage", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    expect(await screen.findByText(/84m \/ 500m limit/)).toBeTruthy();
    expect(screen.getByText("100m CPU · 128Mi memory")).toBeTruthy();
    expect(screen.getByText("500m CPU · 256Mi memory")).toBeTruthy();
    expect(screen.getByText(/210Mi \/ 256Mi limit/)).toBeTruthy();
  });

  it("changes application settings and applies them", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    const settings = screen.getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(settings).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(within(settings).getByRole("radio", { name: "125%" }));
    expect(document.documentElement.style.getPropertyValue("--ui-zoom")).toBe("1.25");
    fireEvent.click(within(settings).getByRole("button", { name: "Logs" }));
    fireEvent.change(within(settings).getByRole("combobox", { name: "Lines to load" }), { target: { value: "1000" } });
    fireEvent.click(within(settings).getByRole("button", { name: "Editor" }));
    fireEvent.click(within(settings).getByRole("button", { name: "Increase editor font size" }));
    expect(document.documentElement.style.getPropertyValue("--editor-font")).toBe("13px");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("podgaze.settings") ?? "{}")).toMatchObject({ theme: "light", zoom: 1.25, logTail: 1000 });

    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(api.client.followLogs).toHaveBeenCalledWith(expect.objectContaining({ pod: "api-7d9c", tailLines: 1000 })));
  });

  it("closes the sidebar eye when poked and gets dizzy after a few pokes", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    const eye = screen.getByRole("button", { name: "Podgaze" });
    const svg = () => eye.querySelector("svg")!.getAttribute("class") ?? "";
    // Idle, the eye glances around with short one-off moves, never an endless animation.
    expect(svg()).toContain("idle");
    expect(svg()).not.toContain("gazing");
    fireEvent.pointerDown(eye);
    expect(svg()).toContain("closed");
    fireEvent.pointerUp(eye);
    expect(svg()).not.toContain("closed");
    for (let poke = 0; poke < 4; poke += 1) fireEvent.pointerDown(eye);
    expect(svg()).toContain("dizzy");
  });

  it("starts a port forward from the right-click menu", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.contextMenu(screen.getByRole("row", { name: "api-7d9c" }), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Port forward…" }));
    expect(screen.getByRole("tab", { name: "Commands" }).getAttribute("aria-selected")).toBe("true");
    const port = await screen.findByRole("textbox", { name: "Pod port" });
    await waitFor(() => expect(document.activeElement).toBe(port));
    expect((port as HTMLInputElement).value).toBe("8080");
  });

  it("resizes a column and remembers it per kind", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    const handle = screen.getByRole("separator", { name: "Resize Name column" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    const saved = JSON.parse(localStorage.getItem("podgaze.columns.Pod") ?? "{}") as Record<string, number>;
    expect(saved.name).toBeGreaterThanOrEqual(48);
    expect((document.querySelector(".table-head") as HTMLElement).style.gridTemplateColumns).toContain(`${saved.name}px`);
    fireEvent.doubleClick(handle);
    expect(localStorage.getItem("podgaze.columns.Pod")).toBeNull();
  });

  it("runs describe from the pod summary and shows the kubectl command", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    fireEvent.click(screen.getByRole("button", { name: "Describe" }));
    expect(api.client.runCommand).toHaveBeenCalledWith({
      name: "describe",
      kind: "Pod",
      resourceName: "api-7d9c",
      namespace: "default",
      container: "api",
      replicas: undefined,
    });
    expect(await screen.findByText(/kubectl describe pod api-7d9c/)).toBeTruthy();
    expect(screen.getByText(/Status: Running/)).toBeTruthy();
  });

  it("explains a pod that is not running", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("worker-2ab1");
    expect(await screen.findByRole("region", { name: "What's wrong" })).toBeTruthy();
    expect(await screen.findByText("listening")).toBeTruthy();
    expect(api.client.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      pod: "worker-2ab1",
      tailLines: 40,
      previous: true,
    }));
  });

  it("follows pod logs from the dock", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(api.client.followLogs).toHaveBeenCalledWith({
      namespace: "default",
      pod: "api-7d9c",
      container: "api",
      previous: false,
      tailLines: 200,
    }));
  });

  it("finds an object by name from the palette and goes back", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "Command" }), { target: { value: "worker" } });
    fireEvent.click(screen.getByRole("button", { name: /worker-2ab1/ }));
    expect(await screen.findByRole("region", { name: "What's wrong" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "worker-2ab1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "worker-2ab1" })).toBeNull());
  });

  it("jumps to a related object and keeps it selected while its rows load", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(await screen.findByRole("button", { name: "Open Deployment api" }));
    expect(await screen.findByRole("heading", { name: "Deployments" })).toBeTruthy();
    act(() => {
      api.emitRows({
        deployments: {
          reset: true,
          upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "2/2", updated: "2", available: "2", ageStart: "2026-01-01T00:00:00.000Z", images: ["api:1"], labels: { app: "api" }, paused: false }],
          delete: [],
        },
      });
    });
    expect(await screen.findByRole("heading", { name: "api" })).toBeTruthy();
    expect(screen.getByText("Back-off restarting failed container")).toBeTruthy();
  });

  it("asks for the typed name before deleting on a protected context", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { guard: { protected: true, readOnly: false } });
    expect(screen.getByText(/Protected · prod/)).toBeTruthy();
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("textbox", { name: "Confirm name" });
    const run = screen.getByRole("button", { name: "Delete now" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(confirm, { target: { value: "api-7d9" } });
    expect(run.disabled).toBe(true);
    fireEvent.change(confirm, { target: { value: "api-7d9c" } });
    fireEvent.click(run);
    await waitFor(() => expect(api.client.runCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "delete", resourceName: "api-7d9c" })));
  });

  it("turns off changes on a read-only context", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { guard: { protected: false, readOnly: true } });
    expect(screen.getByText(/Read-only · prod/)).toBeTruthy();
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Describe" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Safety settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Read-only/ }));
    expect(api.client.setGuard).toHaveBeenCalledWith("prod", { protected: false, readOnly: false });
  });

  it("disables what the account is not allowed to do", async () => {
    const api = createClient();
    api.client.checkAccess.mockResolvedValue({ delete: false, patch: true });
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("button", { name: "Delete" }).getAttribute("title")).toMatch(/cannot delete/);
  });

  it("shows a forbidden kind in place instead of an empty table", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api, { forbidden: { Node: "This account cannot list resources on https://prod.example:6443. nodes is forbidden" } });
    expect(screen.queryByText(/nodes is forbidden/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Nodes/ }));
    expect(await screen.findByText(/nodes is forbidden/)).toBeTruthy();
  });

  it("reviews a YAML edit with a server dry run before applying only the change", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const manifest = await screen.findByRole("textbox", { name: "Manifest" });
    await waitFor(() => expect(manifest.textContent).toMatch(/kind:\s*Pod/));
    const view = EditorView.findFromDOM(manifest.closest(".cm-editor") as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "  labels:\n    team: core\n" }, userEvent: "input" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.client.applyYaml).toHaveBeenCalledWith({
      base: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api-7d9c\n",
      draft: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api-7d9c\n  labels:\n    team: core\n",
      dryRun: true,
    }));
    expect(await screen.findByText(/Nothing is saved yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(api.client.applyYaml).toHaveBeenLastCalledWith({
      base: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api-7d9c\n",
      draft: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api-7d9c\n  labels:\n    team: core\n",
      force: false,
    }));
    expect(await screen.findByText("Live manifest updated.")).toBeTruthy();
  });

  it("starts a debug container and opens a shell in it", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: /Debug container/ }));
    await waitFor(() => expect(api.client.startDebug).toHaveBeenCalledWith({ namespace: "default", pod: "api-7d9c", target: "api", image: "busybox:1.36" }));
    // jsdom gives the terminal no size, so it never opens a session; the debug container's status line shows instead.
    expect(await screen.findByText("debugger-abc12")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to app container" })).toBeTruthy();
  });

  it("opens logs and YAML from the keyboard", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.keyDown(document.body, { key: "y" });
    expect(await screen.findByRole("textbox", { name: "Manifest" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "l" });
    await waitFor(() => expect(api.client.followLogs).toHaveBeenCalled());
  });

  it("shows the last exit reason in the pod table", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    expect(screen.getByText("OOMKilled (137)")).toBeTruthy();
  });

  it("sorts a column and cycles back to the live order", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    const names = () => [...document.querySelectorAll(".table-row")].map((row) => row.getAttribute("aria-label"));
    expect(names()).toEqual(["api-7d9c", "worker-2ab1", "cache-11f0"]);
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["api-7d9c", "cache-11f0", "worker-2ab1"]);
    fireEvent.click(screen.getByRole("button", { name: /^Name[▲▼]?$/ }));
    expect(names()).toEqual(["worker-2ab1", "cache-11f0", "api-7d9c"]);
    fireEvent.click(screen.getByRole("button", { name: /^Name[▲▼]?$/ }));
    expect(names()).toEqual(["api-7d9c", "worker-2ab1", "cache-11f0"]);
    // Status puts failing pods first.
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(names()[0]).toBe("worker-2ab1");
  });

  it("hides healthy rows with Problems only", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("checkbox", { name: "Problems only" }));
    expect(document.querySelector('.table-row[aria-label="api-7d9c"]')).toBeNull();
    expect(document.querySelector('.table-row[aria-label="worker-2ab1"]')).toBeTruthy();
  });

  it("shows a deployment's timeline with routine entries hidden until asked", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({
        deployments: {
          reset: true,
          upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "2/2", updated: "2", available: "2", ageStart: "2026-01-01T00:00:00.000Z", images: ["api:1"], labels: { app: "api" }, paused: false }],
          delete: [],
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Deployments/ }));
    clickRow("api");
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    expect(await within(timeline).findByText("api was OOM-killed")).toBeTruthy();
    expect(within(timeline).getByText("api 1.4.0 → 1.5.0")).toBeTruthy();
    expect(within(timeline).queryByText("Something routine")).toBeNull();
    fireEvent.click(within(timeline).getByRole("button", { name: /Other/ }));
    expect(within(timeline).getByText("Something routine")).toBeTruthy();
    expect(api.client.getTimeline).toHaveBeenCalledWith({ kind: "Deployment", namespace: "default", name: "api" });
  });

  it("prices nodes and splits the cost by namespace", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({ nodes: { reset: true, delete: [], upsert: [{ uid: "n1", name: "aks-1", status: "Ready", roles: [], kubeletVersion: "", ageStart: "", internalIP: "", cpu: "4", memory: "16Gi", podCapacity: "110", os: "", runtime: "", unschedulable: false, labels: { "node.kubernetes.io/instance-type": "Standard_D4s_v5", "topology.kubernetes.io/region": "westeurope" } }] } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    const prices = screen.getByRole("region", { name: "Node prices" });
    expect(within(prices).getByText("Standard_D4s_v5")).toBeTruthy();
    fireEvent.click(within(prices).getByRole("button", { name: /Look up Azure prices/ }));
    await waitFor(() => expect(api.client.lookupPrices).toHaveBeenCalledWith([{ region: "westeurope", instanceType: "Standard_D4s_v5", spot: false }]));
    expect((await screen.findAllByText("$146")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Cost by namespace" })).toBeTruthy();
  });

  it("prices storage by class, applies a discount, and shows what pods really use", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({
        nodes: { reset: true, delete: [], upsert: [{ uid: "n1", name: "aks-1", status: "Ready", roles: [], kubeletVersion: "", ageStart: "", internalIP: "", cpu: "4", memory: "16Gi", podCapacity: "110", os: "", runtime: "", unschedulable: false, labels: { "node.kubernetes.io/instance-type": "Standard_D4s_v5", "topology.kubernetes.io/region": "westeurope" } }] },
        pods: { reset: true, delete: [], upsert: [{ uid: "p1", name: "api-7d9c", namespace: "default", status: "Running", ready: "1/1", restarts: 0, nodeName: "aks-1", ageStart: "", images: [], ip: "", qos: "", controlledBy: "ReplicaSet/api-7d9c", ports: [], containers: [], lastExit: "", labels: { "pod-template-hash": "7d9c" }, requests: { cpuMillicores: 1000, memoryBytes: 4 * 1024 ** 3 }, limits: { cpuMillicores: 0, memoryBytes: 0 } }] },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    const nodes = screen.getByRole("region", { name: "Node prices" });
    fireEvent.blur(within(nodes).getByRole("textbox", { name: "Price per hour for Standard_D4s_v5" }), { target: { value: "0.2" } });
    expect((await screen.findAllByText("$146")).length).toBeGreaterThan(0);
    fireEvent.blur(within(nodes).getByRole("textbox", { name: "Discount percent" }), { target: { value: "25" } });
    expect(await screen.findByText("1 nodes · 25% off list")).toBeTruthy();
    expect(screen.getAllByText("$110").length).toBeGreaterThan(0);

    const storage = screen.getByRole("region", { name: "Storage prices" });
    expect(await within(storage).findByText("Premium_LRS · disk.csi.azure.com")).toBeTruthy();
    fireEvent.blur(within(storage).getByRole("textbox", { name: "Price per GiB-month for managed-csi-premium" }), { target: { value: "0.15" } });
    expect(within(storage).getByText("$29")).toBeTruthy();

    const byNamespace = screen.getByRole("region", { name: "Cost by namespace" });
    await waitFor(() => expect(within(byNamespace).getAllByText("84m").length).toBeGreaterThan(0));
    fireEvent.click(within(byNamespace).getByRole("button", { name: /default/ }));
    expect(within(byNamespace).getByText("orphaned-backup")).toBeTruthy();
    expect(within(byNamespace).getByText("unmounted volume")).toBeTruthy();
    expect(localStorage.getItem("podgaze.costDiscount")).toBe("25");
  });

  it("follows every pod of a deployment in one stream", async () => {
    const api = createClient();
    api.client.listExecTargets.mockResolvedValue([
      { namespace: "default", pod: "api-1", containers: ["api"] },
      { namespace: "default", pod: "api-2", containers: ["api"] },
    ]);
    let push: (event: LogEvent) => void = () => undefined;
    api.client.onLogs = (listener: (event: LogEvent) => void) => {
      push = listener;
      return () => undefined;
    };
    api.client.followLogs.mockImplementation(async (request: LogFollowRequest) => ({ id: `log-${request.pod}` }));
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({
        deployments: {
          reset: true,
          upsert: [{ uid: "d1", name: "api", namespace: "default", status: "Available", ready: "2/2", updated: "2", available: "2", ageStart: "2026-01-01T00:00:00.000Z", images: ["api:1"], labels: { app: "api" }, paused: false }],
          delete: [],
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /^Deployments/ }));
    clickRow("api");
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(api.client.followLogs).toHaveBeenCalledTimes(2));
    expect(api.client.followLogs).toHaveBeenCalledWith({ namespace: "default", pod: "api-2", container: "api", tailLines: 200 });
    act(() => {
      push({ id: "log-api-1", type: "data", data: "ready on :8080\nhalf a li" });
      push({ id: "log-api-2", type: "data", data: "ready on :8081\n" });
      push({ id: "log-api-1", type: "data", data: "ne\n" });
    });
    const log = screen.getByLabelText("Followed logs");
    await waitFor(() => expect(log.textContent).toContain("[api-1] ready on :8080"));
    expect(log.textContent).toContain("[api-2] ready on :8081");
    expect(log.textContent).toContain("[api-1] half a line");
  });

  it("opens the pods on a node from the node summary", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    act(() => {
      api.emitRows({
        nodes: {
          reset: true,
          upsert: [{ uid: "n1", name: "ip-10-0-4", status: "Ready", roles: ["worker"], kubeletVersion: "v1.32.1", ageStart: "2026-01-01T00:00:00.000Z", internalIP: "10.0.0.4", cpu: "4", memory: "8Gi", podCapacity: "110", os: "Ubuntu", runtime: "containerd", unschedulable: false, labels: {} }],
          delete: [],
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Nodes/ }));
    clickRow("ip-10-0-4");
    fireEvent.click(screen.getByRole("button", { name: "Show 3 pods on ip-10-0-4" }));
    expect(await screen.findByRole("heading", { name: "Pods" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear node filter ip-10-0-4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear node filter ip-10-0-4" }));
    expect(screen.queryByRole("button", { name: /Clear node filter/ })).toBeNull();
  });

  it("reopens the last tab picked for the next object, but never the terminal", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    clickRow("api-7d9c");
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    clickRow("worker-2ab1");
    expect(screen.getByRole("tab", { name: "YAML" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    clickRow("cache-11f0");
    expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows the connected context under the logo", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    expect(document.querySelector(".brand-sub")?.textContent).toBe("prod");
  });

  it("leads the overview with what needs attention and opens it", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const attention = await screen.findByRole("region", { name: "Needs attention" });
    // Only the crash-looping pod is listed; healthy pods stay out.
    const rows = within(attention).getAllByRole("button", { name: /^Open Pod/ }).map((row) => row.getAttribute("aria-label"));
    expect(rows).toEqual(["Open Pod worker-2ab1"]);
    fireEvent.click(within(attention).getByRole("button", { name: "Open Pod worker-2ab1" }));
    expect(await screen.findByRole("heading", { name: "worker-2ab1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pods" })).toBeTruthy();
  });

  it("opens the object behind a recent warning", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const warnings = await screen.findByRole("region", { name: "Recent warnings" });
    fireEvent.click(await within(warnings).findByText("Back-off restarting failed container app"));
    expect(await screen.findByRole("heading", { name: "worker-2ab1" })).toBeTruthy();
  });

  it("opens the pod table filtered to problems from the overview tile", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.queryByRole("searchbox", { name: "Filter by name" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pods 2/3, 1 needs attention" }));
    expect(await screen.findByRole("heading", { name: "Pods" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Problems only" }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('.table-row[aria-label="api-7d9c"]')).toBeNull();
  });

  it("switches namespace from the namespace breakdown", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to namespace kube-system" }));
    expect(api.client.setNamespace).toHaveBeenCalledWith("kube-system");
  });

  it("warns on the card when a context's client certificate has expired", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    const staging = (await screen.findByRole("heading", { name: "staging" })).closest("li")!;
    expect(within(staging).getByText(/Certificate expired/)).toBeTruthy();
    const prod = screen.getByRole("heading", { name: "prod" }).closest("li")!;
    expect(within(prod).queryByText(/Certificate/)).toBeNull();
  });

  it("shows the start screen until the kubeconfig is read", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={60} />);
    expect(screen.getByRole("main", { name: "Starting Podgaze" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Connect prod" })).toBeTruthy();
    expect(screen.queryByRole("main", { name: "Starting Podgaze" })).toBeNull();
  });

  it("shows the searching logo while connecting", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect prod" }));
    act(() => api.emitSession(live({ state: "connecting" })));
    expect(screen.getByText("Connecting to prod")).toBeTruthy();
    expect(document.querySelector(".logo.gazing")).toBeTruthy();
  });

  it("views a context and saves an edit to the kubeconfig", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details prod" }));
    const panel = await screen.findByRole("dialog", { name: "Context prod" });
    expect(await within(panel).findByText("https://prod.example:6443")).toBeTruthy();
    expect(within(panel).getByText(/Certificate expired/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Show YAML (secrets hidden)" }));
    expect(within(panel).getByLabelText("Context YAML").textContent).toContain("<hidden>");
    const save = within(panel).getByRole("button", { name: "Save to kubeconfig" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(panel).getByRole("textbox", { name: "Default namespace" }), { target: { value: "payments" } });
    fireEvent.change(within(panel).getByRole("textbox", { name: "API server" }), { target: { value: "https://10.0.0.9:6443" } });
    expect(within(panel).getByText(/also used by prod-readonly/)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(api.client.updateContext).toHaveBeenCalledWith("prod", { namespace: "payments", server: "https://10.0.0.9:6443" }));
    expect(await within(panel).findByText(/Backup: \/home\/dev\/.kube\/config.podgaze-1.bak/)).toBeTruthy();
    expect(api.client.listClusters).toHaveBeenCalledTimes(2);
  });

  it("right-click opens only the menu; picking an action opens the panel", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    const row = screen.getByText("api-7d9c").closest("button")!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(row.className).toContain("marked");
    expect(screen.queryByRole("tab", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close panel" })).toBeNull();
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Edit YAML" }));
    expect(await screen.findByRole("textbox", { name: "Manifest" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("searches the namespace picker", async () => {
    const api = createClient();
    render(<App client={api.client} splashMs={0} />);
    await connectAndLoad(api);
    fireEvent.click(screen.getByRole("button", { name: "Choose namespace" }));
    const find = screen.getByRole("searchbox", { name: "Find namespace" });
    expect(document.activeElement).toBe(find);
    fireEvent.change(find, { target: { value: "kube" } });
    const list = screen.getByRole("listbox", { name: "Namespace" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["kube-system"]);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(api.client.setNamespace).toHaveBeenCalledWith("kube-system");
    expect(screen.queryByRole("listbox", { name: "Namespace" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Choose namespace" }));
    const again = screen.getByRole("searchbox", { name: "Find namespace" });
    fireEvent.change(again, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No match")).toBeTruthy();
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Namespace" })).toBeNull();
  });
});
