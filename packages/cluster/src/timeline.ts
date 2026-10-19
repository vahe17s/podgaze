import type { ArgoApp, Timeline, TimelineCategory, TimelineEntry } from "@podgaze/contracts";

type Container = { name?: string; image?: string };

// A ReplicaSet (Deployment) or ControllerRevision (StatefulSet, DaemonSet): one version of the pod template.
export type RevisionLike = { name: string; created: string; revision: string; containers: Container[]; changeCause?: string };

type Terminated = { reason?: string; exitCode?: number; finishedAt?: string | Date };

export type TimelinePod = {
  metadata?: { name?: string };
  status?: { containerStatuses?: { name?: string; lastState?: { terminated?: Terminated }; state?: { terminated?: Terminated } }[] };
};

export type TimelineEvent = {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string | Date;
  eventTime?: string | Date;
  firstTimestamp?: string | Date;
  metadata?: { creationTimestamp?: string | Date };
  involvedObject?: { kind?: string; name?: string };
};

export type TimelineInput = {
  revisions: RevisionLike[];
  pods: TimelinePod[];
  events: TimelineEvent[];
  argo: ArgoApp[];
};

// Normal events that happen on every rollout and say nothing on their own.
const ROUTINE = new Set(["Scheduled", "Pulling", "Pulled", "Created", "Started", "SuccessfulCreate", "SuccessfulDelete", "Killing", "SandboxChanged", "NoPods"]);

function iso(value: string | Date | undefined | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function tag(image: string): string {
  const at = image.indexOf("@");
  if (at >= 0) return image.slice(at + 1, at + 20);
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(colon + 1) : "latest";
}

// What changed between two pod templates, said the way people talk about deploys: "api 1.4.0 → 1.5.0".
export function imageChanges(before: Container[], after: Container[]): string {
  const old = new Map(before.map((container) => [container.name ?? "", container.image ?? ""]));
  const parts = after.flatMap((container) => {
    const previous = old.get(container.name ?? "");
    const image = container.image ?? "";
    if (previous === undefined) return [`${container.name} ${tag(image)}`];
    if (previous !== image) return [`${container.name} ${tag(previous)} → ${tag(image)}`];
    return [];
  });
  return parts.join(", ");
}

function eventCategory(event: TimelineEvent): TimelineCategory | null {
  const reason = event.reason ?? "";
  if (reason === "ScalingReplicaSet" || reason === "SuccessfulRescale") return "scale";
  if (event.type === "Warning") {
    if (/OOM/i.test(reason)) return "oom";
    if (reason === "BackOff" || reason === "CrashLoopBackOff") return "crash";
    return "warning";
  }
  if (ROUTINE.has(reason)) return null;
  return "info";
}

export function buildTimeline(input: TimelineInput): Timeline {
  const entries: TimelineEntry[] = [];

  const revisions = [...input.revisions].sort((left, right) => Number(left.revision) - Number(right.revision) || left.created.localeCompare(right.created));
  revisions.forEach((revision, index) => {
    const previous = revisions[index - 1];
    const images = previous ? imageChanges(previous.containers, revision.containers) : revision.containers.map((container) => `${container.name} ${tag(container.image ?? "")}`).join(", ");
    entries.push({
      time: iso(revision.created),
      category: "deploy",
      title: previous ? `Rolled out revision ${revision.revision}` : `Revision ${revision.revision}`,
      detail: [images || "Same images, other settings changed", revision.changeCause ?? ""].filter(Boolean).join(" · "),
      object: revision.name,
    });
  });

  for (const pod of input.pods) {
    const podName = pod.metadata?.name ?? "";
    for (const status of pod.status?.containerStatuses ?? []) {
      for (const ended of [status.lastState?.terminated, status.state?.terminated]) {
        if (!ended || ended.reason === "Completed" || ended.exitCode === 0) continue;
        const oom = ended.reason === "OOMKilled";
        entries.push({
          time: iso(ended.finishedAt),
          category: oom ? "oom" : "crash",
          title: oom ? `${status.name} was OOM-killed` : `${status.name} exited with code ${ended.exitCode ?? "?"}`,
          detail: ended.reason && !oom ? ended.reason : oom ? "Used more memory than its limit" : "",
          object: `Pod ${podName}`,
        });
      }
    }
  }

  let oldestEvent: string | null = null;
  for (const event of input.events) {
    const category = eventCategory(event);
    const time = iso(event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata?.creationTimestamp);
    if (time && (!oldestEvent || time < oldestEvent)) oldestEvent = time;
    if (!category) continue;
    const count = (event.count ?? 1) > 1 ? ` ×${event.count}` : "";
    entries.push({
      time,
      category,
      title: `${event.reason ?? "Event"}${count}`,
      detail: event.message ?? "",
      object: `${event.involvedObject?.kind ?? ""} ${event.involvedObject?.name ?? ""}`.trim(),
    });
  }

  for (const app of input.argo) {
    for (const item of app.history) {
      entries.push({
        time: iso(item.deployedAt),
        category: "sync",
        title: `Argo CD synced ${app.name}`,
        detail: `${item.revision.slice(0, 10)}${item.source ? ` · ${item.source}` : ""}`,
        object: `Application ${app.name}`,
      });
    }
    const operation = app.operation;
    if (operation && /Failed|Error/i.test(operation.phase) && operation.finishedAt) {
      entries.push({ time: iso(operation.finishedAt), category: "warning", title: `Argo CD sync ${operation.phase.toLowerCase()}`, detail: operation.message, object: `Application ${app.name}` });
    }
  }

  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = `${entry.time}|${entry.title}|${entry.object}`;
    if (!entry.time || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((left, right) => right.time.localeCompare(left.time));
  return { entries: unique, eventsSince: oldestEvent };
}
