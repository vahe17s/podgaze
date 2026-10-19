import { kubectlName, type CommandRequest } from "@podgaze/contracts";

export type EventLine = {
  time: string;
  type: string;
  reason: string;
  source: string;
  message: string;
  count: number;
};

export type ContainerDetail = {
  name: string;
  image: string;
  ports: string[];
  state: string;
  ready: boolean;
  restarts: number;
};

export type PodDetail = {
  name: string;
  namespace: string;
  node: string;
  ip: string;
  qos: string;
  status: string;
  start: string;
  controlledBy: string;
  labels: Record<string, string>;
  containers: ContainerDetail[];
  conditions: { type: string; status: string }[];
};

export type NodeDetail = {
  name: string;
  roles: string[];
  labels: Record<string, string>;
  addresses: { type: string; address: string }[];
  conditions: { type: string; status: string }[];
  capacity: Record<string, string>;
  info: Record<string, string>;
};

export type DeploymentDetail = {
  name: string;
  namespace: string;
  replicas: number;
  updated: number;
  available: number;
  ready: number;
  strategy: string;
  selector: string;
  images: string[];
  conditions: { type: string; status: string; reason: string }[];
};

export type RolloutView = {
  name: string;
  desired: number;
  updated: number;
  available: number;
  observed: number;
};

export type RevisionView = {
  revision: number;
  cause: string;
};

function lines(pairs: [string, string][]): string {
  const width = pairs.reduce((max, [label]) => Math.max(max, label.length), 0);
  return pairs.map(([label, value]) => `${label.padEnd(width)}  ${value || "<none>"}`).join("\n");
}

function mapBlock(title: string, values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return `${title}:  <none>`;
  return [`${title}:`, ...entries.map(([key, value]) => `  ${key}=${value}`)].join("\n");
}

export function formatEvents(events: EventLine[]): string {
  if (events.length === 0) return "Events:  <none>";
  const rows = events.slice(-20).map((event) => {
    const count = event.count > 1 ? ` (x${event.count})` : "";
    return `${event.time || "?"}  ${event.type || "Normal"}  ${event.reason || "Event"}  ${event.source || ""}  ${event.message}${count}`;
  });
  return ["Events:", ...rows.map((row) => `  ${row}`)].join("\n");
}

export function describePod(pod: PodDetail, events: EventLine[]): string {
  const head = lines([
    ["Name", pod.name],
    ["Namespace", pod.namespace],
    ["Node", pod.node],
    ["IP", pod.ip],
    ["QoS Class", pod.qos],
    ["Status", pod.status],
    ["Start Time", pod.start],
    ["Controlled By", pod.controlledBy],
  ]);
  const containers = pod.containers.length
    ? [
        "Containers:",
        ...pod.containers.flatMap((container) => [
          `  ${container.name || "container"}:`,
          `    Image:     ${container.image || "<none>"}`,
          `    Ports:     ${container.ports.join(", ") || "<none>"}`,
          `    State:     ${container.state || "Waiting"}`,
          `    Ready:     ${container.ready ? "True" : "False"}`,
          `    Restarts:  ${container.restarts}`,
        ]),
      ].join("\n")
    : "Containers:  <none>";
  const conditions = pod.conditions.length
    ? ["Conditions:", ...pod.conditions.map((condition) => `  ${condition.type}  ${condition.status}`)].join("\n")
    : "Conditions:  <none>";
  return [head, mapBlock("Labels", pod.labels), containers, conditions, formatEvents(events)].join("\n\n");
}

export function describeNode(node: NodeDetail, events: EventLine[]): string {
  return [
    lines([
      ["Name", node.name],
      ["Roles", node.roles.join(", ")],
    ]),
    mapBlock("Labels", node.labels),
    node.addresses.length
      ? ["Addresses:", ...node.addresses.map((address) => `  ${address.type}  ${address.address}`)].join("\n")
      : "Addresses:  <none>",
    node.conditions.length
      ? ["Conditions:", ...node.conditions.map((condition) => `  ${condition.type}  ${condition.status}`)].join("\n")
      : "Conditions:  <none>",
    mapBlock("Capacity", node.capacity),
    mapBlock("System", node.info),
    formatEvents(events),
  ].join("\n\n");
}

export function describeDeployment(deployment: DeploymentDetail, events: EventLine[]): string {
  return [
    lines([
      ["Name", deployment.name],
      ["Namespace", deployment.namespace],
      ["Replicas", `${deployment.ready} ready, ${deployment.updated} updated, ${deployment.available} available, ${deployment.replicas} desired`],
      ["Strategy", deployment.strategy],
      ["Selector", deployment.selector],
      ["Images", deployment.images.join(", ")],
    ]),
    deployment.conditions.length
      ? ["Conditions:", ...deployment.conditions.map((condition) => `  ${condition.type}  ${condition.status}  ${condition.reason}`)].join("\n")
      : "Conditions:  <none>",
    formatEvents(events),
  ].join("\n\n");
}

export function rolloutStatusText(view: RolloutView): string {
  if (view.updated < view.desired) {
    return `Waiting for deployment "${view.name}" rollout to finish: ${view.updated} out of ${view.desired} new replicas have been updated...`;
  }
  if (view.observed > view.updated) {
    return `Waiting for deployment "${view.name}" rollout to finish: ${view.observed - view.updated} old replicas are pending termination...`;
  }
  if (view.available < view.desired) {
    return `Waiting for deployment "${view.name}" rollout to finish: ${view.available} of ${view.desired} updated replicas are available...`;
  }
  return `deployment "${view.name}" successfully rolled out`;
}

export function rolloutHistoryText(revisions: RevisionView[]): string {
  const sorted = revisions.slice().sort((left, right) => left.revision - right.revision);
  const header = "REVISION  CHANGE-CAUSE";
  if (sorted.length === 0) return `${header}\n<none>`;
  return [header, ...sorted.map((revision) => `${String(revision.revision).padEnd(8)}  ${revision.cause || "<none>"}`)].join("\n");
}

export function shellCommand(request: CommandRequest, target = request.resourceName): string {
  const namespace = request.namespace ? ` -n ${request.namespace}` : "";
  const container = request.container ? ` -c ${request.container}` : "";
  const noun = kubectlName(request.kind);
  if (request.kind === "Node") {
    if (request.name === "events") return `kubectl get events -A --field-selector involvedObject.name=${target},involvedObject.kind=Node`;
    if (request.name === "cordon" || request.name === "uncordon") return `kubectl ${request.name} ${target}`;
    if (request.name === "drain") return `kubectl drain ${target} --ignore-daemonsets --delete-emptydir-data`;
    if (request.name === "delete") return `kubectl delete node ${target}`;
    return `kubectl describe node ${target}`;
  }
  if (request.name === "describe") return `kubectl describe ${noun} ${target}${namespace}`;
  if (request.name === "logs") return `kubectl logs ${target}${namespace}${container} --tail=200`;
  if (request.name === "logs-previous") return `kubectl logs ${target}${namespace}${container} --previous --tail=200`;
  if (request.name === "events") {
    return `kubectl get events${namespace} --field-selector involvedObject.name=${target},involvedObject.kind=${request.kind}`;
  }
  // Rollouts act on the workload; a pod's rollout goes to its Deployment.
  const workload = request.kind === "Pod" || request.kind === "Deployment" ? "deployment" : noun;
  if (request.name === "rollout-status") return `kubectl rollout status ${workload}/${target}${namespace}`;
  if (request.name === "rollout-history") return `kubectl rollout history ${workload}/${target}${namespace}`;
  if (request.name === "rollout-restart") return `kubectl rollout restart ${workload}/${target}${namespace}`;
  if (request.name === "rollout-pause") return `kubectl rollout pause ${workload}/${target}${namespace}`;
  if (request.name === "rollout-resume") return `kubectl rollout resume ${workload}/${target}${namespace}`;
  if (request.name === "rollout-undo") {
    const revision = request.revision ? ` --to-revision=${request.revision}` : "";
    return `kubectl rollout undo ${workload}/${target}${namespace}${revision}`;
  }
  if (request.name === "set-image") return `kubectl set image ${noun}/${target} ${request.container ?? "<container>"}=${request.image ?? "<image>"}${namespace}`;
  if (request.name === "force-delete") return `kubectl delete pod ${target}${namespace} --grace-period=0 --force`;
  if (request.name === "evict") return `kubectl drain --pod-selector  # Podgaze calls the Eviction API for pod/${target}${namespace}`;
  if (request.name === "rerun") return `kubectl create -f -  # copy of ${noun}/${target}${namespace}`;
  if (request.name === "trigger") return `kubectl create job --from=cronjob/${target} ${target}-manual${namespace}`;
  if (request.name === "suspend" || request.name === "resume") {
    return `kubectl patch ${noun} ${target}${namespace} -p '{"spec":{"suspend":${request.name === "suspend"}}}'`;
  }
  if (request.name === "delete") return `kubectl delete ${noun} ${target}${namespace}`;
  return `kubectl scale ${workload}/${target}${namespace} --replicas=${request.replicas ?? 0}`;
}

export function restartPatch(annotations: Record<string, string> | undefined, at: string) {
  const next = { ...(annotations ?? {}), "kubectl.kubernetes.io/restartedAt": at };
  return [{ op: annotations ? "replace" : "add", path: "/spec/template/metadata/annotations", value: next }];
}

export function scalePatch(hasReplicas: boolean, replicas: number) {
  return [{ op: hasReplicas ? "replace" : "add", path: "/spec/replicas", value: replicas }];
}

type TemplateLike = { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } } & Record<string, unknown>;

// What `kubectl rollout undo` writes: the old ReplicaSet's pod template without the hash label the controller adds.
export function rollbackTemplate(template: TemplateLike): TemplateLike {
  const copy = JSON.parse(JSON.stringify(template)) as TemplateLike;
  if (copy.metadata?.labels) {
    delete copy.metadata.labels["pod-template-hash"];
  }
  return copy;
}

export function pickRollbackRevision(revisions: number[], current: number, wanted: number | undefined): number {
  const sorted = [...new Set(revisions)].sort((left, right) => left - right);
  if (wanted !== undefined && wanted > 0) {
    if (!sorted.includes(wanted)) throw new Error(`Revision ${wanted} is not in the rollout history.`);
    if (wanted === current) throw new Error(`Revision ${wanted} is already running.`);
    return wanted;
  }
  const previous = sorted.filter((revision) => revision < current).at(-1);
  if (previous === undefined) throw new Error("There is no earlier revision to roll back to.");
  return previous;
}

export function manualJobName(cronJob: string, now: number): string {
  const suffix = `-manual-${now.toString(36).slice(-5)}`;
  return `${cronJob.slice(0, 63 - suffix.length)}${suffix}`;
}
