import { catalogEntry, cpuMillicores, memoryBytes, type ContainerSnap, type DeploymentRow, type NodeRow, type PodRow, type ResourceKind, type ResourceRow, type Resources } from "@podgaze/contracts";
import { evaluatePath } from "./jsonpath.js";

type TimeValue = Date | string | undefined;

type Owner = { kind?: string; name?: string; controller?: boolean };

export type PodLike = {
  metadata?: {
    uid?: string;
    name?: string;
    namespace?: string;
    creationTimestamp?: TimeValue;
    ownerReferences?: Owner[];
    labels?: Record<string, string>;
  };
  spec?: {
    nodeName?: string;
    containers?: {
      name?: string;
      image?: string;
      ports?: { containerPort?: number; protocol?: string }[];
      resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    }[];
  };
  status?: {
    phase?: string;
    podIP?: string;
    qosClass?: string;
    containerStatuses?: {
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: {
        waiting?: { reason?: string };
        running?: object;
        terminated?: { reason?: string; exitCode?: number };
      };
      lastState?: {
        terminated?: { reason?: string; exitCode?: number };
      };
    }[];
  };
};

export type NodeLike = {
  metadata?: {
    uid?: string;
    name?: string;
    creationTimestamp?: TimeValue;
    labels?: Record<string, string>;
  };
  spec?: {
    unschedulable?: boolean;
  };
  status?: {
    conditions?: { type?: string; status?: string }[];
    addresses?: { type?: string; address?: string }[];
    capacity?: Record<string, string>;
    nodeInfo?: { kubeletVersion?: string; osImage?: string; containerRuntimeVersion?: string };
  };
};

export type DeploymentLike = {
  metadata?: {
    uid?: string;
    name?: string;
    namespace?: string;
    creationTimestamp?: TimeValue;
    labels?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
    paused?: boolean;
    template?: { spec?: { containers?: { image?: string }[] } };
  };
  status?: {
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    readyReplicas?: number;
    conditions?: { type?: string; status?: string; reason?: string }[];
  };
};

// Totals for one resource field over all containers. Values Kubernetes accepts but this cannot read count as 0.
export function containerTotals(containers: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[], field: "requests" | "limits"): Resources {
  return containers.reduce<Resources>((sum, container) => {
    const values = container.resources?.[field] ?? {};
    return {
      cpuMillicores: sum.cpuMillicores + (values.cpu ? cpuMillicores(values.cpu) || 0 : 0),
      memoryBytes: sum.memoryBytes + (values.memory ? memoryBytes(values.memory) || 0 : 0),
    };
  }, { cpuMillicores: 0, memoryBytes: 0 });
}

function iso(value: TimeValue): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function controller(owners: Owner[] | undefined): string {
  const owner = owners?.find((item) => item.controller) ?? owners?.[0];
  if (!owner?.kind || !owner.name) return "";
  return `${owner.kind}/${owner.name}`;
}

function containerState(status: {
  state?: { waiting?: { reason?: string }; running?: object; terminated?: { reason?: string } };
} | undefined): string {
  const state = status?.state;
  return state?.waiting?.reason || (state?.running ? "Running" : state?.terminated?.reason || "Waiting");
}

type ExitStatus = NonNullable<NonNullable<PodLike["status"]>["containerStatuses"]>[number];

// The reason the most-restarted container last stopped, the first thing to check on a crash loop.
export function lastExit(statuses: ExitStatus[]): string {
  const ranked = [...statuses].sort((left, right) => (right.restartCount ?? 0) - (left.restartCount ?? 0));
  for (const status of ranked) {
    const ended = status.lastState?.terminated ?? status.state?.terminated;
    if (!ended) continue;
    const code = ended.exitCode;
    if (ended.reason === "Completed" && code === 0) continue;
    const reason = ended.reason || "Exited";
    return code === undefined ? reason : `${reason} (${code})`;
  }
  return "";
}

export function podToRow(pod: PodLike): PodRow | null {
  const uid = pod.metadata?.uid;
  const name = pod.metadata?.name;
  if (!uid || !name) return null;

  const statuses = pod.status?.containerStatuses ?? [];
  const waiting = statuses.find((status) => status.state?.waiting?.reason);
  const readyCount = statuses.filter((status) => status.ready).length;
  const specContainers = pod.spec?.containers ?? [];
  const total = specContainers.length || statuses.length;
  const containers: ContainerSnap[] = specContainers.map((container) => {
    const status = statuses.find((item) => item.name === container.name) ?? statuses[0];
    return {
      name: container.name ?? "",
      image: container.image ?? "",
      ready: Boolean(status?.ready),
      restarts: status?.restartCount ?? 0,
      state: containerState(status),
    };
  });

  return {
    uid,
    name,
    namespace: pod.metadata?.namespace ?? "",
    status: waiting?.state?.waiting?.reason || pod.status?.phase || "Unknown",
    ready: `${readyCount}/${total}`,
    restarts: statuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
    nodeName: pod.spec?.nodeName ?? "",
    ageStart: iso(pod.metadata?.creationTimestamp),
    images: specContainers.map((container) => container.image ?? "").filter(Boolean),
    ip: pod.status?.podIP ?? "",
    qos: pod.status?.qosClass ?? "",
    controlledBy: controller(pod.metadata?.ownerReferences),
    ports: specContainers.flatMap((container) =>
      (container.ports ?? []).map((port) => `${port.containerPort ?? "?"}/${port.protocol ?? "TCP"}`),
    ),
    containers,
    lastExit: lastExit(statuses),
    labels: { ...(pod.metadata?.labels ?? {}) },
    requests: containerTotals(specContainers, "requests"),
    limits: containerTotals(specContainers, "limits"),
  };
}

export function nodeToRow(node: NodeLike): NodeRow | null {
  const uid = node.metadata?.uid;
  const name = node.metadata?.name;
  if (!uid || !name) return null;

  const ready = node.status?.conditions?.find((condition) => condition.type === "Ready");
  const roles = new Set<string>();
  for (const [key, value] of Object.entries(node.metadata?.labels ?? {})) {
    if (key.startsWith("node-role.kubernetes.io/")) roles.add(key.slice("node-role.kubernetes.io/".length));
    if (key === "kubernetes.io/role" && value) roles.add(value);
  }
  const capacity = node.status?.capacity ?? {};

  const unschedulable = Boolean(node.spec?.unschedulable);
  const health = ready?.status === "True" ? "Ready" : "NotReady";
  return {
    uid,
    name,
    status: unschedulable ? `${health},SchedulingDisabled` : health,
    unschedulable,
    roles: [...roles],
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? "",
    ageStart: iso(node.metadata?.creationTimestamp),
    internalIP: node.status?.addresses?.find((address) => address.type === "InternalIP")?.address ?? "",
    cpu: capacity.cpu ?? "",
    memory: capacity.memory ?? "",
    podCapacity: capacity.pods ?? "",
    os: node.status?.nodeInfo?.osImage ?? "",
    runtime: node.status?.nodeInfo?.containerRuntimeVersion ?? "",
    labels: { ...(node.metadata?.labels ?? {}) },
  };
}

export function deploymentToRow(deployment: DeploymentLike): DeploymentRow | null {
  const uid = deployment.metadata?.uid;
  const name = deployment.metadata?.name;
  if (!uid || !name) return null;
  const desired = deployment.spec?.replicas ?? deployment.status?.replicas ?? 0;
  const ready = deployment.status?.readyReplicas ?? 0;
  const updated = deployment.status?.updatedReplicas ?? 0;
  const available = deployment.status?.availableReplicas ?? 0;
  const availableCondition = deployment.status?.conditions?.find((condition) => condition.type === "Available");
  const progressing = deployment.status?.conditions?.find((condition) => condition.type === "Progressing");
  const status = available >= desired && desired > 0
    ? "Available"
    : progressing?.reason || (availableCondition?.status === "False" ? "Unavailable" : "Progressing");

  return {
    uid,
    name,
    namespace: deployment.metadata?.namespace ?? "",
    status,
    ready: `${ready}/${desired}`,
    updated: String(updated),
    available: String(available),
    ageStart: iso(deployment.metadata?.creationTimestamp),
    images: (deployment.spec?.template?.spec?.containers ?? []).map((container) => container.image ?? "").filter(Boolean),
    labels: { ...(deployment.metadata?.labels ?? {}) },
    paused: Boolean(deployment.spec?.paused),
  };
}

type LooseObject = {
  metadata?: {
    uid?: string;
    name?: string;
    namespace?: string;
    creationTimestamp?: TimeValue;
    ownerReferences?: { kind?: string; name?: string; controller?: boolean }[];
    labels?: Record<string, string>;
  };
  spec?: {
    type?: string;
    clusterIP?: string;
    schedule?: string;
    suspend?: boolean;
    replicas?: number;
    completions?: number;
    volumeName?: string;
    storageClassName?: string;
    serviceName?: string;
    provisioner?: string;
    persistentVolumeReclaimPolicy?: string;
    reclaimPolicy?: string;
    minReplicas?: number;
    maxReplicas?: number;
    ports?: { port?: number; protocol?: string }[];
    ingressClassName?: string;
    rules?: { host?: string }[];
    selector?: { matchLabels?: Record<string, string> };
    podSelector?: { matchLabels?: Record<string, string> };
    nodeSelector?: Record<string, string>;
    scaleTargetRef?: { kind?: string; name?: string };
    capacity?: Record<string, string>;
  };
  status?: {
    phase?: string;
    readyReplicas?: number;
    replicas?: number;
    numberReady?: number;
    desiredNumberScheduled?: number;
    succeeded?: number;
    capacity?: Record<string, string>;
    currentReplicas?: number;
    lastScheduleTime?: TimeValue;
  };
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: TimeValue;
  eventTime?: TimeValue;
  series?: { count?: number; lastObservedTime?: TimeValue };
  involvedObject?: { kind?: string; name?: string };
  data?: Record<string, string>;
  subsets?: { addresses?: unknown[] }[];
  rules?: unknown[];
  roleRef?: { kind?: string; name?: string };
  provisioner?: string;
  reclaimPolicy?: string;
};

function joinLabels(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {}).map(([key, value]) => `${key}=${value}`).join(", ");
}

function ownerText(metadata: LooseObject["metadata"]): string {
  const owners = metadata?.ownerReferences ?? [];
  const owner = owners.find((item) => item.controller) ?? owners[0];
  return owner?.kind && owner.name ? `${owner.kind}/${owner.name}` : "";
}

export function objectToRow(kind: ResourceKind, value: unknown): ResourceRow | null {
  const object = value as LooseObject;
  const name = object.metadata?.name;
  if (!name) return null;
  const columns: Record<string, string> = {};
  let status = object.status?.phase || "Ready";

  if (kind === "DaemonSet") {
    const ready = object.status?.numberReady ?? 0;
    const desired = object.status?.desiredNumberScheduled ?? 0;
    columns.ready = `${ready}/${desired}`;
    columns.nodeSelector = joinLabels(object.spec?.nodeSelector);
    status = desired > 0 && ready >= desired ? "Available" : "Progressing";
  } else if (kind === "StatefulSet" || kind === "ReplicaSet") {
    const ready = object.status?.readyReplicas ?? 0;
    const desired = object.spec?.replicas ?? object.status?.replicas ?? 0;
    columns.ready = `${ready}/${desired}`;
    columns.service = object.spec?.serviceName ?? "";
    columns.owners = ownerText(object.metadata);
    status = desired > 0 && ready >= desired ? "Available" : "Progressing";
  } else if (kind === "Job") {
    const done = object.status?.succeeded ?? 0;
    const total = object.spec?.completions ?? 1;
    columns.completions = `${done}/${total}`;
    columns.suspend = object.spec?.suspend ? "True" : "False";
    status = done >= total ? "Complete" : object.spec?.suspend ? "Suspended" : "Running";
  } else if (kind === "CronJob") {
    columns.schedule = object.spec?.schedule ?? "";
    columns.suspend = object.spec?.suspend ? "True" : "False";
    columns.lastSchedule = iso(object.status?.lastScheduleTime);
    status = object.spec?.suspend ? "Suspended" : "Active";
  } else if (kind === "Service") {
    columns.type = object.spec?.type ?? "ClusterIP";
    columns.clusterIP = object.spec?.clusterIP ?? "";
    columns.ports = (object.spec?.ports ?? []).map((port) => `${port.port ?? "?"}/${port.protocol ?? "TCP"}`).join(", ");
    status = "Active";
  } else if (kind === "Endpoints") {
    const addresses = (object.subsets ?? []).reduce((sum, subset) => sum + (subset.addresses?.length ?? 0), 0);
    columns.addresses = String(addresses);
    status = addresses > 0 ? "Ready" : "Empty";
  } else if (kind === "Ingress") {
    columns.class = object.spec?.ingressClassName ?? "";
    columns.hosts = (object.spec?.rules ?? []).map((rule) => rule.host ?? "").filter(Boolean).join(", ");
    status = columns.hosts ? "Ready" : "Pending";
  } else if (kind === "NetworkPolicy") {
    columns.selector = joinLabels(object.spec?.podSelector?.matchLabels);
    status = "Active";
  } else if (kind === "ConfigMap" || kind === "Secret") {
    columns.keys = Object.keys(object.data ?? {}).join(", ");
    columns.type = object.type ?? "";
    status = kind === "Secret" ? object.type || "Opaque" : "Ready";
  } else if (kind === "HorizontalPodAutoscaler") {
    columns.reference = object.spec?.scaleTargetRef ? `${object.spec.scaleTargetRef.kind}/${object.spec.scaleTargetRef.name}` : "";
    columns.replicas = `${object.spec?.minReplicas ?? 1}-${object.spec?.maxReplicas ?? ""}`;
    status = "Active";
  } else if (kind === "PersistentVolumeClaim") {
    columns.volume = object.spec?.volumeName ?? "";
    columns.capacity = object.status?.capacity?.storage ?? "";
    columns.class = object.spec?.storageClassName ?? "";
    status = object.status?.phase || "Pending";
  } else if (kind === "PersistentVolume") {
    columns.capacity = object.spec?.capacity?.storage ?? "";
    columns.reclaim = object.spec?.persistentVolumeReclaimPolicy ?? "";
    columns.class = object.spec?.storageClassName ?? "";
    status = object.status?.phase || "Pending";
  } else if (kind === "StorageClass") {
    columns.provisioner = object.provisioner ?? "";
    columns.reclaim = object.reclaimPolicy ?? "";
    status = "Ready";
  } else if (kind === "Role" || kind === "ClusterRole") {
    columns.rules = String(object.rules?.length ?? 0);
    status = "Ready";
  } else if (kind === "RoleBinding" || kind === "ClusterRoleBinding") {
    columns.role = object.roleRef ? `${object.roleRef.kind}/${object.roleRef.name}` : "";
    status = "Ready";
  } else if (kind === "Namespace") {
    status = object.status?.phase || "Active";
  } else if (kind === "Event") {
    columns.reason = object.reason ?? "";
    columns.object = object.involvedObject?.name ? `${object.involvedObject.kind}/${object.involvedObject.name}` : "";
    columns.message = object.message ?? "";
    columns.lastSeen = iso(object.series?.lastObservedTime ?? object.lastTimestamp ?? object.eventTime ?? object.metadata?.creationTimestamp);
    columns.count = String(object.series?.count ?? object.count ?? 1);
    status = object.type || "Normal";
  } else {
    const entry = catalogEntry(kind);
    if (entry?.printerColumns) {
      for (const column of entry.printerColumns) columns[column.key] = evaluatePath(value, column.jsonPath);
    }
    status = customStatus(value);
  }

  return {
    uid: object.metadata?.uid || `${kind}/${object.metadata?.namespace ?? ""}/${name}`,
    kind,
    name,
    namespace: object.metadata?.namespace ?? "",
    status,
    ageStart: iso(object.metadata?.creationTimestamp),
    columns,
    labels: { ...(object.metadata?.labels ?? {}) },
  };
}

type Condition = { type?: string; status?: string; reason?: string };

// Custom resources have no common status shape; these cover most operators (Argo, cert-manager, Flux, Crossplane).
export function customStatus(value: unknown): string {
  const status = (value as { status?: Record<string, unknown> }).status;
  if (!status || typeof status !== "object") return "Ready";
  const health = status.health as { status?: string } | undefined;
  if (health?.status) {
    const sync = (status.sync as { status?: string } | undefined)?.status;
    return sync && sync !== "Synced" ? `${health.status}, ${sync}` : health.status;
  }
  const conditions = Array.isArray(status.conditions) ? (status.conditions as Condition[]) : [];
  const ready = conditions.find((condition) => condition.type === "Ready" || condition.type === "Available" || condition.type === "Synced");
  if (ready) return ready.status === "True" ? "Ready" : ready.reason || "NotReady";
  if (typeof status.phase === "string" && status.phase) return status.phase;
  if (typeof status.state === "string" && status.state) return status.state;
  return "Ready";
}
