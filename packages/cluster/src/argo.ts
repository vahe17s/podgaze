import type { ArgoApp, HubChart } from "@podgaze/contracts";

type Raw = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

// An Argo CD Application as the controller reports it: sync and health, where it deploys from and to, and the
// per-resource state the Argo UI shows in its tree.
export function argoApp(raw: Raw): ArgoApp | null {
  const metadata = (raw.metadata ?? {}) as Raw;
  const spec = (raw.spec ?? {}) as Raw;
  const status = (raw.status ?? {}) as Raw;
  const name = text(metadata.name);
  if (!name) return null;
  const sources = Array.isArray(spec.sources) ? (spec.sources as Raw[]) : [];
  const source = ((spec.source as Raw | undefined) ?? sources[0] ?? {}) as Raw;
  const destination = (spec.destination ?? {}) as Raw;
  const sync = (status.sync ?? {}) as Raw;
  const health = (status.health ?? {}) as Raw;
  const operation = (status.operationState ?? null) as Raw | null;
  const automated = ((spec.syncPolicy ?? {}) as Raw).automated;
  return {
    name,
    namespace: text(metadata.namespace),
    project: text(spec.project) || "default",
    sync: text(sync.status) || "Unknown",
    health: text(health.status) || "Unknown",
    healthMessage: text(health.message),
    repo: text(source.repoURL),
    path: text(source.path),
    chart: text(source.chart),
    targetRevision: text(source.targetRevision) || "HEAD",
    revision: text(sync.revision) || (Array.isArray(sync.revisions) ? text((sync.revisions as unknown[])[0]) : ""),
    destServer: text(destination.server) || text(destination.name),
    destNamespace: text(destination.namespace),
    autoSync: Boolean(automated),
    operation: operation
      ? { phase: text(operation.phase), message: text(operation.message), startedAt: iso(operation.startedAt), finishedAt: iso(operation.finishedAt) }
      : null,
    conditions: (Array.isArray(status.conditions) ? (status.conditions as Raw[]) : []).map((item) => ({ type: text(item.type), message: text(item.message) })),
    resources: (Array.isArray(status.resources) ? (status.resources as Raw[]) : []).map((item) => ({
      kind: text(item.kind),
      group: text(item.group),
      name: text(item.name),
      namespace: text(item.namespace),
      sync: text(item.status) || "Unknown",
      health: text(((item.health ?? {}) as Raw).status),
      message: text(((item.health ?? {}) as Raw).message),
    })),
    reconciledAt: iso(status.reconciledAt),
    history: (Array.isArray(status.history) ? (status.history as Raw[]) : [])
      .map((item) => {
        const itemSource = ((item.source as Raw | undefined) ?? (Array.isArray(item.sources) ? (item.sources as Raw[])[0] : undefined) ?? {}) as Raw;
        return {
          id: typeof item.id === "number" ? item.id : Number(item.id ?? 0),
          revision: text(item.revision) || (Array.isArray(item.revisions) ? text((item.revisions as unknown[])[0]) : ""),
          deployedAt: iso(item.deployedAt),
          source: text(itemSource.path) || text(itemSource.chart),
        };
      })
      .sort((left, right) => right.id - left.id),
  };
}

// A rollback is a sync pinned to an older revision. With auto-sync on, Argo CD would sync straight back to Git,
// which is why the argocd CLI refuses it too.
export function rollbackPatch(app: ArgoApp, revision: string): Raw {
  if (app.autoSync) throw new Error("Auto-sync is on, so Argo CD would sync straight back to Git. Turn off auto-sync first.");
  if (!app.history.some((entry) => entry.revision === revision)) throw new Error(`Revision ${revision} is not in this application's history.`);
  return { operation: { initiatedBy: { username: "podgaze" }, sync: { revision, syncStrategy: { hook: {} } } } };
}

export function disableAutoSyncPatch(): Raw {
  return { spec: { syncPolicy: { automated: null } } };
}

// The patch the argocd CLI sends to start a sync: the controller acts on spec-level "operation".
export function syncPatch(app: ArgoApp, prune: boolean): Raw {
  return {
    operation: {
      initiatedBy: { username: "podgaze" },
      sync: { revision: app.targetRevision, prune, syncStrategy: { hook: {} } },
    },
  };
}

export function refreshPatch(hard: boolean): Raw {
  return { metadata: { annotations: { "argocd.argoproj.io/refresh": hard ? "hard" : "normal" } } };
}

export function hubCharts(raw: unknown): HubChart[] {
  const packages = ((raw ?? {}) as { packages?: Raw[] }).packages ?? [];
  return packages.flatMap((item) => {
    const repo = (item.repository ?? {}) as Raw;
    const name = text(item.name);
    if (!name || !text(repo.url)) return [];
    return [{
      name,
      version: text(item.version),
      appVersion: text(item.app_version),
      description: text(item.description),
      stars: typeof item.stars === "number" ? item.stars : 0,
      repo: { name: text(repo.name), url: text(repo.url), official: Boolean(repo.official), verified: Boolean(repo.verified_publisher) },
    }];
  });
}

export const NODE_SHELL_COMMAND = [
  "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
  "/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
];

// A throwaway privileged pod pinned to the node, sharing its PID namespace so nsenter can step into the host.
// It sleeps for four hours at most, so a crash or a closed laptop cannot leave it running forever.
export function nodeShellPod(node: string, name: string, image = "busybox:1.36"): Raw {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: "kube-system",
      labels: { "app.kubernetes.io/managed-by": "podgaze", "podgaze.dev/node-shell": node.slice(0, 63) },
    },
    spec: {
      nodeName: node,
      hostPID: true,
      hostIPC: true,
      hostNetwork: true,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 0,
      activeDeadlineSeconds: 14400,
      tolerations: [{ operator: "Exists" }],
      containers: [{
        name: "shell",
        image,
        command: ["sleep", "14400"],
        stdin: true,
        tty: true,
        securityContext: { privileged: true },
      }],
    },
  };
}
