import type { KubernetesObjectApi } from "@kubernetes/client-node";
import { apiKindOf, catalogEntry, type RelatedRef, type ResourceKind, type ResourceRef } from "@podgaze/contracts";
import { statusOf } from "./batch.js";
import { selectorMatches, selectorString, type LabelSelector } from "./manifest.js";
import { deploymentToRow, objectToRow, podToRow, type DeploymentLike, type PodLike } from "./project.js";

type Owner = { kind?: string; name?: string; uid?: string; controller?: boolean };

type Container = {
  env?: { valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } } }[];
  envFrom?: { configMapRef?: { name?: string }; secretRef?: { name?: string } }[];
};

type Projection = { configMap?: { name?: string }; secret?: { name?: string } };

export type PodSpecLike = {
  nodeName?: string;
  serviceAccountName?: string;
  containers?: Container[];
  initContainers?: Container[];
  imagePullSecrets?: { name?: string }[];
  volumes?: {
    configMap?: { name?: string };
    secret?: { secretName?: string };
    persistentVolumeClaim?: { claimName?: string };
    projected?: { sources?: Projection[] };
  }[];
};

type Loose = {
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    ownerReferences?: Owner[];
  };
  spec?: {
    selector?: LabelSelector & Record<string, string>;
    podSelector?: LabelSelector;
    template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpecLike };
    jobTemplate?: { spec?: { template?: { spec?: PodSpecLike } } };
    serviceName?: string;
    volumeName?: string;
    storageClassName?: string;
    claimRef?: { name?: string; namespace?: string };
    scaleTargetRef?: { kind?: string; name?: string };
    defaultBackend?: { service?: { name?: string } };
    rules?: { http?: { paths?: { backend?: { service?: { name?: string } } }[] } }[];
    tls?: { secretName?: string }[];
  } & PodSpecLike;
  subsets?: { addresses?: { targetRef?: { kind?: string; name?: string; namespace?: string } }[] }[];
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  roleRef?: { kind?: string; name?: string };
  subjects?: { kind?: string; name?: string; namespace?: string }[];
  secrets?: { name?: string }[];
};

const LIMIT = 60;

// Every ConfigMap, Secret, PVC and ServiceAccount a pod spec points at.
export function podReferences(spec: PodSpecLike | undefined): { kind: ResourceKind; name: string; relation: string }[] {
  if (!spec) return [];
  const found: { kind: ResourceKind; name: string; relation: string }[] = [];
  const add = (kind: ResourceKind, name: string | undefined, relation: string) => {
    if (name && !found.some((item) => item.kind === kind && item.name === name)) found.push({ kind, name, relation });
  };
  for (const container of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    for (const env of container.env ?? []) {
      add("ConfigMap", env.valueFrom?.configMapKeyRef?.name, "Env");
      add("Secret", env.valueFrom?.secretKeyRef?.name, "Env");
    }
    for (const source of container.envFrom ?? []) {
      add("ConfigMap", source.configMapRef?.name, "Env");
      add("Secret", source.secretRef?.name, "Env");
    }
  }
  for (const volume of spec.volumes ?? []) {
    add("ConfigMap", volume.configMap?.name, "Volume");
    add("Secret", volume.secret?.secretName, "Volume");
    add("PersistentVolumeClaim", volume.persistentVolumeClaim?.claimName, "Volume");
    for (const source of volume.projected?.sources ?? []) {
      add("ConfigMap", source.configMap?.name, "Volume");
      add("Secret", source.secret?.name, "Volume");
    }
  }
  for (const secret of spec.imagePullSecrets ?? []) add("Secret", secret.name, "Image pull");
  add("ServiceAccount", spec.serviceAccountName, "Service account");
  return found;
}

export function ingressServices(ingress: Loose): string[] {
  const names = new Set<string>();
  if (ingress.spec?.defaultBackend?.service?.name) names.add(ingress.spec.defaultBackend.service.name);
  for (const rule of ingress.spec?.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      if (path.backend?.service?.name) names.add(path.backend.service.name);
    }
  }
  return [...names];
}

function statusFor(kind: ResourceKind, object: unknown): string | undefined {
  if (kind === "Pod") return podToRow(object as PodLike)?.status;
  if (kind === "Deployment") return deploymentToRow(object as DeploymentLike)?.status;
  if (kind === "Node") return undefined;
  return objectToRow(kind, object)?.status;
}

function known(kind: string | undefined): kind is ResourceKind {
  return Boolean(kind && catalogEntry(kind));
}

export function createRelatedLookup(objects: KubernetesObjectApi) {
  async function read(kind: ResourceKind, namespace: string | null, name: string): Promise<Loose | null> {
    const entry = catalogEntry(kind)!;
    try {
      return (await objects.read({
        apiVersion: entry.apiVersion,
        // Custom kinds are keyed by plural.group in Podgaze; the API wants the real Kind.
        kind: apiKindOf(entry),
        metadata: { name, ...(entry.namespaced && namespace ? { namespace } : {}) },
      })) as Loose;
    } catch (error) {
      const code = statusOf(error);
      if (code === 404 || code === 403) return null;
      throw error;
    }
  }

  async function list(kind: ResourceKind, namespace: string | null, options: { labelSelector?: string; fieldSelector?: string } = {}): Promise<Loose[]> {
    const entry = catalogEntry(kind)!;
    try {
      const result = await objects.list(
        entry.apiVersion,
        apiKindOf(entry),
        entry.namespaced ? namespace ?? undefined : undefined,
        undefined,
        undefined,
        undefined,
        options.fieldSelector,
        options.labelSelector,
        500,
      );
      return (result.items ?? []) as Loose[];
    } catch (error) {
      // An account that cannot list a kind just does not see those relations.
      if (statusOf(error) === 403 || statusOf(error) === 404) return [];
      throw error;
    }
  }

  return async function related(ref: ResourceRef): Promise<RelatedRef[]> {
    const entry = catalogEntry(ref.kind);
    if (!entry) return [];
    const namespace = entry.namespaced ? ref.namespace || "default" : null;
    const self = await read(ref.kind, namespace, ref.name);
    if (!self) return [];
    // Each list starts once and is shared, so the lists this kind needs can all start right away below while
    // the code further down still reads them one by one and keeps its order.
    const lists = new Map<string, Promise<Loose[]>>();
    const listed = (kind: ResourceKind, ns: string | null, options: { labelSelector?: string; fieldSelector?: string } = {}) => {
      const key = JSON.stringify([kind, ns, options.labelSelector ?? null, options.fieldSelector ?? null]);
      let pending = lists.get(key);
      if (!pending) {
        pending = list(kind, ns, options);
        // Read later or not at all; a failure still reaches whoever awaits it.
        pending.catch(() => undefined);
        lists.set(key, pending);
      }
      return pending;
    };
    const workload = ref.kind === "Deployment" || ref.kind === "StatefulSet" || ref.kind === "DaemonSet" || ref.kind === "ReplicaSet" || ref.kind === "Job";
    if (workload) {
      const query = selectorString(self.spec?.selector) ?? undefined;
      if (ref.kind === "Deployment") void listed("ReplicaSet", namespace, { labelSelector: query });
      if (query) void listed("Pod", namespace, { labelSelector: query });
      if (namespace) void listed("Service", namespace);
      if (ref.kind !== "Job" && ref.kind !== "DaemonSet") void listed("HorizontalPodAutoscaler", namespace);
    } else if (ref.kind === "Pod" && namespace) {
      void listed("Service", namespace);
    } else if (ref.kind === "PersistentVolumeClaim" || ref.kind === "ConfigMap" || ref.kind === "Secret" || ref.kind === "ServiceAccount") {
      void listed("Pod", namespace);
    }
    const out: RelatedRef[] = [];
    const push = (kind: ResourceKind, ns: string | null, name: string | undefined, relation: string, object?: unknown) => {
      if (!name) return;
      const scoped = catalogEntry(kind)?.namespaced ? ns : null;
      if (kind === ref.kind && name === ref.name && scoped === namespace) return;
      if (out.some((item) => item.kind === kind && item.name === name && item.namespace === scoped && item.relation === relation)) return;
      out.push({ kind, namespace: scoped, name, relation, status: object ? statusFor(kind, object) : undefined });
    };
    const pushAll = (kind: ResourceKind, items: Loose[], relation: string) => {
      for (const item of items.slice(0, LIMIT)) push(kind, item.metadata?.namespace ?? namespace, item.metadata?.name, relation, item);
    };

    async function owners(object: Loose, depth: number) {
      const list = object.metadata?.ownerReferences ?? [];
      const sorted = [...list].sort((left, right) => Number(Boolean(right.controller)) - Number(Boolean(left.controller)));
      for (const owner of sorted) {
        if (!known(owner.kind) || !owner.name) continue;
        const parent = await read(owner.kind, namespace, owner.name);
        push(owner.kind, namespace, owner.name, depth === 0 ? "Owner" : "Owner's owner", parent ?? undefined);
        if (parent && depth < 2) await owners(parent, depth + 1);
      }
    }

    async function servicesFor(labels: Record<string, string> | undefined) {
      if (!labels || !namespace) return;
      const services = await listed("Service", namespace);
      pushAll("Service", services.filter((service) => selectorMatches({ matchLabels: service.spec?.selector as Record<string, string> | undefined }, labels)), "Service");
    }

    async function hpasFor(kind: string, name: string) {
      const hpas = await listed("HorizontalPodAutoscaler", namespace);
      pushAll("HorizontalPodAutoscaler", hpas.filter((hpa) => hpa.spec?.scaleTargetRef?.kind === kind && hpa.spec.scaleTargetRef.name === name), "Autoscaler");
    }

    function references(spec: PodSpecLike | undefined) {
      for (const item of podReferences(spec)) push(item.kind, namespace, item.name, item.relation);
    }

    async function podsBySelector(selector: LabelSelector | undefined, relation = "Pod") {
      const query = selectorString(selector);
      if (!query) return;
      pushAll("Pod", await listed("Pod", namespace, { labelSelector: query }), relation);
    }

    async function podsUsing(test: (spec: PodSpecLike | undefined) => boolean) {
      const pods = await listed("Pod", namespace);
      pushAll("Pod", pods.filter((pod) => test(pod.spec)), "Used by pod");
    }

    await owners(self, 0);
    const kind = ref.kind;

    if (kind === "Pod") {
      if (self.spec?.nodeName) push("Node", null, self.spec.nodeName, "Node");
      await servicesFor(self.metadata?.labels);
      references(self.spec);
    } else if (kind === "Deployment" || kind === "StatefulSet" || kind === "DaemonSet" || kind === "ReplicaSet" || kind === "Job") {
      if (kind === "Deployment") {
        const sets = await listed("ReplicaSet", namespace, { labelSelector: selectorString(self.spec?.selector) ?? undefined });
        pushAll("ReplicaSet", sets.filter((set) => (set.metadata?.ownerReferences ?? []).some((owner) => owner.uid === self.metadata?.uid)), "Replica set");
      }
      await podsBySelector(self.spec?.selector);
      await servicesFor(self.spec?.template?.metadata?.labels);
      if (kind === "StatefulSet" && self.spec?.serviceName) push("Service", namespace, self.spec.serviceName, "Governing service");
      if (kind !== "Job" && kind !== "DaemonSet") await hpasFor(kind, ref.name);
      references(self.spec?.template?.spec);
    } else if (kind === "CronJob") {
      const jobs = await listed("Job", namespace);
      pushAll("Job", jobs.filter((job) => (job.metadata?.ownerReferences ?? []).some((owner) => owner.uid === self.metadata?.uid)), "Job");
      references(self.spec?.jobTemplate?.spec?.template?.spec);
    } else if (kind === "Service") {
      const selector = self.spec?.selector as Record<string, string> | undefined;
      if (selector && Object.keys(selector).length > 0) await podsBySelector({ matchLabels: selector });
      push("Endpoints", namespace, ref.name, "Endpoints");
      const ingresses = await listed("Ingress", namespace);
      pushAll("Ingress", ingresses.filter((ingress) => ingressServices(ingress).includes(ref.name)), "Ingress");
    } else if (kind === "Endpoints") {
      push("Service", namespace, ref.name, "Service");
      for (const subset of self.subsets ?? []) {
        for (const address of subset.addresses ?? []) {
          if (address.targetRef?.kind === "Pod") push("Pod", address.targetRef.namespace ?? namespace, address.targetRef.name, "Endpoint");
        }
      }
    } else if (kind === "Ingress") {
      for (const name of ingressServices(self)) push("Service", namespace, name, "Backend");
      for (const tls of self.spec?.tls ?? []) push("Secret", namespace, tls.secretName, "TLS");
    } else if (kind === "PersistentVolumeClaim") {
      push("PersistentVolume", null, self.spec?.volumeName, "Volume");
      push("StorageClass", null, self.spec?.storageClassName, "Storage class");
      await podsUsing((spec) => (spec?.volumes ?? []).some((volume) => volume.persistentVolumeClaim?.claimName === ref.name));
    } else if (kind === "PersistentVolume") {
      push("PersistentVolumeClaim", self.spec?.claimRef?.namespace ?? null, self.spec?.claimRef?.name, "Claim");
      push("StorageClass", null, self.spec?.storageClassName, "Storage class");
    } else if (kind === "ConfigMap" || kind === "Secret") {
      await podsUsing((spec) => podReferences(spec).some((item) => item.kind === kind && item.name === ref.name));
    } else if (kind === "ServiceAccount") {
      await podsUsing((spec) => (spec?.serviceAccountName ?? "default") === ref.name);
      for (const secret of self.secrets ?? []) push("Secret", namespace, secret.name, "Token");
    } else if (kind === "HorizontalPodAutoscaler") {
      const target = self.spec?.scaleTargetRef;
      if (known(target?.kind)) push(target.kind, namespace, target.name, "Scales");
    } else if (kind === "RoleBinding" || kind === "ClusterRoleBinding") {
      if (self.roleRef?.kind === "Role") push("Role", namespace, self.roleRef.name, "Role");
      if (self.roleRef?.kind === "ClusterRole") push("ClusterRole", null, self.roleRef.name, "Role");
      for (const subject of self.subjects ?? []) {
        if (subject.kind === "ServiceAccount") push("ServiceAccount", subject.namespace ?? namespace, subject.name, "Subject");
      }
    } else if (kind === "NetworkPolicy") {
      await podsBySelector(self.spec?.podSelector, "Selects");
    } else if (kind === "Node") {
      pushAll("Pod", await listed("Pod", null, { fieldSelector: `spec.nodeName=${ref.name}` }), "Runs here");
    } else if (kind === "Event") {
      const involved = self.involvedObject;
      if (known(involved?.kind)) push(involved.kind, involved.namespace ?? namespace, involved.name, "About");
    }
    return out;
  };
}
