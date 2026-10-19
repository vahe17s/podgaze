import { AppsV1Api, BatchV1Api, CoreV1Api, KubernetesObjectApi, PatchStrategy, dumpYaml } from "@kubernetes/client-node";
import { parse } from "yaml";
import { apiKindOf, catalogEntry, type CommandRequest, type CommandResult } from "@podgaze/contracts";
import {
  describeDeployment,
  describeNode,
  describePod,
  formatEvents,
  manualJobName,
  pickRollbackRevision,
  restartPatch,
  rollbackTemplate,
  rolloutHistoryText,
  rolloutStatusText,
  scalePatch,
  shellCommand,
  type ContainerDetail,
  type DeploymentDetail,
  type EventLine,
  type NodeDetail,
  type PodDetail,
} from "./commands.js";
import { selectorString, type LabelSelector } from "./manifest.js";

type Loose = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: Date | string;
    uid?: string;
    ownerReferences?: { kind?: string; name?: string; controller?: boolean }[];
  };
  spec?: {
    nodeName?: string;
    replicas?: number;
    strategy?: { type?: string };
    selector?: LabelSelector;
    unschedulable?: boolean;
    containers?: { name?: string; image?: string; ports?: { containerPort?: number; protocol?: string }[] }[];
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec?: { containers?: { image?: string; ports?: { containerPort?: number; protocol?: string }[]; name?: string }[] };
    };
  };
  status?: {
    phase?: string;
    podIP?: string;
    qosClass?: string;
    startTime?: Date | string;
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    readyReplicas?: number;
    conditions?: { type?: string; status?: string; reason?: string }[];
    addresses?: { type?: string; address?: string }[];
    capacity?: Record<string, string>;
    nodeInfo?: Record<string, string>;
    containerStatuses?: {
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string }; running?: object; terminated?: { reason?: string } };
    }[];
  };
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: Date | string;
  eventTime?: Date | string;
  source?: { component?: string };
  reportingComponent?: string;
};

function stamp(value: Date | string | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace(".000Z", "Z");
}

function ownerOf(metadata: Loose["metadata"]): { kind: string; name: string } | null {
  const owners = metadata?.ownerReferences ?? [];
  const owner = owners.find((item) => item.controller) ?? owners[0];
  if (!owner?.kind || !owner.name) return null;
  return { kind: owner.kind, name: owner.name };
}

function containerState(status: {
  state?: { waiting?: { reason?: string }; running?: object; terminated?: { reason?: string } };
} | undefined): string {
  const state = status?.state;
  return state?.waiting?.reason || (state?.running ? "Running" : state?.terminated?.reason || "Waiting");
}

function podDetail(pod: Loose): PodDetail {
  const statuses = pod.status?.containerStatuses ?? [];
  const containers: ContainerDetail[] = (pod.spec?.containers ?? []).map((container) => {
    const status = statuses.find((item) => item.name === container.name);
    return {
      name: container.name ?? "",
      image: container.image ?? "",
      ports: (container.ports ?? []).map((port) => `${port.containerPort ?? "?"}/${port.protocol ?? "TCP"}`),
      state: containerState(status),
      ready: Boolean(status?.ready),
      restarts: status?.restartCount ?? 0,
    };
  });
  const waiting = statuses.find((status) => status.state?.waiting?.reason);
  const owner = ownerOf(pod.metadata);
  return {
    name: pod.metadata?.name ?? "",
    namespace: pod.metadata?.namespace ?? "",
    node: pod.spec?.nodeName ?? "",
    ip: pod.status?.podIP ?? "",
    qos: pod.status?.qosClass ?? "",
    status: waiting?.state?.waiting?.reason || pod.status?.phase || "Unknown",
    start: stamp(pod.status?.startTime),
    controlledBy: owner ? `${owner.kind}/${owner.name}` : "",
    labels: pod.metadata?.labels ?? {},
    containers,
    conditions: (pod.status?.conditions ?? []).map((condition) => ({
      type: condition.type ?? "",
      status: condition.status ?? "",
    })),
  };
}

function nodeDetail(node: Loose): NodeDetail {
  const roles = new Set<string>();
  for (const [key, value] of Object.entries(node.metadata?.labels ?? {})) {
    if (key.startsWith("node-role.kubernetes.io/")) roles.add(key.slice("node-role.kubernetes.io/".length));
    if (key === "kubernetes.io/role" && value) roles.add(value);
  }
  return {
    name: node.metadata?.name ?? "",
    roles: [...roles],
    labels: node.metadata?.labels ?? {},
    addresses: (node.status?.addresses ?? []).map((address) => ({ type: address.type ?? "", address: address.address ?? "" })),
    conditions: (node.status?.conditions ?? []).map((condition) => ({ type: condition.type ?? "", status: condition.status ?? "" })),
    capacity: node.status?.capacity ?? {},
    info: node.status?.nodeInfo ?? {},
  };
}

function deploymentDetail(deployment: Loose): DeploymentDetail {
  return {
    name: deployment.metadata?.name ?? "",
    namespace: deployment.metadata?.namespace ?? "",
    replicas: deployment.spec?.replicas ?? deployment.status?.replicas ?? 0,
    updated: deployment.status?.updatedReplicas ?? 0,
    available: deployment.status?.availableReplicas ?? 0,
    ready: deployment.status?.readyReplicas ?? 0,
    strategy: deployment.spec?.strategy?.type ?? "RollingUpdate",
    selector: selectorString(deployment.spec?.selector) ?? "",
    images: (deployment.spec?.template?.spec?.containers ?? []).map((container) => container.image ?? "").filter(Boolean),
    conditions: (deployment.status?.conditions ?? []).map((condition) => ({
      type: condition.type ?? "",
      status: condition.status ?? "",
      reason: condition.reason ?? "",
    })),
  };
}

function mapEvent(event: Loose): EventLine {
  return {
    time: stamp(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp),
    type: event.type ?? "",
    reason: event.reason ?? "",
    source: event.source?.component ?? event.reportingComponent ?? "",
    message: event.message ?? "",
    count: event.count ?? 1,
  };
}

export async function readEvents(core: CoreV1Api, namespace: string | null, kind: string, name: string): Promise<EventLine[]> {
  const entry = catalogEntry(kind);
  const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${entry ? apiKindOf(entry) : kind}`;
  const list = namespace
    ? await core.listNamespacedEvent({ namespace, fieldSelector })
    : await core.listEventForAllNamespaces({ fieldSelector });
  return ((list.items ?? []) as Loose[]).map(mapEvent);
}

async function deploymentTarget(core: CoreV1Api, apps: AppsV1Api, request: CommandRequest): Promise<{ namespace: string; name: string }> {
  const namespace = request.namespace || "default";
  if (request.kind === "Deployment") return { namespace, name: request.resourceName };
  if (request.kind !== "Pod") throw new Error("Rollout and scale apply to a Deployment.");
  const pod = (await core.readNamespacedPod({ name: request.resourceName, namespace })) as Loose;
  const owner = ownerOf(pod.metadata);
  if (!owner) throw new Error("This pod has no controller, so there is no rollout to run.");
  if (owner.kind === "Deployment") return { namespace, name: owner.name };
  if (owner.kind !== "ReplicaSet") {
    throw new Error(`This pod is owned by ${owner.kind}/${owner.name}, which does not have a rollout.`);
  }
  const replicaSet = (await apps.readNamespacedReplicaSet({ name: owner.name, namespace })) as Loose;
  const parent = ownerOf(replicaSet.metadata);
  if (parent?.kind !== "Deployment") throw new Error(`ReplicaSet ${owner.name} is not owned by a Deployment.`);
  return { namespace, name: parent.name };
}

function result(title: string, command: string, output: string): CommandResult {
  return { title, command, output };
}

export async function executeCommand(core: CoreV1Api, apps: AppsV1Api, request: CommandRequest): Promise<CommandResult> {
  const namespace = request.namespace;

  if (request.kind === "Node" && (request.name === "cordon" || request.name === "uncordon" || request.name === "drain")) {
    return nodeCommand(core, request);
  }

  if (request.name === "describe" && request.kind === "Node") {
    const node = (await core.readNode({ name: request.resourceName })) as Loose;
    const events = await readEvents(core, null, "Node", request.resourceName);
    return result("Describe", shellCommand(request), describeNode(nodeDetail(node), events));
  }

  if (request.name === "describe" && request.kind === "Pod") {
    const pod = (await core.readNamespacedPod({ name: request.resourceName, namespace: namespace || "default" })) as Loose;
    const events = await readEvents(core, namespace || pod.metadata?.namespace || "default", "Pod", request.resourceName);
    return result("Describe", shellCommand(request), describePod(podDetail(pod), events));
  }

  if (request.name === "logs" || request.name === "logs-previous") {
    if (request.kind !== "Pod") throw new Error("Logs are available for pods.");
    const text = await core.readNamespacedPodLog({
      name: request.resourceName,
      namespace: namespace || "default",
      container: request.container,
      previous: request.name === "logs-previous",
      tailLines: 200,
      timestamps: true,
    });
    return result(request.name === "logs" ? "Logs" : "Previous logs", shellCommand(request), text.trim() ? text : "(no logs)");
  }

  if (request.name === "delete" && request.kind === "Pod") {
    await core.deleteNamespacedPod({ name: request.resourceName, namespace: namespace || "default" });
    return result("Delete", shellCommand(request), `pod/${request.resourceName} deleted`);
  }

  if (request.name === "delete" && request.kind === "Node") {
    await core.deleteNode({ name: request.resourceName });
    return result("Delete", shellCommand(request), `node/${request.resourceName} deleted`);
  }

  if (request.name === "delete" && request.kind === "Deployment") {
    await apps.deleteNamespacedDeployment({ name: request.resourceName, namespace: namespace || "default" });
    return result("Delete", shellCommand(request), `deployment.apps/${request.resourceName} deleted`);
  }

  if (request.name === "events" && request.kind !== "Deployment") {
    const events = await readEvents(core, request.kind === "Node" ? null : namespace || "default", request.kind, request.resourceName);
    const output = events.length ? events.map((event) => `${event.time}  ${event.type}  ${event.reason}  ${event.message}`).join("\n") : "No events.";
    return result("Events", shellCommand(request), output);
  }

  const target = await deploymentTarget(core, apps, request);
  const deployment = (await apps.readNamespacedDeployment({ name: target.name, namespace: target.namespace })) as Loose;
  const view = deploymentDetail(deployment);
  const aimed = { ...request, kind: "Deployment" as const, resourceName: target.name, namespace: target.namespace };

  if (request.name === "describe" || request.name === "events") {
    const events = await readEvents(core, target.namespace, "Deployment", target.name);
    if (request.name === "events") {
      const output = events.length ? events.map((event) => `${event.time}  ${event.type}  ${event.reason}  ${event.message}`).join("\n") : "No events.";
      return result("Events", shellCommand(aimed), output);
    }
    return result("Describe", shellCommand(aimed), describeDeployment(view, events));
  }

  if (request.name === "rollout-status") {
    return result("Rollout status", shellCommand(aimed), rolloutStatusText({
      name: view.name,
      desired: view.replicas,
      updated: view.updated,
      available: view.available,
      observed: deployment.status?.replicas ?? view.replicas,
    }));
  }

  if (request.name === "rollout-history") {
    if (!view.selector) throw new Error("This deployment has no label selector, so rollout history cannot be listed.");
    const list = await apps.listNamespacedReplicaSet({ namespace: target.namespace, labelSelector: view.selector });
    const revisions = ((list.items ?? []) as Loose[])
      .filter((item) => ownerOf(item.metadata)?.name === target.name)
      .map((item) => ({
        revision: Number(item.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
        cause: item.metadata?.annotations?.["kubernetes.io/change-cause"] ?? "",
      }));
    return result("Rollout history", shellCommand(aimed), rolloutHistoryText(revisions));
  }

  if (request.name === "rollout-restart") {
    if (!deployment.spec?.template?.metadata) throw new Error("This deployment has no pod template to restart.");
    await apps.patchNamespacedDeployment({
      name: target.name,
      namespace: target.namespace,
      body: restartPatch(deployment.spec.template.metadata.annotations, new Date().toISOString()),
    });
    return result("Rollout restart", shellCommand(aimed), `deployment.apps/${target.name} restarted`);
  }

  if (request.name === "rollout-undo") {
    if (!view.selector) throw new Error("This deployment has no label selector, so it has no history to roll back to.");
    const list = await apps.listNamespacedReplicaSet({ namespace: target.namespace, labelSelector: view.selector });
    const owned = ((list.items ?? []) as (Loose & { spec?: { template?: unknown } })[])
      .filter((item) => ownerOf(item.metadata)?.name === target.name)
      .map((item) => ({ revision: Number(item.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0), set: item }));
    const current = Number(deployment.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
    const revision = pickRollbackRevision(owned.map((item) => item.revision), current, request.revision);
    const chosen = owned.find((item) => item.revision === revision)!;
    // Round-trip through the typed serializer so the patch carries API field names, not client property names.
    const template = (parse(dumpYaml({ apiVersion: "v1", kind: "PodTemplate", metadata: {}, template: chosen.set.spec?.template })) as { template: Record<string, unknown> }).template;
    await apps.patchNamespacedDeployment({
      name: target.name,
      namespace: target.namespace,
      body: [{ op: "replace", path: "/spec/template", value: rollbackTemplate(template) }],
    });
    return result("Rollout undo", shellCommand({ ...aimed, revision }), `deployment.apps/${target.name} rolled back to revision ${revision}`);
  }

  if (request.replicas === undefined || !Number.isInteger(request.replicas) || request.replicas < 0) {
    throw new Error("Scale needs a replica count of 0 or more.");
  }
  await apps.patchNamespacedDeployment({
    name: target.name,
    namespace: target.namespace,
    body: scalePatch(deployment.spec?.replicas !== undefined, request.replicas),
  });
  return result("Scale", shellCommand({ ...aimed, replicas: request.replicas }), `deployment.apps/${target.name} scaled to ${request.replicas}`);
}

export async function genericCommand(objects: KubernetesObjectApi, core: CoreV1Api, request: CommandRequest): Promise<CommandResult> {
  const entry = catalogEntry(request.kind);
  if (!entry) throw new Error(`Unknown resource ${request.kind}.`);
  if (request.name === "logs" || request.name === "logs-previous") throw new Error("Logs are available for pods.");
  const namespace = entry.namespaced ? request.namespace || "default" : null;
  if (request.name === "delete") {
    await objects.delete({
      apiVersion: entry.apiVersion,
      kind: apiKindOf(entry),
      metadata: { name: request.resourceName, ...(namespace ? { namespace } : {}) },
    });
    return result("Delete", shellCommand(request), `${entry.plural}/${request.resourceName} deleted`);
  }
  if (request.name !== "describe" && request.name !== "events") throw new Error("Rollout and scale apply to a Deployment.");
  if (request.name === "events") {
    const events = await readEvents(core, namespace, request.kind, request.resourceName);
    const output = events.length ? events.map((event) => `${event.time}  ${event.type}  ${event.reason}  ${event.message}`).join("\n") : "No events.";
    return result("Events", shellCommand(request), output);
  }
  const object = await objects.read({
    apiVersion: entry.apiVersion,
    kind: apiKindOf(entry),
    metadata: { name: request.resourceName, ...(namespace ? { namespace } : {}) },
  });
  const events = await readEvents(core, namespace, request.kind, request.resourceName);
  const source = object as { data?: unknown; stringData?: unknown };
  const printable = request.kind === "Secret" ? { ...object, data: undefined, stringData: undefined } : object;
  if (request.kind === "Secret") {
    const keys = Object.keys((source.data as Record<string, string> | undefined) ?? {});
    return result("Describe", shellCommand(request), [`Name: ${request.resourceName}`, `Data: ${keys.join(", ") || "(empty)"}`, "", formatEvents(events)].join("\n"));
  }
  return result("Describe", shellCommand(request), [`Name: ${request.resourceName}`, dumpYaml(printable).trim(), "", formatEvents(events)].join("\n"));
}

type DrainPod = {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string>; ownerReferences?: { kind?: string }[] };
  status?: { phase?: string };
};

async function nodeCommand(core: CoreV1Api, request: CommandRequest): Promise<CommandResult> {
  const name = request.resourceName;
  const cordon = request.name !== "uncordon";
  await core.patchNode({ name, body: [{ op: "add", path: "/spec/unschedulable", value: cordon }] });
  if (request.name !== "drain") {
    return result(cordon ? "Cordon" : "Uncordon", shellCommand(request), `node/${name} ${cordon ? "cordoned" : "uncordoned"}`);
  }
  const list = await core.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${name}` });
  const lines = [`node/${name} cordoned`];
  for (const pod of (list.items ?? []) as DrainPod[]) {
    const podName = pod.metadata?.name;
    const podNamespace = pod.metadata?.namespace;
    if (!podName || !podNamespace) continue;
    if (pod.metadata?.annotations?.["kubernetes.io/config.mirror"]) {
      lines.push(`skipped ${podNamespace}/${podName}: static pod`);
      continue;
    }
    if ((pod.metadata?.ownerReferences ?? []).some((owner) => owner.kind === "DaemonSet")) {
      lines.push(`skipped ${podNamespace}/${podName}: DaemonSet`);
      continue;
    }
    if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") continue;
    try {
      await core.createNamespacedPodEviction({
        name: podName,
        namespace: podNamespace,
        body: { apiVersion: "policy/v1", kind: "Eviction", metadata: { name: podName, namespace: podNamespace } },
      });
      lines.push(`evicting ${podNamespace}/${podName}`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      const reason = code === 429 ? "a PodDisruptionBudget does not allow it right now" : error instanceof Error ? error.message : "eviction failed";
      lines.push(`could not evict ${podNamespace}/${podName}: ${reason}`);
    }
  }
  return result("Drain", shellCommand(request), lines.join("\n"));
}

type CronJobLike = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; uid?: string };
  spec?: { jobTemplate?: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: unknown } };
};

export async function cronCommand(batch: BatchV1Api, objects: KubernetesObjectApi, request: CommandRequest, now = Date.now()): Promise<CommandResult> {
  const namespace = request.namespace || "default";
  const name = request.resourceName;
  if (request.name === "suspend" || request.name === "resume") {
    const suspend = request.name === "suspend";
    await objects.patch(
      { apiVersion: "batch/v1", kind: "CronJob", metadata: { name, namespace }, spec: { suspend } } as never,
      undefined,
      undefined,
      "podgaze",
      undefined,
      PatchStrategy.MergePatch,
    );
    return result(suspend ? "Suspend" : "Resume", shellCommand(request), `cronjob.batch/${name} ${suspend ? "suspended" : "resumed"}`);
  }
  const cron = (await batch.readNamespacedCronJob({ name, namespace })) as CronJobLike;
  const template = cron.spec?.jobTemplate;
  if (!template?.spec) throw new Error("This CronJob has no job template.");
  const jobName = manualJobName(name, now);
  await batch.createNamespacedJob({
    namespace,
    body: {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace,
        labels: template.metadata?.labels,
        annotations: { ...(template.metadata?.annotations ?? {}), "cronjob.kubernetes.io/instantiate": "manual" },
        ownerReferences: cron.metadata?.uid
          ? [{ apiVersion: "batch/v1", kind: "CronJob", name, uid: cron.metadata.uid, controller: true, blockOwnerDeletion: true }]
          : undefined,
      },
      spec: template.spec as never,
    },
  });
  return result("Run now", shellCommand(request).replace(`${name}-manual`, jobName), `job.batch/${jobName} created`);
}
