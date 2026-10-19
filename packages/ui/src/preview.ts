import { registerCustomKinds, type ClusterAlert, type ArgoApp, type MapScope, type ResourceMap, type AuditEntry, type CatalogEntry, type CreateRequest, type HelmActionRequest, type HelmRelease, type OpenCluster, type WhoCanRequest, type ContextDetails, ContextEdit, ContextSaved, ClusterWarning, AccessMap, ApplyRequest, ApplyResult, ClusterClient, ContextGuard, DebugRequest, ObjectEvent, RelatedRef, ClusterSummary, CommandRequest, CommandResult, ExecTarget, LogBundle, LogEvent, LogFollowRequest, LogRequest, NodeRow, PodRow, PortForwardRequest, ResourceKind, ResourceRef, ResourceRow, RowBatch, Session, TerminalEvent, TerminalRequest } from "@podgaze/contracts";

const clusters: ClusterSummary[] = [
  { id: "prod", name: "prod", server: "https://prod.example:6443", namespace: "default", usable: true, problem: null, certExpires: new Date(Date.now() + 9 * 86_400_000).toISOString() },
  { id: "staging", name: "staging", server: "https://staging.example:6443", namespace: null, usable: true, problem: null, certExpires: "2026-08-14T06:53:25.000Z" },
];

function pod(name: string, namespace: string, status: string, restarts: number): PodRow {
  return {
    uid: name,
    name,
    namespace,
    status,
    ready: status === "Running" ? "1/1" : "0/1",
    restarts,
    nodeName: "ip-10-0-4",
    ageStart: "2026-09-28T08:00:00.000Z",
    images: [`ghcr.io/shop/${name}:1.8.2`],
    ip: "10.0.1.18",
    qos: "Burstable",
    controlledBy: `ReplicaSet/${name}`,
    ports: ["8080/TCP"],
    containers: [{ name: "app", image: `ghcr.io/shop/${name}:1.8.2`, ready: status === "Running", restarts, state: status }],
    lastExit: restarts > 0 ? (status === "CrashLoopBackOff" ? "Error (1)" : "OOMKilled (137)") : "",
    labels: { app: name.split("-")[0]!, team: namespace === "kube-system" ? "platform" : "shop" },
    requests: { cpuMillicores: name.startsWith("api") ? 100 : 50, memoryBytes: 128 * 1024 ** 2 },
    limits: { cpuMillicores: name.startsWith("api") ? 500 : 0, memoryBytes: 256 * 1024 ** 2 },
  };
}

const previewSecret: { type: string; resourceVersion: string; values: { key: string; value: string; binary: boolean; encoded: string }[] } = {
  type: "Opaque",
  resourceVersion: "41",
  values: [
    { key: "connectionstring", value: "Server=tcp:db.example.com,1433;Database=Shop;User ID=shop;Password=example-password;Encrypt=True;", binary: false, encoded: "" },
    { key: "encryption-key", value: "0123456789abcdef0123456789abcdef", binary: false, encoded: "" },
    { key: "oauth-client-secret", value: "example-client-secret", binary: false, encoded: "" },
    { key: "signing-key", value: "", binary: true, encoded: "/+79/A==" },
  ].map((item) => (item.encoded ? item : { ...item, encoded: btoa(item.value) })),
};

const customKinds: CatalogEntry[] = [
  {
    kind: "applications.argoproj.io", group: "Custom", label: "Application", namespaced: true, apiVersion: "argoproj.io/v1alpha1", plural: "applications",
    apiKind: "Application", apiGroup: "argoproj.io", commands: ["describe", "events", "delete"],
    columns: [{ key: "sync-status", header: "Sync Status", width: "0.8fr" }, { key: "health-status", header: "Health Status", width: "0.8fr" }],
  },
  {
    kind: "certificates.cert-manager.io", group: "Custom", label: "Certificate", namespaced: true, apiVersion: "cert-manager.io/v1", plural: "certificates",
    apiKind: "Certificate", apiGroup: "cert-manager.io", commands: ["describe", "events", "delete"],
    columns: [{ key: "ready", header: "Ready", width: "0.5fr" }, { key: "secret", header: "Secret", width: "1fr" }],
  },
  {
    kind: "issuers.cert-manager.io", group: "Custom", label: "Issuer", namespaced: true, apiVersion: "cert-manager.io/v1", plural: "issuers",
    apiKind: "Issuer", apiGroup: "cert-manager.io", commands: ["describe", "events", "delete"], columns: [],
  },
];

const helmReleases: HelmRelease[] = [
  { name: "ingress-nginx", namespace: "kube-system", revision: 4, status: "deployed", chart: "ingress-nginx", chartVersion: "4.11.2", appVersion: "1.11.2", updated: "2026-10-02T09:12:00.000Z", description: "Upgrade complete" },
  { name: "shop-api", namespace: "default", revision: 12, status: "deployed", chart: "shop-api", chartVersion: "0.12.0", appVersion: "1.8.2", updated: "2026-10-14T16:40:00.000Z", description: "Upgrade complete" },
  { name: "redis", namespace: "default", revision: 2, status: "failed", chart: "redis", chartVersion: "19.6.1", appVersion: "7.2.5", updated: "2026-10-15T07:05:00.000Z", description: "Upgrade \"redis\" failed: timed out waiting for the condition" },
];

const pods = [
  pod("api-7d9c", "default", "Running", 0),
  pod("worker-2ab1", "default", "CrashLoopBackOff", 14),
  pod("cache-11f0", "kube-system", "Running", 1),
];

const nodes: NodeRow[] = [
  {
    uid: "node-a",
    name: "ip-10-0-4",
    status: "Ready",
    roles: ["worker"],
    kubeletVersion: "v1.32.1",
    ageStart: "2026-08-01T00:00:00.000Z",
    internalIP: "10.0.0.4",
    cpu: "4",
    memory: "16Gi",
    podCapacity: "110",
    os: "Ubuntu 24.04",
    runtime: "containerd://1.7.27",
    unschedulable: false,
    labels: { "kubernetes.io/os": "linux", "node.kubernetes.io/instance-type": "Standard_D4s_v5", "topology.kubernetes.io/region": "westeurope" },
  },
];

export function createPreviewClient(): ClusterClient {
  let session: Session = {
    state: "disconnected",
    clusterId: null,
    namespace: null,
    kubeconfigPath: "/home/dev/.kube/config",
    problem: null,
    namespaces: [],
    guard: { protected: false, readOnly: false },
    forbidden: {},
  };
  const open = new Map<string, Session>();
  const alertListeners = new Set<(alert: ClusterAlert) => void>();
  const audit: AuditEntry[] = [
    { id: "a1", time: new Date(Date.now() - 3_600_000).toISOString(), cluster: "prod", namespace: "default", action: "rollout-restart", target: "deployment/api", kubectl: "kubectl rollout restart deployment/api -n default", ok: true },
    { id: "a2", time: new Date(Date.now() - 7_200_000).toISOString(), cluster: "staging", namespace: "shop", action: "delete", target: "pod/batch-77f1", kubectl: "kubectl delete pod batch-77f1 -n shop", ok: false, error: "pods \"batch-77f1\" is forbidden" },
  ];
  function record(entry: Omit<AuditEntry, "id" | "time" | "cluster">) {
    audit.unshift({ ...entry, id: `a${audit.length + 1}`, time: new Date().toISOString(), cluster: session.clusterId ?? "" });
  }
  function openList(): OpenCluster[] {
    return [...open.keys()].map((id) => ({ id, state: "connected" as const }));
  }
  const guards: Record<string, ContextGuard> = { prod: { protected: true, readOnly: false }, staging: { protected: false, readOnly: false } };
  const sessions = new Set<(value: Session) => void>();
  const rows = new Set<(batch: RowBatch) => void>();
  const terminalListeners = new Set<(event: TerminalEvent) => void>();
  const terminalInputs = new Map<string, (data: string) => void>();
  const logListeners = new Set<(event: LogEvent) => void>();
  const logTimers = new Map<string, ReturnType<typeof setInterval>>();
  let terminalSeq = 0;
  let logSeq = 0;

  function emit() {
    if (session.clusterId) open.set(session.clusterId, session);
    const snapshot = { ...session, namespaces: session.namespaces.slice(), guard: { ...session.guard }, forbidden: { ...session.forbidden }, open: openList() };
    for (const listener of sessions) listener(snapshot);
  }

  return {
    async listClusters() {
      emit();
      return clusters;
    },
    async pickKubeconfig() {
      return session.kubeconfigPath;
    },
    async connect(clusterId) {
      session = {
        state: "connected",
        clusterId,
        namespace: null,
        kubeconfigPath: session.kubeconfigPath,
        problem: null,
        namespaces: ["default", "kube-system", "shop"],
        guard: { ...(guards[clusterId] ?? { protected: false, readOnly: false }) },
        forbidden: {},
        customKinds,
        ...(open.get(clusterId) ? { namespace: open.get(clusterId)!.namespace } : {}),
      };
      registerCustomKinds(customKinds);
      emit();
      const batch: RowBatch = {
        pods: { reset: true, upsert: pods, delete: [] },
        nodes: { reset: true, upsert: nodes, delete: [] },
        deployments: {
          reset: true,
          upsert: [{
            uid: "api",
            name: "api",
            namespace: "default",
            status: "Available",
            ready: "2/2",
            updated: "2",
            available: "2",
            ageStart: "2026-09-01T00:00:00.000Z",
            images: ["ghcr.io/shop/api:1.8.2"],
            labels: { app: "api", team: "shop" },
            paused: false,
          }],
          delete: [],
        },
      };
      for (const listener of rows) listener(batch);
    },
    async disconnect() {
      for (const timer of logTimers.values()) clearInterval(timer);
      logTimers.clear();
      if (session.clusterId) open.delete(session.clusterId);
      session = { ...session, state: "disconnected", clusterId: null, namespaces: [] };
      emit();
    },
    async closeCluster(clusterId: string) {
      if (clusterId === session.clusterId) {
        open.delete(clusterId);
        session = { ...session, state: "disconnected", clusterId: null, namespaces: [] };
      } else open.delete(clusterId);
      emit();
    },
    async createYaml(request: CreateRequest) {
      const kinds = [...request.yaml.matchAll(/^kind:\s*(\S+)/gm)].map((match) => match[1]!);
      const names = [...request.yaml.matchAll(/^\s{2}name:\s*(\S+)/gm)].map((match) => match[1]!);
      if (kinds.length === 0) throw new Error("There is nothing to create: the YAML has no object with a kind.");
      const created = kinds.map((kind, index) => ({ kind, namespace: request.namespace ?? "default", name: names[index] ?? "unnamed" }));
      const label = created.map((ref) => `${ref.kind}/${ref.name}`).join(", ");
      if (!request.dryRun) record({ action: "create", target: label.toLowerCase(), namespace: request.namespace ?? "default", kubectl: "kubectl create -f -", ok: true });
      return { created, dryRun: Boolean(request.dryRun), message: request.dryRun ? `The API server accepts ${label}. Nothing is created yet.` : `Created ${label}.` };
    },
    async listHelmReleases() {
      return session.namespace ? helmReleases.filter((release) => release.namespace === session.namespace) : helmReleases.slice();
    },
    async getHelmRelease(namespace: string, name: string) {
      const release = helmReleases.find((item) => item.namespace === namespace && item.name === name);
      if (!release) throw new Error("No Helm release by that name here.");
      return {
        ...release,
        values: "replicaCount: 3\nimage:\n  tag: 1.8.2\nresources:\n  limits:\n    memory: 256Mi\n",
        manifest: `---\n# Source: ${release.chart}/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${release.name}\n`,
        notes: `Thank you for installing ${release.chart}.\nVisit http://${release.name}.example.com`,
        history: Array.from({ length: Math.min(release.revision, 4) }, (_, index) => ({
          revision: release.revision - index,
          status: index === 0 ? release.status : "superseded",
          updated: new Date(Date.parse(release.updated) - index * 86_400_000).toISOString(),
          chartVersion: release.chartVersion,
          appVersion: release.appVersion,
          description: index === 0 ? release.description : "Upgrade complete",
        })),
      };
    },
    async helmAction(request: HelmActionRequest) {
      const command = request.action === "rollback" ? `helm rollback ${request.name}${request.revision ? ` ${request.revision}` : ""} -n ${request.namespace}` : `helm uninstall ${request.name} -n ${request.namespace}`;
      record({ action: `helm ${request.action}`, target: `release/${request.name}`, namespace: request.namespace, kubectl: command, ok: true });
      return { title: request.action, command, output: request.action === "rollback" ? "Rollback was a success! Happy Helming!" : `release "${request.name}" uninstalled` };
    },
    async helmRepos() {
      return [{ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }, { name: "prometheus-community", url: "https://prometheus-community.github.io/helm-charts" }];
    },
    async helmAddRepo() {},
    async helmSearch(term: string) {
      const all = [
        { name: "bitnami/redis", version: "19.6.1", appVersion: "7.2.5", description: "Redis(R) is an open source, advanced key-value store." },
        { name: "bitnami/postgresql", version: "15.5.20", appVersion: "16.4.0", description: "PostgreSQL is an object-relational database." },
        { name: "prometheus-community/kube-prometheus-stack", version: "62.3.1", appVersion: "v0.76.0", description: "Prometheus, Grafana, and Alertmanager." },
      ];
      const needle = term.replace(/\/$/, "").toLowerCase();
      return all.filter((chart) => chart.name.includes(needle));
    },
    async helmChartValues(chart: string) {
      return `## Default values for ${chart}\narchitecture: replication\nauth:\n  enabled: true\n  password: ""\nreplica:\n  replicaCount: 3\n`;
    },
    async helmInstall(request) {
      const command = `helm ${request.upgrade ? "upgrade" : "install"} ${request.release} ${request.chart} -n ${request.namespace}`;
      if (!request.dryRun) record({ action: request.upgrade ? "helm upgrade" : "helm install", target: `release/${request.release}`, namespace: request.namespace, kubectl: command, ok: true });
      return {
        title: request.dryRun ? "Dry run" : "Install",
        command,
        output: request.dryRun ? `NAME: ${request.release}\nSTATUS: pending-install\nMANIFEST:\n---\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: ${request.release}-master\n` : `NAME: ${request.release}\nNAMESPACE: ${request.namespace}\nSTATUS: deployed\nREVISION: 1`,
      };
    },
    async getMap(scope: MapScope): Promise<ResourceMap> {
      const all = previewMap();
      if (!scope.namespaces) return all;
      const nodes = all.nodes.filter((node) => !node.namespace || scope.namespaces!.includes(node.namespace));
      const ids = new Set(nodes.map((node) => node.id));
      return { nodes, edges: all.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), truncated: false };
    },
    async listArgoApps() {
      return previewArgo();
    },
    async argoAction(request) {
      if (request.action === "sync") record({ action: "argo sync", target: `application/${request.name}`, namespace: request.namespace, kubectl: `argocd app sync ${request.name}`, ok: true });
      return { title: request.action, command: request.action === "sync" ? `argocd app sync ${request.name}` : `argocd app get ${request.name} --refresh`, output: request.action === "sync" ? "Sync of main requested. Argo CD picks it up within seconds." : "Refresh requested." };
    },
    async hubSearch(term: string) {
      const needle = term.toLowerCase();
      return [
        { name: "redis", version: "20.1.0", appVersion: "7.4.0", description: "Redis(R) is an open source, advanced key-value store.", stars: 312, repo: { name: "bitnami", url: "https://charts.bitnami.com/bitnami", official: false, verified: true } },
        { name: "redis-ha", version: "4.27.0", appVersion: "7.2.4", description: "Highly available Kubernetes implementation of Redis", stars: 41, repo: { name: "dandydev", url: "https://dandydeveloper.github.io/charts", official: false, verified: false } },
        { name: "cert-manager", version: "v1.15.3", appVersion: "v1.15.3", description: "A Helm chart for cert-manager", stars: 220, repo: { name: "cert-manager", url: "https://charts.jetstack.io", official: true, verified: true } },
      ].filter((chart) => chart.name.includes(needle) || chart.description.toLowerCase().includes(needle));
    },
    async startNodeShell(node: string) {
      record({ action: "node shell", target: `node/${node}`, namespace: null, kubectl: `kubectl debug node/${node} -it --image=busybox:1.36`, ok: true });
      return { namespace: "kube-system", pod: "podgaze-node-shell-prev1", container: "shell", command: ["nsenter", "-t", "1", "--", "sh"] };
    },
    async stopNodeShell() {},
    async findWorkloads(clusterId: string, needle: string) {
      const names = ["checkout-api-development", "checkout-api-staging", "checkout-api-production", "storefront-development", "storefront-production"];
      return names.filter((name) => name.includes(needle)).map((name) => ({
        uid: `${clusterId}/${name}`, kind: "Deployment", name, namespace: name.split("-").pop()!, status: "Ready", ageStart: "", columns: {}, labels: {},
      }));
    },
    async getYamlIn(_clusterId: string, ref: ResourceRef) {
      const env = ref.namespace ?? "development";
      const prod = env === "production";
      return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${ref.name}
spec:
  replicas: ${prod ? 3 : 1}
  strategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: ${ref.name.replace(/-(development|staging|production)$/, "")}
        env: ${env}
    spec:
      serviceAccountName: checkout
      containers:
        - name: app
          image: registry.example.com/checkout-api:${prod ? "e5f6a7b8" : "a1b2c3d4"}
          resources:
            requests: { cpu: ${prod ? "250m" : "100m"}, memory: 256Mi }
            limits: { memory: ${prod ? "512Mi" : "256Mi"} }
          env:
            - name: ASPNETCORE_ENVIRONMENT
              value: ${env}
            - name: LOG_LEVEL
              value: ${prod ? "Warning" : "Debug"}
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: checkout-${env}, key: db-password } }
          readinessProbe:
            httpGet: { path: /health/ready, port: 8080 }
`;
    },
    async listImagesIn(clusterId: string) {
      return [
        { kind: "Deployment", namespace: "development", name: "checkout-api", containers: [{ name: "app", image: "registry.example.com/checkout-api:a1b2c3d4" }] },
        { kind: "Deployment", namespace: "production", name: "checkout-api", containers: [{ name: "app", image: `registry.example.com/checkout-api:${clusterId === "prod" ? "e5f6a7b8" : "a1b2c3d4"}` }] },
        { kind: "Deployment", namespace: "production", name: "storefront", containers: [{ name: "web", image: "registry.example.com/storefront:2.4.1" }] },
        { kind: "DaemonSet", namespace: "kube-system", name: "fluent-bit", containers: [{ name: "fluent-bit", image: "cr.fluentbit.io/fluent/fluent-bit:3.1.9" }] },
      ];
    },
    async lookupPrices(requests) {
      return requests.map((request) => ({ ...request, hourly: request.instanceType.startsWith("Standard_") ? (request.spot ? 0.04 : 0.192) : null, note: request.instanceType.startsWith("Standard_") ? "" : "Only Azure VM sizes can be looked up; enter this one by hand." }));
    },
    async updateState() {
      return { status: "none" as const, current: "0.1.1", canInstall: false, automatic: true };
    },
    async checkForUpdates() {
      return { status: "none" as const, current: "0.1.1", canInstall: false, automatic: true };
    },
    async installUpdate() {},
    async setAutomaticUpdates(enabled: boolean) {
      return { status: "idle" as const, current: "0.1.1", canInstall: false, automatic: enabled };
    },
    onUpdate() {
      return () => undefined;
    },
    async listVolumes() {
      return {
        volumes: [
          { namespace: "kube-system", name: "data-cache-0", storageClass: "managed-csi-premium", sizeBytes: 128 * 1024 ** 3, phase: "Bound", usedBy: ["cache-11f0"] },
          { namespace: "default", name: "reports-archive", storageClass: "managed-csi", sizeBytes: 256 * 1024 ** 3, phase: "Bound", usedBy: [] },
          { namespace: "kube-system", name: "logs", storageClass: "managed-csi", sizeBytes: 32 * 1024 ** 3, phase: "Bound", usedBy: [] },
        ],
        classes: [
          { name: "managed-csi", provisioner: "disk.csi.azure.com", sku: "StandardSSD_LRS", isDefault: true },
          { name: "managed-csi-premium", provisioner: "disk.csi.azure.com", sku: "Premium_LRS", isDefault: false },
        ],
      };
    },
    async searchLogs(request) {
      const pods = request.workload ? [`${request.workload.name}-7c9f-a`, `${request.workload.name}-7c9f-b`] : ["checkout-api-7c9f-a", "storefront-5d8-q"];
      const lines = ["GET /health 200 2ms", "ERROR upstream timeout calling payments after 3000ms", "retrying request 2 of 3", "WARN slow query 812ms", "POST /orders 201 48ms"];
      const matches = Array.from({ length: 18 }, (_, index) => {
        const line = `${lines[index % lines.length]!} id=${1000 + index}`;
        return { pod: pods[index % 2]!, container: "app", time: new Date(Date.now() - (18 - index) * 97_000).toISOString(), line };
      }).flatMap((match) => {
        const at = request.caseSensitive ? match.line.indexOf(request.pattern) : match.line.toLowerCase().indexOf(request.pattern.toLowerCase());
        return at >= 0 ? [{ ...match, ranges: [[at, at + request.pattern.length]] as [number, number][] }] : [];
      });
      return { matches, pods: 2, containers: 2, lines: 18, truncated: false, problems: [] };
    },
    async getTimeline(ref) {
      const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      return {
        entries: [
          { time: at(4), category: "crash", title: "BackOff ×6", detail: "Back-off restarting failed container", object: `Pod ${ref.name}-7c9f` },
          { time: at(9), category: "oom", title: "app was OOM-killed", detail: "Used more memory than its limit", object: `Pod ${ref.name}-7c9f` },
          { time: at(12), category: "scale", title: "SuccessfulRescale", detail: "New size: 4; reason: cpu resource utilization above target", object: `HorizontalPodAutoscaler ${ref.name}` },
          { time: at(14), category: "deploy", title: "Rolled out revision 8", detail: "app a1b2c3d4 → e5f6a7b8", object: `ReplicaSet ${ref.name}-7c9f` },
          { time: at(15), category: "sync", title: "Argo CD synced checkout", detail: "e5f6a7b8 · apps/checkout", object: "Application checkout" },
          { time: at(60 * 26), category: "deploy", title: "Rolled out revision 7", detail: "app 9f8e7d6c → a1b2c3d4", object: `ReplicaSet ${ref.name}-5d8` },
          { time: at(60 * 26 + 1), category: "sync", title: "Argo CD synced checkout", detail: "a1b2c3d4 · apps/checkout", object: "Application checkout" },
          { time: at(60 * 75), category: "warning", title: "Unhealthy ×3", detail: "Readiness probe failed: HTTP probe failed with statuscode: 503", object: `Pod ${ref.name}-5d8-q2` },
        ],
        eventsSince: at(60),
      };
    },
    async listCertificates() {
      const days = (count: number) => new Date(Date.now() + count * 86_400_000).toISOString();
      return [
        { source: "Certificate" as const, namespace: "istio-ingress", name: "shop-gateway-dev", secretName: "shop-gateway-dev-tls", certificateName: "shop-gateway-dev", subject: "api.dev.example.com", dnsNames: ["api.dev.example.com", "admin.dev.example.com"], issuer: "ClusterIssuer/letsencrypt", notAfter: days(6), renewalTime: days(-24), ready: "False", problem: "Issuing certificate as Secret does not exist" },
        { source: "Certificate" as const, namespace: "istio-ingress", name: "shop-gateway", secretName: "shop-gateway-tls", certificateName: "shop-gateway", subject: "api.example.com", dnsNames: ["api.example.com"], issuer: "ClusterIssuer/letsencrypt", notAfter: days(61), renewalTime: days(31), ready: "True", problem: "" },
        { source: "Secret" as const, namespace: "legacy", name: "partner-mtls", secretName: "partner-mtls", certificateName: "", subject: "partner.example.com", dnsNames: ["partner.example.com"], issuer: "DigiCert TLS RSA SHA256 2020 CA1", notAfter: days(-3), renewalTime: "", ready: "", problem: "" },
      ];
    },
    onAlert(listener) {
      alertListeners.add(listener);
      return () => alertListeners.delete(listener);
    },
    onAlertOpen() {
      return () => undefined;
    },
    async setNotifications() {},
    async cloudAccounts(provider) {
      if (provider === "aws") return [{ id: "default", name: "default", isDefault: true }, { id: "team-a", name: "team-a", isDefault: false }];
      if (provider === "gcp") return [{ id: "demo-project", name: "Demo (demo-project)", isDefault: false }];
      return [{ id: "sub-dev", name: "Demo Development", isDefault: true }, { id: "sub-prod", name: "Demo Production", isDefault: false }];
    },
    async cloudDefaultRegion() {
      return "eu-west-1";
    },
    async cloudClusters(provider, accountId, region) {
      if (provider === "aws") return [{ provider, name: "shop-eks", group: region ?? "", location: region ?? "", version: "", state: "", note: "", accountId }];
      if (provider === "gcp") return [{ provider, name: "shop-gke", group: "europe-west1", location: "europe-west1", version: "1.30.4", state: "RUNNING", note: "", accountId }];
      return [{ provider, name: accountId === "sub-dev" ? "aks-demo-dev" : "aks-demo-prod", group: "rg-demo", location: "westeurope", version: "1.30.3", state: "Running", note: "Entra ID", accountId }];
    },
    async cloudAddCluster(request) {
      return { context: request.name, message: `Merged "${request.name}" into /home/dev/.kube/config` };
    },
    async listAudit() {
      return audit.slice();
    },
    async whoCan(request: WhoCanRequest) {
      return [
        { kind: "Group", name: "system:masters", binding: "ClusterRoleBinding/cluster-admin", role: "ClusterRole/cluster-admin", scope: "cluster" as const },
        { kind: "ServiceAccount", name: "argocd-application-controller", namespace: "argocd", binding: "ClusterRoleBinding/argocd-application-controller", role: "ClusterRole/argocd-application-controller", scope: "cluster" as const },
        ...(request.verb === "get" || request.verb === "list" ? [{ kind: "Group", name: "shop-devs", binding: "RoleBinding/devs", role: "ClusterRole/view", scope: "namespace" as const }] : []),
      ];
    },
    async myRules() {
      return [
        { verbs: ["*"], apiGroups: ["*"], resources: ["*"], resourceNames: [] },
        { verbs: ["create"], apiGroups: ["authorization.k8s.io"], resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"], resourceNames: [] },
      ];
    },
    async setNamespace(namespace) {
      session = { ...session, namespace };
      emit();
    },
    subscribeRows(listener) {
      rows.add(listener);
      return () => rows.delete(listener);
    },
    async getYaml() {
      return "apiVersion: v1\nkind: Pod\nmetadata:\n  name: api-7d9c\n";
    },
    async runCommand(request: CommandRequest): Promise<CommandResult> {
      if (["delete", "rollout-restart", "scale", "rollout-undo", "cordon", "uncordon", "drain", "trigger", "suspend", "resume"].includes(request.name)) {
        record({ action: request.name, target: `${request.kind.toLowerCase()}/${request.resourceName}`, namespace: request.namespace, kubectl: `kubectl ${request.name} ${request.kind.toLowerCase()} ${request.resourceName}`, ok: true });
      }
      const namespace = request.namespace ? ` -n ${request.namespace}` : "";
      const command = request.name === "logs"
        ? `kubectl logs ${request.resourceName}${namespace} --tail=200`
        : request.name.startsWith("rollout")
          ? `kubectl rollout ${request.name.replace("rollout-", "")} deployment/api${namespace}`
          : `kubectl describe ${request.kind.toLowerCase()} ${request.resourceName}${namespace}`;
      return {
        title: request.name,
        command,
        output: request.name === "logs"
          ? "2026-09-30T10:00:00Z listening on :8080"
          : request.name === "events" && request.resourceName === "worker-2ab1"
            ? "Warning  BackOff  Back-off restarting failed container app in pod worker-2ab1"
            : `Name: ${request.resourceName}\nStatus: Running\nIP: 10.0.1.18\nQoS Class: Burstable\n`,
      };
    },
    async listCounts() {
      return { Service: 2, ConfigMap: 4, Secret: 2, Namespace: 3 };
    },
    async setFocus(kind: ResourceKind) {
      const builtin = kind === "Pod" || kind === "Node" || kind === "Deployment";
      const batch: RowBatch = {
        resources: {
          reset: true,
          upsert: builtin ? [] : previewRows(kind),
          delete: [],
        },
      };
      for (const listener of rows) listener(batch);
    },
    async followLogs(request: LogFollowRequest) {
      const id = `log-${++logSeq}`;
      const send = (data: string) => {
        for (const listener of logListeners) listener({ id, type: "data", data });
      };
      send(`${request.previous ? "previous " : ""}logs ${request.namespace}/${request.pod}/${request.container}\n`);
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        send(`${new Date().toISOString()} ${request.container} line ${count}\n`);
      }, 1000);
      logTimers.set(id, timer);
      return { id };
    },
    async stopFollow(id: string) {
      const timer = logTimers.get(id);
      if (timer) clearInterval(timer);
      logTimers.delete(id);
      for (const listener of logListeners) listener({ id, type: "end" });
    },
    onLogs(listener: (event: LogEvent) => void) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    async getLogs(request: LogRequest): Promise<LogBundle> {
      const body = request.pod === "worker-2ab1"
        ? "Error: redis:6379 connection refused\nexit status 1\n"
        : "2026-09-30T10:00:00Z listening on :8080\n";
      const text = request.containers.map((container) => `# ${request.namespace}/${request.pod}/${container}\n${body}`).join("\n");
      const filename = request.containers.length === 1 ? `${request.pod}-${request.containers[0]}.log` : `${request.pod}.log`;
      return { filename, text };
    },
    async applyYaml(request: ApplyRequest): Promise<ApplyResult> {
      return {
        applied: !request.dryRun,
        live: request.base,
        yaml: request.draft,
        message: request.dryRun ? "The API server accepted this change. Nothing is saved yet." : "Live manifest updated.",
        conflicts: [],
      };
    },
    async listRelated(ref: ResourceRef): Promise<RelatedRef[]> {
      if (ref.kind === "Pod") {
        return [
          { kind: "Deployment", namespace: ref.namespace, name: "api", relation: "Owner", status: "Available" },
          { kind: "Node", namespace: null, name: "ip-10-0-4", relation: "Node" },
          { kind: "Service", namespace: ref.namespace, name: "api", relation: "Service", status: "Active" },
          { kind: "Secret", namespace: ref.namespace, name: "payments-api", relation: "Env" },
        ];
      }
      if (ref.kind === "Deployment" || ref.kind === "Service") {
        return pods.filter((item) => item.namespace === ref.namespace).map((item) => ({ kind: "Pod" as const, namespace: item.namespace, name: item.name, relation: "Pod", status: item.status }));
      }
      return [];
    },
    async listEvents(ref: ResourceRef): Promise<ObjectEvent[]> {
      if (ref.name !== "worker-2ab1") return [{ time: new Date(Date.now() - 600_000).toISOString(), type: "Normal", reason: "Started", message: "Started container app", count: 1, source: "kubelet" }];
      return [
        { time: new Date(Date.now() - 30_000).toISOString(), type: "Warning", reason: "BackOff", message: "Back-off restarting failed container app in pod worker-2ab1", count: 14, source: "kubelet" },
        { time: new Date(Date.now() - 900_000).toISOString(), type: "Normal", reason: "Pulled", message: "Container image already present on machine", count: 15, source: "kubelet" },
      ];
    },
    async listWarnings(): Promise<ClusterWarning[]> {
      const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
      return [
        { time: ago(20), reason: "BackOff", message: "Back-off restarting failed container app in pod worker-2ab1", count: 14, namespace: "default", object: { kind: "Pod", namespace: "default", name: "worker-2ab1" }, objectLabel: "Pod/worker-2ab1" },
        { time: ago(340), reason: "OOMKilling", message: "Memory cgroup out of memory: killed process 4123 (redis-server)", count: 1, namespace: "kube-system", object: { kind: "Pod", namespace: "kube-system", name: "cache-11f0" }, objectLabel: "Pod/cache-11f0" },
        { time: ago(1900), reason: "FailedScheduling", message: "0/1 nodes are available: 1 Insufficient memory.", count: 3, namespace: "default", object: null, objectLabel: "Pod/batch-77f1" },
      ];
    },
    async checkAccess(): Promise<AccessMap> {
      return { delete: true, patch: true, exec: true, portforward: true, logs: true };
    },
    async describeContext(clusterId: string): Promise<ContextDetails> {
      const cluster = clusters.find((item) => item.id === clusterId);
      return {
        id: clusterId,
        file: session.kubeconfigPath ?? "/home/dev/.kube/config",
        current: clusterId === "prod",
        cluster: `${clusterId}-cluster`,
        user: `${clusterId}-admin`,
        server: cluster?.server ?? "",
        namespace: cluster?.namespace ?? null,
        auth: "Client certificate",
        certExpires: cluster?.certExpires ?? null,
        skipTLSVerify: false,
        ca: "Embedded",
        sharedWith: [],
        yaml: `contexts:\n  - name: ${clusterId}\n    context:\n      cluster: ${clusterId}-cluster\n      user: ${clusterId}-admin\nusers:\n  - name: ${clusterId}-admin\n    user:\n      client-certificate-data: <1180 characters, base64>\n      client-key-data: <hidden>\n`,
      };
    },
    async removeContext(clusterId: string) {
      return { file: "/home/dev/.kube/config", backup: "/home/dev/.kube/config.podgaze-preview.bak", removed: [`context ${clusterId}`] };
    },
    async updateContext(clusterId: string, change: ContextEdit): Promise<ContextSaved> {
      const cluster = clusters.find((item) => item.id === clusterId);
      if (cluster) {
        if (change.namespace !== undefined) cluster.namespace = change.namespace || null;
        if (change.server) cluster.server = change.server;
        if (change.name) {
          cluster.id = change.name;
          cluster.name = change.name;
        }
      }
      return { name: change.name ?? clusterId, file: "/home/dev/.kube/config", backup: "/home/dev/.kube/config.podgaze-preview.bak" };
    },
    async getGuards() {
      return { ...guards };
    },
    async setGuard(clusterId: string, guard: ContextGuard) {
      guards[clusterId] = guard;
      if (session.clusterId === clusterId) {
        session = { ...session, guard: { ...guard } };
        emit();
      }
    },
    async startDebug(request: DebugRequest) {
      return { container: `debugger-${request.pod.slice(0, 4)}` };
    },
    async readSecret() {
      return { ...previewSecret, values: previewSecret.values.slice() };
    },
    async writeSecret(request) {
      for (const key of request.remove) previewSecret.values = previewSecret.values.filter((item) => item.key !== key);
      for (const change of request.set) {
        const encoded = change.encoding === "text" ? btoa(unescape(encodeURIComponent(change.value))) : change.value.replace(/\s+/g, "");
        const value = change.encoding === "text" ? change.value : decodeURIComponent(escape(atob(encoded)));
        previewSecret.values = [...previewSecret.values.filter((item) => item.key !== change.key), { key: change.key, value, binary: false, encoded }].sort((left, right) => left.key.localeCompare(right.key));
      }
      previewSecret.resourceVersion = String(Number(previewSecret.resourceVersion) + 1);
      record({ action: "edit secret", target: `secret/${request.name}`, namespace: request.namespace, kubectl: `kubectl edit secret ${request.name} -n ${request.namespace}`, ok: true });
      return { ...previewSecret, values: previewSecret.values.slice() };
    },
    async openPortForward(request: PortForwardRequest) {
      return {
        id: "pf-preview",
        namespace: request.namespace,
        kind: request.kind ?? "Pod",
        pod: request.pod,
        remotePort: request.remotePort,
        localPort: request.localPort || 18080,
      };
    },
    async closePortForward() {},
    async listPortForwards() {
      return [];
    },
    async readUsage() {
      const gib = 1024 ** 3;
      const mib = 1024 ** 2;
      return {
        available: true,
        nodes: [{ name: "ip-10-0-4", namespace: "", cpuMillicores: 820, memoryBytes: 6 * gib }],
        pods: [
          { name: "api-7d9c", namespace: "default", cpuMillicores: 120, memoryBytes: 180 * mib },
          { name: "worker-2ab1", namespace: "default", cpuMillicores: 40, memoryBytes: 90 * mib },
          { name: "cache-11f0", namespace: "kube-system", cpuMillicores: 15, memoryBytes: 64 * mib },
        ],
      };
    },
    async listExecTargets(ref: ResourceRef): Promise<ExecTarget[]> {
      if (ref.kind === "Pod") return [{ namespace: ref.namespace || "default", pod: ref.name, containers: ["app"] }];
      return pods.map((pod) => ({ namespace: pod.namespace, pod: pod.name, containers: pod.containers.map((item) => item.name) }));
    },
    async openTerminal(request: TerminalRequest) {
      const id = `preview-${terminalSeq++}`;
      const banner = request.mode === "shell"
        ? "podgaze shell\r\n$ "
        : `exec ${request.pod} ${request.container}\r\n$ `;
      queueMicrotask(() => {
        for (const listener of terminalListeners) listener({ id, type: "data", data: banner });
      });
      terminalInputs.set(id, (data) => {
        for (const listener of terminalListeners) listener({ id, type: "data", data: data === "\r" ? "\r\n$ " : data });
      });
      return { id };
    },
    async writeTerminal(id: string, data: string) {
      terminalInputs.get(id)?.(data);
    },
    async resizeTerminal() {},
    async closeTerminal(id: string) {
      terminalInputs.delete(id);
    },
    onTerminal(listener: (event: TerminalEvent) => void) {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    onSession(listener) {
      sessions.add(listener);
      listener({ ...session, namespaces: session.namespaces.slice(), open: openList() });
      return () => sessions.delete(listener);
    },
  };
}

function previewRows(kind: ResourceKind): ResourceRow[] {
  return sampleRows(kind).map((row) => ({ labels: {}, ...row }) as ResourceRow);
}

function sampleRows(kind: ResourceKind): Omit<ResourceRow, "labels">[] {
  const ageStart = "2026-09-01T00:00:00.000Z";
  if (kind === "applications.argoproj.io") {
    return [
      { uid: "app-shop", kind, name: "shop", namespace: "argocd", status: "Healthy", ageStart, columns: { "sync-status": "Synced", "health-status": "Healthy" } },
      { uid: "app-payments", kind, name: "payments", namespace: "argocd", status: "Degraded, OutOfSync", ageStart, columns: { "sync-status": "OutOfSync", "health-status": "Degraded" } },
    ];
  }
  if (kind === "certificates.cert-manager.io") {
    return [{ uid: "cert-shop", kind, name: "shop-tls", namespace: "default", status: "Ready", ageStart, columns: { ready: "True", secret: "shop-tls" } }];
  }
  if (kind === "Secret") {
    return [{
      uid: "secret-payments",
      kind,
      name: "payments-api",
      namespace: "development",
      status: "Opaque",
      ageStart,
      columns: {
        keys: "connectionstring, encryption-key, oauth-client-secret, api-token",
        type: "Opaque",
      },
    }];
  }
  if (kind === "Service") {
    return [{
      uid: "svc-api",
      kind,
      name: "api",
      namespace: "default",
      status: "Active",
      ageStart,
      columns: { type: "ClusterIP", clusterIP: "10.96.0.12", ports: "80/TCP" },
    }];
  }
  if (kind === "Ingress") {
    return [{
      uid: "ing-shop",
      kind,
      name: "shop",
      namespace: "default",
      status: "Ready",
      ageStart,
      columns: { class: "nginx", hosts: "shop.example.com" },
    }];
  }
  if (kind === "Namespace") {
    return ["default", "kube-system", "shop"].map((name) => ({
      uid: `ns-${name}`,
      kind,
      name,
      namespace: "",
      status: "Active",
      ageStart,
      columns: {},
    }));
  }
  return [{
    uid: `${kind}-sample`,
    kind,
    name: kind.toLowerCase(),
    namespace: catalogNamespaced(kind) ? "default" : "",
    status: "Ready",
    ageStart,
    columns: {},
  }];
}

function catalogNamespaced(kind: ResourceKind): boolean {
  return kind !== "Node" && kind !== "Namespace" && kind !== "PersistentVolume" && kind !== "StorageClass" && kind !== "ClusterRole" && kind !== "ClusterRoleBinding";
}


function previewMap(): ResourceMap {
  const node = (kind: string, namespace: string, name: string, status: string, group: number) => ({ id: `${kind}/${namespace}/${name}`, kind, name, namespace, status, group });
  const nodes = [
    node("Ingress", "default", "shop", "Ready", 0),
    node("Service", "default", "api", "Active", 0),
    node("HorizontalPodAutoscaler", "default", "api", "Active", 0),
    node("Deployment", "default", "api", "Available", 0),
    node("ReplicaSet", "default", "api-7d9c", "Available", 0),
    node("Pod", "default", "api-7d9c", "Running", 0),
    node("Pod", "default", "api-7d9d", "Running", 0),
    node("Secret", "default", "api-secrets", "Opaque", 0),
    node("ConfigMap", "default", "settings", "Ready", 0),
    node("Secret", "default", "shop-tls", "kubernetes.io/tls", 0),
    node("Deployment", "default", "worker", "Progressing", 1),
    node("ReplicaSet", "default", "worker-2ab1", "Progressing", 1),
    node("Pod", "default", "worker-2ab1", "CrashLoopBackOff", 1),
    node("CronJob", "default", "nightly-report", "Active", 2),
    node("Job", "default", "nightly-report-2914", "Complete", 2),
    node("Pod", "default", "nightly-report-2914-x", "Completed", 2),
    node("Service", "kube-system", "cache", "Active", 3),
    node("StatefulSet", "kube-system", "cache", "Available", 3),
    node("Pod", "kube-system", "cache-11f0", "Running", 3),
    node("PersistentVolumeClaim", "kube-system", "data-cache-0", "Bound", 3),
  ];
  const edge = (from: string, to: string, relation: string) => ({ from, to, relation });
  return {
    nodes,
    edges: [
      edge("Ingress/default/shop", "Service/default/api", "routes to"),
      edge("Ingress/default/shop", "Secret/default/shop-tls", "TLS"),
      edge("Service/default/api", "Deployment/default/api", "routes to"),
      edge("HorizontalPodAutoscaler/default/api", "Deployment/default/api", "scales"),
      edge("Deployment/default/api", "ReplicaSet/default/api-7d9c", "owns"),
      edge("ReplicaSet/default/api-7d9c", "Pod/default/api-7d9c", "owns"),
      edge("ReplicaSet/default/api-7d9c", "Pod/default/api-7d9d", "owns"),
      edge("Deployment/default/api", "Secret/default/api-secrets", "reads"),
      edge("Deployment/default/api", "ConfigMap/default/settings", "mounts"),
      edge("Deployment/default/worker", "ReplicaSet/default/worker-2ab1", "owns"),
      edge("ReplicaSet/default/worker-2ab1", "Pod/default/worker-2ab1", "owns"),
      edge("Deployment/default/worker", "Secret/default/api-secrets", "reads"),
      edge("CronJob/default/nightly-report", "Job/default/nightly-report-2914", "owns"),
      edge("Job/default/nightly-report-2914", "Pod/default/nightly-report-2914-x", "owns"),
      edge("Service/kube-system/cache", "StatefulSet/kube-system/cache", "routes to"),
      edge("StatefulSet/kube-system/cache", "Pod/kube-system/cache-11f0", "owns"),
      edge("StatefulSet/kube-system/cache", "PersistentVolumeClaim/kube-system/data-cache-0", "mounts"),
    ],
    truncated: false,
  };
}

function previewArgo(): ArgoApp[] {
  const base = {
    namespace: "argocd", project: "default", healthMessage: "", destServer: "https://kubernetes.default.svc", autoSync: true,
    conditions: [] as { type: string; message: string }[], reconciledAt: new Date(Date.now() - 40_000).toISOString(),
    history: [
      { id: 12, revision: "4f1c2a9e7b", deployedAt: new Date(Date.now() - 3_600_000).toISOString(), source: "apps/shop" },
      { id: 11, revision: "8be00d1c44", deployedAt: new Date(Date.now() - 86_400_000).toISOString(), source: "apps/shop" },
      { id: 10, revision: "2a7f9d30e1", deployedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), source: "apps/shop" },
    ],
  };
  return [
    {
      ...base, name: "shop", sync: "Synced", health: "Healthy", repo: "https://github.com/example/deploy.git", path: "apps/shop", chart: "", targetRevision: "main", revision: "4f1c2a9e7b",
      destNamespace: "default", operation: { phase: "Succeeded", message: "successfully synced (all tasks run)", startedAt: new Date(Date.now() - 3_600_000).toISOString(), finishedAt: new Date(Date.now() - 3_590_000).toISOString() },
      resources: [
        { kind: "Service", group: "", name: "api", namespace: "default", sync: "Synced", health: "Healthy", message: "" },
        { kind: "Deployment", group: "apps", name: "api", namespace: "default", sync: "Synced", health: "Healthy", message: "" },
        { kind: "Ingress", group: "networking.k8s.io", name: "shop", namespace: "default", sync: "Synced", health: "Healthy", message: "" },
      ],
    },
    {
      ...base, name: "worker", sync: "OutOfSync", health: "Degraded", healthMessage: "Deployment worker has 0/1 ready pods", repo: "https://github.com/example/deploy.git", path: "apps/worker", chart: "", targetRevision: "main", revision: "9a0b7c1d2e",
      destNamespace: "default", autoSync: false,
      operation: { phase: "Failed", message: "one or more objects failed to apply: Deployment.apps \"worker\" is invalid", startedAt: new Date(Date.now() - 900_000).toISOString(), finishedAt: new Date(Date.now() - 880_000).toISOString() },
      conditions: [{ type: "SyncError", message: "Failed sync attempt to 9a0b7c1: one or more objects failed to apply" }],
      resources: [
        { kind: "Deployment", group: "apps", name: "worker", namespace: "default", sync: "OutOfSync", health: "Degraded", message: "Deployment does not have minimum availability." },
        { kind: "ConfigMap", group: "", name: "worker-config", namespace: "default", sync: "Synced", health: "", message: "" },
      ],
    },
    {
      ...base, name: "ingress-nginx", sync: "Synced", health: "Healthy", repo: "https://kubernetes.github.io/ingress-nginx", path: "", chart: "ingress-nginx", targetRevision: "4.11.2", revision: "4.11.2",
      destNamespace: "kube-system", operation: null,
      resources: [{ kind: "Deployment", group: "apps", name: "ingress-nginx-controller", namespace: "kube-system", sync: "Synced", health: "Healthy", message: "" }],
    },
  ];
}
