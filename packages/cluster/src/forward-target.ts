import { AppsV1Api, CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import type { PortForwardRequest } from "@podgaze/contracts";
import { selectorString, type LabelSelector } from "./manifest.js";

type PodLike = {
  metadata?: { name?: string; deletionTimestamp?: unknown };
  spec?: { containers?: { ports?: { name?: string; containerPort?: number }[] }[] };
  status?: { phase?: string; conditions?: { type?: string; status?: string }[] };
};

type ServicePort = { port?: number; targetPort?: number | string };

// A pod that can take traffic right now: running, ready, and not on its way out.
export function pickPod<T extends PodLike>(pods: T[]): T | null {
  const live = pods.filter((pod) => pod.status?.phase === "Running" && !pod.metadata?.deletionTimestamp);
  const ready = live.find((pod) => pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"));
  return ready ?? live[0] ?? null;
}

// Maps a Service port to the container port on the chosen pod, following named target ports.
export function containerPortFor(ports: ServicePort[] | undefined, servicePort: number, pod: PodLike): number {
  const match = (ports ?? []).find((item) => item.port === servicePort);
  const target = match?.targetPort ?? servicePort;
  if (typeof target === "number") return target;
  const numeric = Number(target);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  for (const container of pod.spec?.containers ?? []) {
    const named = (container.ports ?? []).find((port) => port.name === target);
    if (named?.containerPort) return named.containerPort;
  }
  throw new Error(`No container port is named ${target}.`);
}

export function createForwardResolver(kc: KubeConfig) {
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);

  async function podFor(namespace: string, selector: LabelSelector | undefined): Promise<PodLike> {
    const query = selectorString(selector);
    if (!query) throw new Error("This object has no pod selector to forward to.");
    const list = await core.listNamespacedPod({ namespace, labelSelector: query });
    const pod = pickPod((list.items ?? []) as PodLike[]);
    if (!pod?.metadata?.name) throw new Error("No running pod behind it right now.");
    return pod;
  }

  return async function resolve(request: PortForwardRequest): Promise<{ pod: string; port: number }> {
    const kind = request.kind ?? "Pod";
    if (kind === "Pod") return { pod: request.pod, port: request.remotePort };
    if (kind === "Service") {
      const service = await core.readNamespacedService({ name: request.pod, namespace: request.namespace });
      const pod = await podFor(request.namespace, { matchLabels: service.spec?.selector });
      return { pod: pod.metadata!.name!, port: containerPortFor(service.spec?.ports as ServicePort[] | undefined, request.remotePort, pod) };
    }
    const workload = kind === "Deployment"
      ? await apps.readNamespacedDeployment({ name: request.pod, namespace: request.namespace })
      : await apps.readNamespacedStatefulSet({ name: request.pod, namespace: request.namespace });
    const pod = await podFor(request.namespace, workload.spec?.selector as LabelSelector | undefined);
    return { pod: pod.metadata!.name!, port: request.remotePort };
  };
}
