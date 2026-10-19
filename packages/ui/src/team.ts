import type { CertInfo, DeploymentRow, PodRow } from "@podgaze/contracts";
import { labelsMatch, parseFilter } from "./filter";
import { statusTone } from "./format";

// What the page is about: one namespace, or a project (a team's namespaces, optionally narrowed by labels).
export type TeamScope = { id: string; title: string; namespaces: string[]; labels: string };

export function inScope<T extends { namespace: string; name: string; labels?: Record<string, string> }>(rows: T[], scope: TeamScope): T[] {
  const terms = scope.labels.trim() ? parseFilter(scope.labels).labels : [];
  return rows.filter((row) => scope.namespaces.includes(row.namespace) && labelsMatch(row.labels, terms));
}

export type Health = {
  pods: number;
  running: number;
  restarts: number;
  failingPods: PodRow[];
  degraded: DeploymentRow[];
  tone: "ok" | "warn" | "bad";
  verdict: string;
};

function readyParts(ready: string): [number, number] {
  const [have, want] = ready.split("/").map(Number);
  return [have ?? 0, want ?? 0];
}

export function teamHealth(pods: PodRow[], deployments: DeploymentRow[]): Health {
  const live = pods.filter((pod) => pod.status !== "Succeeded" && pod.status !== "Completed");
  const failingPods = live
    .filter((pod) => statusTone(pod.status) === "bad" || (pod.restarts > 0 && pod.lastExit !== ""))
    .sort((left, right) => right.restarts - left.restarts);
  const degraded = deployments.filter((deployment) => {
    const [have, want] = readyParts(deployment.ready);
    return want > 0 && have < want;
  });
  const down = degraded.filter((deployment) => readyParts(deployment.ready)[0] === 0).length;
  const tone = down > 0 || failingPods.some((pod) => statusTone(pod.status) === "bad") ? "bad" : degraded.length > 0 || failingPods.length > 0 ? "warn" : "ok";
  const verdict = tone === "ok"
    ? "Everything is running"
    : down > 0
    ? `${down} deployment${down === 1 ? "" : "s"} down`
    : degraded.length > 0
    ? `${degraded.length} deployment${degraded.length === 1 ? "" : "s"} short of replicas`
    : `${failingPods.length} pod${failingPods.length === 1 ? "" : "s"} failing or restarting`;
  return {
    pods: live.length,
    running: live.filter((pod) => statusTone(pod.status) === "ok").length,
    restarts: live.reduce((sum, pod) => sum + pod.restarts, 0),
    failingPods,
    degraded,
    tone,
    verdict,
  };
}

// Certificates and syncs in these namespaces that need someone: expired, within 30 days, or failing.
export function needsRenewal(certs: CertInfo[], namespaces: string[], now = Date.now()): (CertInfo & { days: number | null })[] {
  return certs
    .filter((cert) => namespaces.includes(cert.namespace))
    .map((cert) => {
      const at = Date.parse(cert.notAfter);
      return { ...cert, days: Number.isNaN(at) ? null : Math.floor((at - now) / 86_400_000) };
    })
    .filter((cert) => (cert.days !== null && cert.days <= 30) || cert.ready === "False" || (cert.source === "ExternalSecret" && cert.problem !== ""))
    .sort((left, right) => (left.days ?? -1) - (right.days ?? -1));
}
