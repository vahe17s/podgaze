export type CommandName =
  | "describe"
  | "logs"
  | "logs-previous"
  | "events"
  | "rollout-status"
  | "rollout-history"
  | "rollout-restart"
  | "rollout-undo"
  | "scale"
  | "cordon"
  | "uncordon"
  | "drain"
  | "trigger"
  | "suspend"
  | "resume"
  | "rollout-pause"
  | "rollout-resume"
  | "set-image"
  | "force-delete"
  | "evict"
  | "rerun"
  | "delete";

// Commands that change the cluster. A read-only context refuses these.
export const mutatingCommands: ReadonlySet<CommandName> = new Set<CommandName>([
  "rollout-restart",
  "rollout-undo",
  "scale",
  "cordon",
  "uncordon",
  "drain",
  "trigger",
  "suspend",
  "resume",
  "rollout-pause",
  "rollout-resume",
  "set-image",
  "force-delete",
  "evict",
  "rerun",
  "delete",
]);

export type BuiltinKind =
  | "Pod"
  | "Deployment"
  | "DaemonSet"
  | "StatefulSet"
  | "ReplicaSet"
  | "Job"
  | "CronJob"
  | "Service"
  | "Endpoints"
  | "Ingress"
  | "NetworkPolicy"
  | "ConfigMap"
  | "Secret"
  | "PersistentVolumeClaim"
  | "PersistentVolume"
  | "StorageClass"
  | "ServiceAccount"
  | "Role"
  | "RoleBinding"
  | "ClusterRole"
  | "ClusterRoleBinding"
  | "Node"
  | "Namespace"
  | "Event"
  | "HorizontalPodAutoscaler";

// Built-in kinds by name; custom resources by "<plural>.<group>", which stays unique when two CRDs share a Kind.
export type ResourceKind = BuiltinKind | (string & {});

export type CatalogColumn = {
  key: string;
  header: string;
  width: string;
  status?: boolean;
  age?: boolean;
};

export type PrinterColumn = { key: string; jsonPath: string };

export type CatalogEntry = {
  kind: ResourceKind;
  group: "Workloads" | "Network" | "Configuration" | "Storage" | "Access" | "Cluster" | "Custom";
  label: string;
  namespaced: boolean;
  apiVersion: string;
  plural: string;
  columns: CatalogColumn[];
  commands: CommandName[];
  // Custom resources only: the Kubernetes Kind, the API group shown in the sidebar, and the CRD's printer columns.
  apiKind?: string;
  apiGroup?: string;
  printerColumns?: PrinterColumn[];
};

const describeEvents: CommandName[] = ["describe", "events", "delete"];
const workloadRollout: CommandName[] = ["describe", "events", "rollout-status", "rollout-history", "rollout-restart", "rollout-undo", "rollout-pause", "rollout-resume", "scale", "set-image", "delete"];

export const catalog: CatalogEntry[] = [
  { kind: "Pod", group: "Workloads", label: "Pods", namespaced: true, apiVersion: "v1", plural: "pods", columns: [], commands: ["describe", "logs", "logs-previous", "events", "rollout-status", "rollout-history", "rollout-restart", "evict", "delete", "force-delete"] },
  { kind: "Deployment", group: "Workloads", label: "Deployments", namespaced: true, apiVersion: "apps/v1", plural: "deployments", columns: [], commands: workloadRollout },
  { kind: "DaemonSet", group: "Workloads", label: "Daemon Sets", namespaced: true, apiVersion: "apps/v1", plural: "daemonsets", columns: [{ key: "ready", header: "Ready", width: "0.6fr" }, { key: "nodeSelector", header: "Node selector", width: "1fr" }], commands: ["describe", "events", "rollout-status", "rollout-restart", "set-image", "delete"] },
  { kind: "StatefulSet", group: "Workloads", label: "Stateful Sets", namespaced: true, apiVersion: "apps/v1", plural: "statefulsets", columns: [{ key: "ready", header: "Ready", width: "0.6fr" }, { key: "service", header: "Service", width: "0.8fr" }], commands: ["describe", "events", "rollout-status", "rollout-restart", "scale", "set-image", "delete"] },
  { kind: "ReplicaSet", group: "Workloads", label: "Replica Sets", namespaced: true, apiVersion: "apps/v1", plural: "replicasets", columns: [{ key: "ready", header: "Ready", width: "0.6fr" }, { key: "owners", header: "Owner", width: "1fr" }], commands: ["describe", "events", "scale", "delete"] },
  { kind: "Job", group: "Workloads", label: "Jobs", namespaced: true, apiVersion: "batch/v1", plural: "jobs", columns: [{ key: "completions", header: "Completions", width: "0.7fr" }], commands: ["describe", "events", "rerun", "suspend", "resume", "delete"] },
  { kind: "CronJob", group: "Workloads", label: "Cron Jobs", namespaced: true, apiVersion: "batch/v1", plural: "cronjobs", columns: [{ key: "schedule", header: "Schedule", width: "0.8fr" }, { key: "suspend", header: "Suspend", width: "0.5fr" }, { key: "lastSchedule", header: "Last run", width: "0.5fr", age: true }], commands: ["describe", "events", "trigger", "suspend", "resume", "delete"] },
  { kind: "Service", group: "Network", label: "Services", namespaced: true, apiVersion: "v1", plural: "services", columns: [{ key: "type", header: "Type", width: "0.6fr" }, { key: "clusterIP", header: "Cluster IP", width: "0.8fr" }, { key: "ports", header: "Ports", width: "1fr" }], commands: describeEvents },
  { kind: "Endpoints", group: "Network", label: "Endpoints", namespaced: true, apiVersion: "v1", plural: "endpoints", columns: [{ key: "addresses", header: "Addresses", width: "1.2fr" }], commands: describeEvents },
  { kind: "Ingress", group: "Network", label: "Ingresses", namespaced: true, apiVersion: "networking.k8s.io/v1", plural: "ingresses", columns: [{ key: "class", header: "Class", width: "0.6fr" }, { key: "hosts", header: "Hosts", width: "1.2fr" }], commands: describeEvents },
  { kind: "NetworkPolicy", group: "Network", label: "Network Policies", namespaced: true, apiVersion: "networking.k8s.io/v1", plural: "networkpolicies", columns: [{ key: "selector", header: "Pod selector", width: "1.2fr" }], commands: describeEvents },
  { kind: "ConfigMap", group: "Configuration", label: "Config Maps", namespaced: true, apiVersion: "v1", plural: "configmaps", columns: [{ key: "keys", header: "Data", width: "1.2fr" }], commands: describeEvents },
  { kind: "Secret", group: "Configuration", label: "Secrets", namespaced: true, apiVersion: "v1", plural: "secrets", columns: [{ key: "type", header: "Type", width: "1fr" }, { key: "keys", header: "Data", width: "0.8fr" }], commands: describeEvents },
  { kind: "HorizontalPodAutoscaler", group: "Configuration", label: "Horizontal Pod Autoscalers", namespaced: true, apiVersion: "autoscaling/v2", plural: "horizontalpodautoscalers", columns: [{ key: "reference", header: "Target", width: "1fr" }, { key: "replicas", header: "Replicas", width: "0.7fr" }], commands: describeEvents },
  { kind: "PersistentVolumeClaim", group: "Storage", label: "Persistent Volume Claims", namespaced: true, apiVersion: "v1", plural: "persistentvolumeclaims", columns: [{ key: "volume", header: "Volume", width: "0.8fr" }, { key: "capacity", header: "Capacity", width: "0.6fr" }, { key: "class", header: "Class", width: "0.7fr" }], commands: describeEvents },
  { kind: "PersistentVolume", group: "Storage", label: "Persistent Volumes", namespaced: false, apiVersion: "v1", plural: "persistentvolumes", columns: [{ key: "capacity", header: "Capacity", width: "0.6fr" }, { key: "reclaim", header: "Reclaim", width: "0.6fr" }, { key: "class", header: "Class", width: "0.7fr" }], commands: describeEvents },
  { kind: "StorageClass", group: "Storage", label: "Storage Classes", namespaced: false, apiVersion: "storage.k8s.io/v1", plural: "storageclasses", columns: [{ key: "provisioner", header: "Provisioner", width: "1fr" }, { key: "reclaim", header: "Reclaim", width: "0.6fr" }], commands: describeEvents },
  { kind: "ServiceAccount", group: "Access", label: "Service Accounts", namespaced: true, apiVersion: "v1", plural: "serviceaccounts", columns: [], commands: describeEvents },
  { kind: "Role", group: "Access", label: "Roles", namespaced: true, apiVersion: "rbac.authorization.k8s.io/v1", plural: "roles", columns: [{ key: "rules", header: "Rules", width: "0.4fr" }], commands: describeEvents },
  { kind: "RoleBinding", group: "Access", label: "Role Bindings", namespaced: true, apiVersion: "rbac.authorization.k8s.io/v1", plural: "rolebindings", columns: [{ key: "role", header: "Role", width: "1fr" }], commands: describeEvents },
  { kind: "ClusterRole", group: "Access", label: "Cluster Roles", namespaced: false, apiVersion: "rbac.authorization.k8s.io/v1", plural: "clusterroles", columns: [{ key: "rules", header: "Rules", width: "0.4fr" }], commands: describeEvents },
  { kind: "ClusterRoleBinding", group: "Access", label: "Cluster Role Bindings", namespaced: false, apiVersion: "rbac.authorization.k8s.io/v1", plural: "clusterrolebindings", columns: [{ key: "role", header: "Role", width: "1fr" }], commands: describeEvents },
  { kind: "Node", group: "Cluster", label: "Nodes", namespaced: false, apiVersion: "v1", plural: "nodes", columns: [], commands: ["describe", "events", "cordon", "uncordon", "drain", "delete"] },
  { kind: "Namespace", group: "Cluster", label: "Namespaces", namespaced: false, apiVersion: "v1", plural: "namespaces", columns: [], commands: describeEvents },
  { kind: "Event", group: "Cluster", label: "Events", namespaced: true, apiVersion: "v1", plural: "events", columns: [{ key: "reason", header: "Reason", width: "0.7fr" }, { key: "object", header: "Object", width: "1fr" }, { key: "message", header: "Message", width: "1.6fr" }, { key: "lastSeen", header: "Last seen", width: "0.5fr", age: true }, { key: "count", header: "Count", width: "0.4fr" }], commands: describeEvents },
];

export const catalogGroups = ["Workloads", "Network", "Configuration", "Storage", "Access", "Cluster"] as const;

let customEntries: CatalogEntry[] = [];

// Each process registers the CRDs of the clusters it talks to; the session sends them to the window.
// Entries merge by kind, so a second open cluster does not erase the first one's.
export function registerCustomKinds(entries: CatalogEntry[]) {
  const byKind = new Map(customEntries.map((entry) => [entry.kind, entry]));
  for (const entry of entries) byKind.set(entry.kind, entry);
  customEntries = [...byKind.values()];
}

export function customKinds(): CatalogEntry[] {
  return customEntries;
}

export function catalogEntry(kind: string): CatalogEntry | undefined {
  return catalog.find((item) => item.kind === kind) ?? customEntries.find((item) => item.kind === kind);
}

// Finds the entry for a Kind as the API reports it (an event's involvedObject, an owner reference).
export function entryForApiKind(apiKind: string, apiVersion?: string): CatalogEntry | undefined {
  const builtin = catalog.find((item) => item.kind === apiKind);
  if (builtin) return builtin;
  const group = apiVersion?.includes("/") ? apiVersion.split("/")[0] : undefined;
  return customEntries.find((item) => item.apiKind === apiKind && (!group || item.apiGroup === group));
}

// The Kind the API expects in a request body.
export function apiKindOf(entry: CatalogEntry): string {
  return entry.apiKind ?? entry.kind;
}

export function resourcePath(entry: CatalogEntry, namespace: string | null): string {
  const root = entry.apiVersion.includes("/") ? `/apis/${entry.apiVersion}` : `/api/${entry.apiVersion}`;
  if (entry.namespaced && namespace) return `${root}/namespaces/${encodeURIComponent(namespace)}/${entry.plural}`;
  return `${root}/${entry.plural}`;
}

const kubectlNames: Record<BuiltinKind, string> = {
  Pod: "pod",
  Deployment: "deployment",
  DaemonSet: "daemonset",
  StatefulSet: "statefulset",
  ReplicaSet: "replicaset",
  Job: "job",
  CronJob: "cronjob",
  Service: "service",
  Endpoints: "endpoints",
  Ingress: "ingress",
  NetworkPolicy: "networkpolicy",
  ConfigMap: "configmap",
  Secret: "secret",
  PersistentVolumeClaim: "pvc",
  PersistentVolume: "pv",
  StorageClass: "storageclass",
  ServiceAccount: "serviceaccount",
  Role: "role",
  RoleBinding: "rolebinding",
  ClusterRole: "clusterrole",
  ClusterRoleBinding: "clusterrolebinding",
  Node: "node",
  Namespace: "namespace",
  Event: "event",
  HorizontalPodAutoscaler: "hpa",
};

export function kubectlName(kind: ResourceKind): string {
  const builtin = kubectlNames[kind as BuiltinKind];
  if (builtin) return builtin;
  const entry = catalogEntry(kind);
  return entry?.apiGroup ? `${entry.plural}.${entry.apiGroup}` : kind.toLowerCase();
}

const execKinds = new Set<string>(["Pod", "Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "Job", "CronJob"]);

export function canExec(kind: string): boolean {
  return execKinds.has(kind);
}
