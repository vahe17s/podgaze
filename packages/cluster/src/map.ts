import type { MapEdge, MapNode, ResourceKind, ResourceMap } from "@podgaze/contracts";
import { selectorMatches, type LabelSelector } from "./manifest.js";
import { deploymentToRow, objectToRow, podToRow, type DeploymentLike, type PodLike } from "./project.js";
import { ingressServices, podReferences, type PodSpecLike } from "./related.js";

type Owner = { kind?: string; name?: string; uid?: string };

export type IstioKinds = { Gateway?: string; VirtualService?: string; DestinationRule?: string };

type Route = { destination?: { host?: string } };

export type MapObject = {
  kind?: string;
  type?: string;
  metadata?: { name?: string; namespace?: string; uid?: string; labels?: Record<string, string>; ownerReferences?: Owner[] };
  spec?: {
    replicas?: number;
    selector?: LabelSelector & Record<string, string>;
    template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpecLike };
    jobTemplate?: { spec?: { template?: { spec?: PodSpecLike } } };
    scaleTargetRef?: { kind?: string; name?: string };
    defaultBackend?: { service?: { name?: string } };
    rules?: { http?: { paths?: { backend?: { service?: { name?: string } } }[] } }[];
    tls?: { secretName?: string }[] & { route?: Route[] }[];
    // Istio
    gateways?: string[];
    http?: { route?: Route[] }[];
    tcp?: { route?: Route[] }[];
    host?: string;
  } & PodSpecLike;
  status?: { replicas?: number } & Record<string, unknown>;
};

export type MapInput = Partial<Record<
  "Ingress" | "Service" | "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Pod" | "Job" | "CronJob" | "HorizontalPodAutoscaler" | "ConfigMap" | "Secret" | "PersistentVolumeClaim"
  | "Gateway" | "VirtualService" | "DestinationRule",
  MapObject[]
>>;

// "reviews", "reviews.shop", and "reviews.shop.svc.cluster.local" all name Service reviews; anything longer is
// outside the cluster.
export function serviceForHost(host: string | undefined, namespace: string | undefined): { name: string; namespace: string | undefined } | null {
  if (!host || host.includes("*")) return null;
  const parts = host.replace(/\.svc(\.cluster\.local)?$/, "").split(".");
  if (parts.length > 2) return null;
  return { name: parts[0]!, namespace: parts[1] ?? namespace };
}

const MAX_NODES = 2500;
// Config and storage are leaves: one Secret used by ten apps must not glue them into one group.
const LEAF = new Set<ResourceKind>(["ConfigMap", "Secret", "PersistentVolumeClaim"]);

function idOf(kind: string, namespace: string | null | undefined, name: string): string {
  return `${kind}/${namespace ?? ""}/${name}`;
}

function statusOf(kind: ResourceKind, object: MapObject): string {
  if (kind === "Pod") return podToRow(object as PodLike)?.status ?? "";
  if (kind === "Deployment") return deploymentToRow(object as DeploymentLike)?.status ?? "";
  return objectToRow(kind, object)?.status ?? "";
}

// The object graph behind the map: who routes to whom, who owns whom, and what config each workload reads.
export function buildMap(input: MapInput, options: { labelSelector?: Record<string, string> | null; istio?: IstioKinds } = {}): ResourceMap {
  const istio = options.istio ?? {};
  // One Gateway fronts many apps; like shared config it must not glue them into one group.
  const isLeaf = (kind: ResourceKind) => LEAF.has(kind) || (istio.Gateway !== undefined && kind === istio.Gateway);
  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const edgeKeys = new Set<string>();
  const byUid = new Map<string, string>();
  const objects = new Map<string, MapObject>();

  function add(kind: ResourceKind, object: MapObject): string | null {
    const name = object.metadata?.name;
    if (!name) return null;
    const id = idOf(kind, object.metadata?.namespace, name);
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind, name, namespace: object.metadata?.namespace ?? null, status: statusOf(kind, object), group: -1 });
      objects.set(id, object);
      if (object.metadata?.uid) byUid.set(object.metadata.uid, id);
    }
    return id;
  }

  function link(from: string | null, to: string | null, relation: string) {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, relation });
  }

  const pods = input.Pod ?? [];
  // Old ReplicaSets left behind by rollouts own nothing and only add noise.
  const replicaSets = (input.ReplicaSet ?? []).filter((set) => (set.spec?.replicas ?? 0) > 0 || (set.status?.replicas ?? 0) > 0);

  for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job", "Ingress", "Service", "HorizontalPodAutoscaler"] as const) {
    for (const object of input[kind] ?? []) add(kind, object);
  }
  for (const set of replicaSets) add("ReplicaSet", set);
  for (const pod of pods) add("Pod", pod);

  // Ownership: Deployment → ReplicaSet → Pod, CronJob → Job → Pod, StatefulSet/DaemonSet → Pod.
  for (const [id, object] of objects) {
    for (const owner of object.metadata?.ownerReferences ?? []) {
      const parent = owner.uid ? byUid.get(owner.uid) : undefined;
      if (parent) link(parent, id, "owns");
    }
  }

  function topOwner(id: string): string {
    let current = id;
    for (let depth = 0; depth < 4; depth += 1) {
      const parent = edges.find((edge) => edge.to === current && edge.relation === "owns");
      if (!parent) break;
      current = parent.from;
    }
    return current;
  }

  // A Service points at the workloads behind its pods rather than at every pod, so the map stays readable.
  for (const service of input.Service ?? []) {
    const selector = service.spec?.selector as Record<string, string> | undefined;
    if (!selector || Object.keys(selector).length === 0) continue;
    const serviceId = idOf("Service", service.metadata?.namespace, service.metadata?.name ?? "");
    for (const pod of pods) {
      if (pod.metadata?.namespace !== service.metadata?.namespace) continue;
      if (!selectorMatches({ matchLabels: selector }, pod.metadata?.labels ?? {})) continue;
      link(serviceId, topOwner(idOf("Pod", pod.metadata?.namespace, pod.metadata?.name ?? "")), "routes to");
    }
  }

  for (const ingress of input.Ingress ?? []) {
    const ingressId = idOf("Ingress", ingress.metadata?.namespace, ingress.metadata?.name ?? "");
    for (const name of ingressServices(ingress)) {
      const target = idOf("Service", ingress.metadata?.namespace, name);
      if (nodes.has(target)) link(ingressId, target, "routes to");
    }
  }

  if (istio.Gateway) for (const gateway of input.Gateway ?? []) add(istio.Gateway, gateway);
  if (istio.DestinationRule) {
    for (const rule of input.DestinationRule ?? []) {
      const id = add(istio.DestinationRule, rule);
      const target = serviceForHost(rule.spec?.host, rule.metadata?.namespace);
      if (target) {
        const service = idOf("Service", target.namespace, target.name);
        if (nodes.has(service)) link(id, service, "configures");
      }
    }
  }
  if (istio.VirtualService) {
    for (const route of input.VirtualService ?? []) {
      const id = add(istio.VirtualService, route);
      const namespace = route.metadata?.namespace;
      for (const gateway of route.spec?.gateways ?? []) {
        if (gateway === "mesh" || !istio.Gateway) continue;
        const [gatewayNamespace, gatewayName] = gateway.includes("/") ? gateway.split("/") : [namespace, gateway];
        const gatewayId = idOf(istio.Gateway, gatewayNamespace, gatewayName ?? "");
        if (nodes.has(gatewayId)) link(gatewayId, id, "routes to");
      }
      const routes = [...(route.spec?.http ?? []), ...(route.spec?.tcp ?? []), ...((route.spec?.tls as { route?: Route[] }[] | undefined) ?? [])];
      for (const destination of routes.flatMap((item) => item.route ?? [])) {
        const target = serviceForHost(destination.destination?.host, namespace);
        if (!target) continue;
        const service = idOf("Service", target.namespace, target.name);
        if (nodes.has(service)) link(id, service, "routes to");
      }
    }
  }

  for (const hpa of input.HorizontalPodAutoscaler ?? []) {
    const target = hpa.spec?.scaleTargetRef;
    if (!target?.kind || !target.name) continue;
    link(idOf("HorizontalPodAutoscaler", hpa.metadata?.namespace, hpa.metadata?.name ?? ""), idOf(target.kind, hpa.metadata?.namespace, target.name), "scales");
  }

  // Config and storage, attached to the workload that declares them (or to a bare pod), and only when used.
  const config = new Map<string, MapObject>();
  for (const kind of ["ConfigMap", "Secret", "PersistentVolumeClaim"] as const) {
    for (const object of input[kind] ?? []) config.set(idOf(kind, object.metadata?.namespace, object.metadata?.name ?? ""), object);
  }
  function attach(fromId: string, namespace: string | undefined, spec: PodSpecLike | undefined) {
    for (const reference of podReferences(spec)) {
      if (!LEAF.has(reference.kind)) continue;
      const id = idOf(reference.kind, namespace, reference.name);
      const object = config.get(id);
      if (!object) continue;
      add(reference.kind, object);
      link(fromId, id, reference.relation === "Volume" ? "mounts" : "reads");
    }
  }
  for (const kind of ["Deployment", "StatefulSet", "DaemonSet", "Job"] as const) {
    for (const object of input[kind] ?? []) {
      if (kind === "Job" && (object.metadata?.ownerReferences ?? []).some((owner) => owner.kind === "CronJob")) continue;
      attach(idOf(kind, object.metadata?.namespace, object.metadata?.name ?? ""), object.metadata?.namespace, object.spec?.template?.spec);
    }
  }
  for (const cron of input.CronJob ?? []) {
    attach(idOf("CronJob", cron.metadata?.namespace, cron.metadata?.name ?? ""), cron.metadata?.namespace, cron.spec?.jobTemplate?.spec?.template?.spec);
  }
  for (const pod of pods) {
    const id = idOf("Pod", pod.metadata?.namespace, pod.metadata?.name ?? "");
    if (topOwner(id) === id) attach(id, pod.metadata?.namespace, pod.spec);
  }
  for (const ingress of input.Ingress ?? []) {
    for (const tls of ingress.spec?.tls ?? []) {
      const id = idOf("Secret", ingress.metadata?.namespace, tls.secretName ?? "");
      const object = config.get(id);
      if (!object) continue;
      add("Secret", object);
      link(idOf("Ingress", ingress.metadata?.namespace, ingress.metadata?.name ?? ""), id, "TLS");
    }
  }

  // A label selector narrows the map to matching objects and everything directly tied to them.
  if (options.labelSelector && Object.keys(options.labelSelector).length > 0) {
    const keep = new Set<string>();
    const queue: string[] = [];
    for (const [id, object] of objects) {
      if (selectorMatches({ matchLabels: options.labelSelector }, object.metadata?.labels ?? {})) {
        keep.add(id);
        queue.push(id);
      }
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (isLeaf(nodes.get(id)!.kind)) continue;
      for (const edge of edges) {
        const next = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
        if (next && !keep.has(next)) {
          keep.add(next);
          queue.push(next);
        }
      }
    }
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
  }

  // Groups: connected parts of the graph, walking only through non-leaf nodes.
  const groupOf = new Map<string, number>();
  let next = 0;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const order = [...nodes.values()].sort((left, right) => rank(left.kind) - rank(right.kind) || left.name.localeCompare(right.name));
  for (const node of order) {
    if (groupOf.has(node.id) || isLeaf(node.kind)) continue;
    const group = next++;
    const stack = [node.id];
    groupOf.set(node.id, group);
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const neighbour of adjacency.get(id) ?? []) {
        if (groupOf.has(neighbour)) continue;
        groupOf.set(neighbour, group);
        if (!isLeaf(nodes.get(neighbour)!.kind)) stack.push(neighbour);
      }
    }
  }
  for (const node of nodes.values()) node.group = groupOf.get(node.id) ?? next++;

  const kept = [...nodes.values()];
  const truncated = kept.length > MAX_NODES;
  const shown = truncated ? kept.slice(0, MAX_NODES) : kept;
  const ids = new Set(shown.map((node) => node.id));
  return { nodes: shown, edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), truncated };
}

function rank(kind: ResourceKind): number {
  const order: string[] = ["Ingress", "Service", "Deployment", "StatefulSet", "DaemonSet", "CronJob", "HorizontalPodAutoscaler", "Job", "ReplicaSet", "Pod"];
  const index = order.indexOf(kind);
  return index < 0 ? order.length : index;
}

// "app=api,tier!=x" style selectors are not needed here; projects use simple equality labels.
export function parseEqualitySelector(text: string | undefined): Record<string, string> | null {
  if (!text?.trim()) return null;
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const [key, value] = part.split("=").map((item) => item.trim());
    if (!key || value === undefined) throw new Error(`"${part.trim()}" is not a key=value label.`);
    out[key] = value;
  }
  return out;
}
