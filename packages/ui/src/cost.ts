import { cpuMillicores, memoryBytes, type NodeRow, type PodRow, type Resources, type VolumeInfo } from "@podgaze/contracts";

export const HOURS_PER_MONTH = 730;
const GIB = 1024 ** 3;
// OpenCost's default list prices, used only for the ratio between a core and a GiB when splitting a node's price.
const CORE_WEIGHT = 0.031611;
const GIB_WEIGHT = 0.004237;

export type NodePricing = {
  node: string;
  instanceType: string;
  region: string;
  spot: boolean;
  key: string;
  hourly: number | null;
};

export type WorkloadCost = {
  name: string;
  kind: string;
  pods: number;
  cpuMillicores: number;
  memoryBytes: number;
  hourly: number;
  // What the pods actually used, from metrics samples; null until there are samples for any of its pods.
  usedCpuMillicores: number | null;
  usedMemoryBytes: number | null;
  usedHourly: number | null;
  storageBytes: number;
  storageHourly: number;
};
export type NamespaceCost = {
  namespace: string;
  hourly: number;
  cpuMillicores: number;
  memoryBytes: number;
  usedCpuMillicores: number | null;
  usedMemoryBytes: number | null;
  usedHourly: number | null;
  storageBytes: number;
  storageHourly: number;
  workloads: WorkloadCost[];
};

export type StorageClassCost = { name: string; claims: number; bytes: number; perGibMonth: number | null; hourly: number };

export type CostReport = {
  nodes: NodePricing[];
  // Node cost after the discount.
  totalHourly: number;
  allocatedHourly: number;
  idleHourly: number;
  usedHourly: number | null;
  storageHourly: number;
  storage: StorageClassCost[];
  discount: number;
  // Instance types with no price yet: their nodes and pods count as zero until one is entered.
  unpriced: string[];
  unpricedClasses: string[];
  namespaces: NamespaceCost[];
};

export type CostOptions = {
  // Percent off list price for nodes: reservations, savings plans, enterprise agreements.
  discount?: number;
  // What a pod actually uses, averaged over recent samples; null when there are none.
  usageOf?: (pod: PodRow) => Resources | null;
  volumes?: VolumeInfo[];
  // USD per GiB per month, by storage class.
  storagePrices?: Record<string, number>;
};

export function priceKey(region: string, instanceType: string, spot: boolean): string {
  return `${region || "any"}/${instanceType || "unknown"}${spot ? "/spot" : ""}`;
}

export function nodePricing(node: NodeRow, prices: Record<string, number>): NodePricing {
  const labels = node.labels;
  const instanceType = labels["node.kubernetes.io/instance-type"] ?? labels["beta.kubernetes.io/instance-type"] ?? "";
  const region = labels["topology.kubernetes.io/region"] ?? labels["failure-domain.beta.kubernetes.io/region"] ?? "";
  const spot = labels["kubernetes.azure.com/scalesetpriority"] === "spot"
    || labels["eks.amazonaws.com/capacityType"] === "SPOT"
    || labels["karpenter.sh/capacity-type"] === "spot"
    || labels["cloud.google.com/gke-spot"] === "true"
    || labels["cloud.google.com/gke-preemptible"] === "true";
  const key = priceKey(region, instanceType, spot);
  return { node: node.name, instanceType, region, spot, key, hourly: prices[key] ?? null };
}

// A ReplicaSet's pod belongs to the Deployment whose name it carries before the template hash.
export function workloadOf(pod: PodRow): { kind: string; name: string } {
  const [kind, ...rest] = (pod.controlledBy || `Pod/${pod.name}`).split("/");
  const name = rest.join("/");
  if (kind === "ReplicaSet") {
    const hash = pod.labels?.["pod-template-hash"];
    return { kind: "Deployment", name: hash && name.endsWith(`-${hash}`) ? name.slice(0, -hash.length - 1) : name.replace(/-[a-z0-9]{6,10}$/, "") };
  }
  if (kind === "Job" && /-\d{8,}$/.test(name)) return { kind: "CronJob", name: name.replace(/-\d{8,}$/, "") };
  return { kind: kind ?? "Pod", name };
}

// Pods pay for what they request, at their node's price per core and per GiB. What nobody requests is idle.
// Usage is priced at the same rates, so "used" and "requested" can be compared in money.
export function costReport(pods: PodRow[], nodes: NodeRow[], prices: Record<string, number>, options: CostOptions = {}): CostReport {
  const discount = Math.min(95, Math.max(0, options.discount ?? 0));
  const factor = 1 - discount / 100;
  const pricing = nodes.map((node) => nodePricing(node, prices));
  const rates = new Map<string, { core: number; gib: number }>();
  let totalHourly = 0;
  nodes.forEach((node, index) => {
    const list = pricing[index]!.hourly;
    if (list === null) return;
    const hourly = list * factor;
    totalHourly += hourly;
    const cores = cpuMillicores(node.cpu) / 1000;
    const gib = memoryBytes(node.memory) / GIB;
    const weight = cores * CORE_WEIGHT + gib * GIB_WEIGHT;
    if (weight <= 0) return;
    const scale = hourly / weight;
    rates.set(node.name, { core: CORE_WEIGHT * scale, gib: GIB_WEIGHT * scale });
  });

  const byNamespace = new Map<string, NamespaceCost>();
  const namespaceOf = (name: string) => {
    let found = byNamespace.get(name);
    if (!found) {
      found = { namespace: name, hourly: 0, cpuMillicores: 0, memoryBytes: 0, usedCpuMillicores: null, usedMemoryBytes: null, usedHourly: null, storageBytes: 0, storageHourly: 0, workloads: [] };
      byNamespace.set(name, found);
    }
    return found;
  };
  const workloadIndex = new Map<string, WorkloadCost>();
  const workloadIn = (namespace: NamespaceCost, owner: { kind: string; name: string }) => {
    const key = `${namespace.namespace}\u0000${owner.kind}\u0000${owner.name}`;
    let workload = workloadIndex.get(key);
    if (!workload) {
      workload = { ...owner, pods: 0, cpuMillicores: 0, memoryBytes: 0, hourly: 0, usedCpuMillicores: null, usedMemoryBytes: null, usedHourly: null, storageBytes: 0, storageHourly: 0 };
      namespace.workloads.push(workload);
      workloadIndex.set(key, workload);
    }
    return workload;
  };
  const add = (value: number | null, more: number) => (value ?? 0) + more;

  let allocatedHourly = 0;
  let usedHourly: number | null = null;
  const podOwner = new Map<string, { kind: string; name: string }>();
  for (const pod of pods) {
    podOwner.set(`${pod.namespace}/${pod.name}`, workloadOf(pod));
    if (!pod.nodeName || /Succeeded|Failed|Completed/.test(pod.status)) continue;
    const rate = rates.get(pod.nodeName);
    const price = (resources: Resources) => (rate ? (resources.cpuMillicores / 1000) * rate.core + (resources.memoryBytes / GIB) * rate.gib : 0);
    const hourly = price(pod.requests);
    allocatedHourly += hourly;
    const namespace = namespaceOf(pod.namespace);
    namespace.hourly += hourly;
    namespace.cpuMillicores += pod.requests.cpuMillicores;
    namespace.memoryBytes += pod.requests.memoryBytes;
    const workload = workloadIn(namespace, workloadOf(pod));
    workload.pods += 1;
    workload.cpuMillicores += pod.requests.cpuMillicores;
    workload.memoryBytes += pod.requests.memoryBytes;
    workload.hourly += hourly;
    const used = options.usageOf?.(pod) ?? null;
    if (used) {
      const usedPrice = price(used);
      usedHourly = add(usedHourly, usedPrice);
      for (const target of [namespace, workload]) {
        target.usedCpuMillicores = add(target.usedCpuMillicores, used.cpuMillicores);
        target.usedMemoryBytes = add(target.usedMemoryBytes, used.memoryBytes);
        target.usedHourly = add(target.usedHourly, usedPrice);
      }
    }
  }

  // Storage: each claim at its class's price, charged to the workload that mounts it, or on its own when unused.
  const classes = new Map<string, StorageClassCost>();
  let storageHourly = 0;
  for (const volume of options.volumes ?? []) {
    const perGibMonth = options.storagePrices?.[volume.storageClass] ?? null;
    const hourly = perGibMonth === null ? 0 : ((volume.sizeBytes / GIB) * perGibMonth) / HOURS_PER_MONTH;
    const entry = classes.get(volume.storageClass) ?? { name: volume.storageClass, claims: 0, bytes: 0, perGibMonth, hourly: 0 };
    entry.claims += 1;
    entry.bytes += volume.sizeBytes;
    entry.hourly += hourly;
    classes.set(volume.storageClass, entry);
    storageHourly += hourly;
    const namespace = namespaceOf(volume.namespace);
    namespace.storageBytes += volume.sizeBytes;
    namespace.storageHourly += hourly;
    const owner = volume.usedBy.map((pod) => podOwner.get(`${volume.namespace}/${pod}`)).find(Boolean) ?? { kind: "PersistentVolumeClaim", name: volume.name };
    const workload = workloadIn(namespace, owner);
    workload.storageBytes += volume.sizeBytes;
    workload.storageHourly += hourly;
  }

  const total = (item: { hourly: number; storageHourly: number }) => item.hourly + item.storageHourly;
  const namespaces = [...byNamespace.values()]
    .map((item) => ({ ...item, workloads: item.workloads.sort((left, right) => total(right) - total(left)) }))
    .sort((left, right) => total(right) - total(left) || left.namespace.localeCompare(right.namespace));
  const unpriced = [...new Set(pricing.filter((item) => item.hourly === null).map((item) => item.key))].sort();
  const storage = [...classes.values()].sort((left, right) => right.bytes - left.bytes);
  return {
    nodes: pricing,
    totalHourly,
    allocatedHourly,
    idleHourly: Math.max(0, totalHourly - allocatedHourly),
    usedHourly,
    storageHourly,
    storage,
    discount,
    unpriced,
    unpricedClasses: storage.filter((item) => item.perGibMonth === null).map((item) => item.name),
    namespaces,
  };
}

const PRICES_KEY = "podgaze.prices";

export function loadPrices(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PRICES_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 0));
  } catch {
    return {};
  }
}

export function savePrices(prices: Record<string, number>) {
  try {
    localStorage.setItem(PRICES_KEY, JSON.stringify(prices));
  } catch {
    // Prices last for this run.
  }
}

const DISCOUNT_KEY = "podgaze.costDiscount";
const STORAGE_KEY = "podgaze.storagePrices";

function readNumber(key: string): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function loadDiscount(): number {
  return Math.min(95, Math.max(0, readNumber(DISCOUNT_KEY)));
}

export function saveDiscount(percent: number) {
  try {
    localStorage.setItem(DISCOUNT_KEY, String(Math.min(95, Math.max(0, percent))));
  } catch {
    // Lasts for this run.
  }
}

export function loadStoragePrices(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 0));
  } catch {
    return {};
  }
}

export function saveStoragePrices(prices: Record<string, number>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prices));
  } catch {
    // Lasts for this run.
  }
}

// Mean of recent samples for a pod, which is what "uses" means on the cost page.
export function averageUsage(samples: { cpuMillicores: number; memoryBytes: number }[]): Resources | null {
  if (samples.length === 0) return null;
  return {
    cpuMillicores: samples.reduce((sum, sample) => sum + sample.cpuMillicores, 0) / samples.length,
    memoryBytes: samples.reduce((sum, sample) => sum + sample.memoryBytes, 0) / samples.length,
  };
}

export function money(hourly: number, per: "month" | "hour" = "month"): string {
  const value = per === "month" ? hourly * HOURS_PER_MONTH : hourly;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: per === "hour" ? 3 : 0, maximumFractionDigits: per === "hour" ? 3 : 0 })}`;
}
