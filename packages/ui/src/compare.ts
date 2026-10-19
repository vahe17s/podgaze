import { parse } from "yaml";

type Container = {
  name?: string;
  image?: string;
  command?: string[];
  args?: string[];
  ports?: { containerPort?: number; protocol?: string }[];
  env?: { name?: string; value?: string; valueFrom?: { secretKeyRef?: { name?: string; key?: string }; configMapKeyRef?: { name?: string; key?: string }; fieldRef?: { fieldPath?: string }; resourceFieldRef?: { resource?: string } } }[];
  envFrom?: { secretRef?: { name?: string }; configMapRef?: { name?: string }; prefix?: string }[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  volumeMounts?: { name?: string; mountPath?: string; readOnly?: boolean }[];
};

type Probe = { httpGet?: { path?: string; port?: number | string }; tcpSocket?: { port?: number | string }; exec?: { command?: string[] }; initialDelaySeconds?: number; periodSeconds?: number };

type Manifest = {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: {
    replicas?: number;
    paused?: boolean;
    strategy?: { type?: string };
    updateStrategy?: { type?: string };
    template?: {
      metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
      spec?: {
        serviceAccountName?: string;
        nodeSelector?: Record<string, string>;
        tolerations?: unknown[];
        affinity?: unknown;
        containers?: Container[];
        initContainers?: Container[];
        volumes?: Volume[];
      };
    };
  };
};

export type Fact = { section: string; field: string; value: string };

const NOISY_LABELS = new Set(["pod-template-hash", "controller-revision-hash", "statefulset.kubernetes.io/pod-name"]);

function probe(value: Probe | undefined): string {
  if (!value) return "";
  const how = value.httpGet ? `GET ${value.httpGet.path ?? "/"} :${value.httpGet.port ?? ""}` : value.tcpSocket ? `TCP :${value.tcpSocket.port ?? ""}` : value.exec ? `exec ${(value.exec.command ?? []).join(" ")}` : "custom";
  return `${how}${value.initialDelaySeconds ? ` after ${value.initialDelaySeconds}s` : ""}${value.periodSeconds ? ` every ${value.periodSeconds}s` : ""}`;
}

function envValue(env: NonNullable<Container["env"]>[number]): string {
  const from = env.valueFrom;
  if (from?.secretKeyRef) return `secret ${from.secretKeyRef.name}/${from.secretKeyRef.key}`;
  if (from?.configMapKeyRef) return `configmap ${from.configMapKeyRef.name}/${from.configMapKeyRef.key}`;
  if (from?.fieldRef) return `field ${from.fieldRef.fieldPath}`;
  if (from?.resourceFieldRef) return `resource ${from.resourceFieldRef.resource}`;
  return env.value ?? "";
}

type Volume = { name?: string; configMap?: { name?: string }; secret?: { secretName?: string }; persistentVolumeClaim?: { claimName?: string }; emptyDir?: unknown; projected?: unknown };

function volumeSource(volume: Volume): string {
  if (volume.configMap) return `configmap ${volume.configMap.name}`;
  if (volume.secret) return `secret ${volume.secret.secretName}`;
  if (volume.persistentVolumeClaim) return `pvc ${volume.persistentVolumeClaim.claimName}`;
  if (volume.emptyDir) return "emptyDir";
  if (volume.projected) return "projected";
  return "other";
}

// The settings that usually explain "why does prod behave differently": images, replicas, env, resources,
// probes, and what is mounted. Status and generated fields are left out on purpose.
export function workloadFacts(yaml: string): Fact[] {
  const manifest = (parse(yaml) ?? {}) as Manifest;
  const facts: Fact[] = [];
  const add = (section: string, field: string, value: unknown) => {
    const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    if (text !== "") facts.push({ section, field, value: text });
  };
  const spec = manifest.spec ?? {};
  const pod = spec.template?.spec ?? {};
  add("Workload", "Replicas", spec.replicas ?? 1);
  add("Workload", "Update strategy", spec.strategy?.type ?? spec.updateStrategy?.type);
  if (spec.paused) add("Workload", "Paused", "yes");
  add("Workload", "Service account", pod.serviceAccountName);
  add("Workload", "Node selector", Object.entries(pod.nodeSelector ?? {}).map(([key, value]) => `${key}=${value}`).join(", "));
  if (pod.tolerations?.length) add("Workload", "Tolerations", `${pod.tolerations.length}`);
  if (pod.affinity) add("Workload", "Affinity", "set");
  for (const container of [...(pod.initContainers ?? []).map((item) => ({ ...item, init: true })), ...(pod.containers ?? []).map((item) => ({ ...item, init: false }))]) {
    const section = `${container.init ? "Init container" : "Container"} ${container.name ?? ""}`;
    add(section, "Image", container.image);
    add(section, "Command", [...(container.command ?? []), ...(container.args ?? [])].join(" "));
    add(section, "CPU request", container.resources?.requests?.cpu);
    add(section, "CPU limit", container.resources?.limits?.cpu);
    add(section, "Memory request", container.resources?.requests?.memory);
    add(section, "Memory limit", container.resources?.limits?.memory);
    add(section, "Ports", (container.ports ?? []).map((port) => `${port.containerPort}/${port.protocol ?? "TCP"}`).join(", "));
    add(section, "Liveness probe", probe(container.livenessProbe));
    add(section, "Readiness probe", probe(container.readinessProbe));
    for (const env of container.env ?? []) if (env.name) add(section, `env ${env.name}`, envValue(env));
    for (const source of container.envFrom ?? []) {
      const name = source.secretRef ? `secret ${source.secretRef.name}` : `configmap ${source.configMapRef?.name}`;
      add(section, `envFrom ${name}`, source.prefix ? `prefix ${source.prefix}` : "all keys");
    }
    for (const mount of container.volumeMounts ?? []) {
      const volume = (pod.volumes ?? []).find((item) => item.name === mount.name);
      add(section, `mount ${mount.mountPath}`, `${volume ? volumeSource(volume) : mount.name}${mount.readOnly ? " (ro)" : ""}`);
    }
  }
  for (const [key, value] of Object.entries(spec.template?.metadata?.labels ?? manifest.metadata?.labels ?? {})) {
    if (!NOISY_LABELS.has(key)) add("Labels", key, value);
  }
  return facts;
}

export type CompareRow = { section: string; field: string; values: string[]; differs: boolean };

export function compareFacts(columns: Fact[][]): CompareRow[] {
  const order: string[] = [];
  const rows = new Map<string, CompareRow>();
  columns.forEach((facts, column) => {
    for (const fact of facts) {
      const key = `${fact.section}\u0000${fact.field}`;
      if (!rows.has(key)) {
        order.push(key);
        rows.set(key, { section: fact.section, field: fact.field, values: columns.map(() => ""), differs: false });
      }
      rows.get(key)!.values[column] = fact.value;
    }
  });
  const sections = [...new Set(order.map((key) => rows.get(key)!.section))];
  // Sections keep their first-seen order; within each, fields stay in manifest order.
  return sections.flatMap((section) => order.filter((key) => rows.get(key)!.section === section).map((key) => {
    const row = rows.get(key)!;
    row.differs = new Set(row.values).size > 1;
    return row;
  }));
}

const ENV_SUFFIX = /-(dev|develop|development|stage|staging|stg|qa|uat|test|prod|production|prd|preprod)$/i;

// "checkout-api-production" and "checkout-api-development" are the same app in two environments.
export function appBase(name: string): string {
  return name.replace(ENV_SUFFIX, "");
}

export function splitImage(image: string): { repo: string; tag: string } {
  const withoutDigest = image.split("@")[0]!;
  const digest = image.includes("@") ? image.slice(image.indexOf("@") + 1, image.indexOf("@") + 20) : "";
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  if (colon > slash) return { repo: withoutDigest.slice(0, colon), tag: withoutDigest.slice(colon + 1) + (digest ? `@${digest}` : "") };
  return { repo: withoutDigest, tag: digest ? `@${digest}` : "latest" };
}
