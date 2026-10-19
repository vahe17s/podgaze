import type { AppsV1Api, BatchV1Api, CoreV1Api } from "@kubernetes/client-node";
import type { CommandRequest, CommandResult } from "@podgaze/contracts";
import { restartPatch, scalePatch, shellCommand } from "./commands.js";

type Container = { name?: string; image?: string };
type Workload = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: {
    replicas?: number;
    paused?: boolean;
    suspend?: boolean;
    selector?: { matchLabels?: Record<string, string> };
    template?: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: { containers?: Container[]; initContainers?: Container[] } };
  } & Record<string, unknown>;
  status?: Record<string, number | string | undefined>;
};

function done(title: string, request: CommandRequest, output: string): CommandResult {
  return { title, command: shellCommand(request), output };
}

// A JSON patch that changes one container's image, found by name among containers or init containers.
export function setImagePatch(workload: Workload, container: string | undefined, image: string | undefined, base = "/spec/template/spec") {
  if (!image?.trim()) throw new Error("Set image needs the new image, like registry/app:1.2.3.");
  const containers = workload.spec?.template?.spec?.containers ?? [];
  const inits = workload.spec?.template?.spec?.initContainers ?? [];
  const pick = container || (containers.length === 1 ? containers[0]?.name : undefined);
  if (!pick) throw new Error(`Choose a container: ${containers.map((item) => item.name).join(", ")}.`);
  const index = containers.findIndex((item) => item.name === pick);
  if (index >= 0) return [{ op: "replace", path: `${base}/containers/${index}/image`, value: image.trim() }];
  const initIndex = inits.findIndex((item) => item.name === pick);
  if (initIndex >= 0) return [{ op: "replace", path: `${base}/initContainers/${initIndex}/image`, value: image.trim() }];
  throw new Error(`No container named ${pick}.`);
}

// A fresh copy of a finished Job: the controller adds its own uid labels and selector, so those must go.
export function rerunJobBody(job: Workload & { spec?: { template?: { metadata?: { labels?: Record<string, string> } } } }, now: number) {
  const name = job.metadata?.name ?? "job";
  const suffix = `-rerun-${now.toString(36).slice(-5)}`;
  const strip = (labels: Record<string, string> | undefined) => {
    const copy = { ...(labels ?? {}) };
    for (const key of ["controller-uid", "job-name", "batch.kubernetes.io/controller-uid", "batch.kubernetes.io/job-name"]) delete copy[key];
    return copy;
  };
  const spec = JSON.parse(JSON.stringify(job.spec ?? {})) as Record<string, unknown> & { template?: { metadata?: { labels?: Record<string, string> } } };
  delete spec.selector;
  delete spec.manualSelector;
  if (spec.template?.metadata) spec.template.metadata.labels = strip(spec.template.metadata.labels);
  spec.suspend = false;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `${name.slice(0, 63 - suffix.length)}${suffix}`,
      namespace: job.metadata?.namespace,
      labels: strip(job.metadata?.labels),
      annotations: { "podgaze.dev/rerun-of": name },
    },
    spec,
  };
}

export function statefulSetStatus(name: string, workload: Workload): string {
  const desired = workload.spec?.replicas ?? 1;
  const ready = Number(workload.status?.readyReplicas ?? 0);
  const updated = Number(workload.status?.updatedReplicas ?? 0);
  if (workload.status?.currentRevision !== workload.status?.updateRevision && updated < desired) {
    return `Waiting for partitioned roll out to finish: ${updated} out of ${desired} new pods have been updated...`;
  }
  if (ready < desired) return `Waiting for ${desired - ready} pods of statefulset "${name}" to be ready...`;
  return `statefulset rolling update complete ${desired} pods at revision ${String(workload.status?.updateRevision ?? "")}`;
}

export function daemonSetStatus(name: string, workload: Workload): string {
  const desired = Number(workload.status?.desiredNumberScheduled ?? 0);
  const updated = Number(workload.status?.updatedNumberScheduled ?? 0);
  const available = Number(workload.status?.numberAvailable ?? 0);
  if (updated < desired) return `Waiting for daemon set "${name}" rollout to finish: ${updated} out of ${desired} new pods have been updated...`;
  if (available < desired) return `Waiting for daemon set "${name}" rollout to finish: ${available} of ${desired} updated pods are available...`;
  return `daemon set "${name}" successfully rolled out`;
}

// Commands beyond what kubectl-style describe and delete cover, for every workload kind. Returns null when the
// request belongs to another handler.
export async function workloadCommand(core: CoreV1Api, apps: AppsV1Api, batch: BatchV1Api, request: CommandRequest, now = Date.now()): Promise<CommandResult | null> {
  const name = request.resourceName;
  const namespace = request.namespace || "default";
  const kind = request.kind;

  if (kind === "Pod" && request.name === "force-delete") {
    await core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 });
    return done("Force delete", request, `pod "${name}" force deleted`);
  }
  if (kind === "Pod" && request.name === "evict") {
    try {
      await core.createNamespacedPodEviction({ name, namespace, body: { apiVersion: "policy/v1", kind: "Eviction", metadata: { name, namespace } } });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: number }).code : undefined;
      if (code === 429) throw new Error("A PodDisruptionBudget does not allow evicting this pod right now.");
      throw error;
    }
    return done("Evict", request, `pod/${name} evicted`);
  }

  if (kind === "Deployment" && (request.name === "rollout-pause" || request.name === "rollout-resume")) {
    const paused = request.name === "rollout-pause";
    await apps.patchNamespacedDeployment({ name, namespace, body: [{ op: "add", path: "/spec/paused", value: paused }] });
    return done(paused ? "Pause rollout" : "Resume rollout", request, `deployment.apps/${name} ${paused ? "paused" : "resumed"}`);
  }

  if (request.name === "set-image") {
    if (kind === "Deployment") {
      const current = (await apps.readNamespacedDeployment({ name, namespace })) as Workload;
      await apps.patchNamespacedDeployment({ name, namespace, body: setImagePatch(current, request.container, request.image) });
    } else if (kind === "StatefulSet") {
      const current = (await apps.readNamespacedStatefulSet({ name, namespace })) as Workload;
      await apps.patchNamespacedStatefulSet({ name, namespace, body: setImagePatch(current, request.container, request.image) });
    } else if (kind === "DaemonSet") {
      const current = (await apps.readNamespacedDaemonSet({ name, namespace })) as Workload;
      await apps.patchNamespacedDaemonSet({ name, namespace, body: setImagePatch(current, request.container, request.image) });
    } else {
      throw new Error(`Set image is for Deployments, StatefulSets, and DaemonSets, not ${kind}.`);
    }
    return done("Set image", request, `${kind.toLowerCase()}.apps/${name} image updated to ${request.image?.trim()}`);
  }

  if (kind === "StatefulSet" || kind === "DaemonSet") {
    const read = kind === "StatefulSet"
      ? () => apps.readNamespacedStatefulSet({ name, namespace }) as Promise<Workload>
      : () => apps.readNamespacedDaemonSet({ name, namespace }) as Promise<Workload>;
    if (request.name === "rollout-status") {
      const current = await read();
      return done("Rollout status", request, kind === "StatefulSet" ? statefulSetStatus(name, current) : daemonSetStatus(name, current));
    }
    if (request.name === "rollout-restart") {
      const current = await read();
      const body = restartPatch(current.spec?.template?.metadata?.annotations, new Date(now).toISOString());
      if (kind === "StatefulSet") await apps.patchNamespacedStatefulSet({ name, namespace, body });
      else await apps.patchNamespacedDaemonSet({ name, namespace, body });
      return done("Rollout restart", request, `${kind.toLowerCase()}.apps/${name} restarted`);
    }
  }

  if ((kind === "StatefulSet" || kind === "ReplicaSet") && request.name === "scale") {
    if (request.replicas === undefined || !Number.isInteger(request.replicas) || request.replicas < 0) throw new Error("Scale needs a replica count of 0 or more.");
    if (kind === "StatefulSet") {
      const current = (await apps.readNamespacedStatefulSet({ name, namespace })) as Workload;
      await apps.patchNamespacedStatefulSet({ name, namespace, body: scalePatch(current.spec?.replicas !== undefined, request.replicas) });
    } else {
      const current = (await apps.readNamespacedReplicaSet({ name, namespace })) as Workload;
      await apps.patchNamespacedReplicaSet({ name, namespace, body: scalePatch(current.spec?.replicas !== undefined, request.replicas) });
    }
    return done("Scale", request, `${kind.toLowerCase()}.apps/${name} scaled to ${request.replicas}`);
  }

  if (kind === "Job" && (request.name === "suspend" || request.name === "resume")) {
    const suspend = request.name === "suspend";
    await batch.patchNamespacedJob({ name, namespace, body: [{ op: "add", path: "/spec/suspend", value: suspend }] });
    return done(suspend ? "Suspend" : "Resume", request, `job.batch/${name} ${suspend ? "suspended" : "resumed"}`);
  }
  if (kind === "Job" && request.name === "rerun") {
    const job = (await batch.readNamespacedJob({ name, namespace })) as Workload;
    const body = rerunJobBody(job, now);
    await batch.createNamespacedJob({ namespace, body: body as never });
    return { title: "Run again", command: `kubectl create -f -  # copy of job/${name}`, output: `job.batch/${body.metadata.name} created` };
  }
  return null;
}
