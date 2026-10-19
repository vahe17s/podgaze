import { gunzipSync } from "node:zlib";
import { stringify } from "yaml";
import type { HelmRelease, HelmReleaseDetail, HelmRevision } from "@podgaze/contracts";

export type HelmSecretLike = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  type?: string;
  data?: Record<string, string>;
};

type ReleaseJson = {
  name?: string;
  namespace?: string;
  version?: number;
  info?: { status?: string; last_deployed?: string; description?: string; notes?: string };
  chart?: { metadata?: { name?: string; version?: string; appVersion?: string } };
  config?: Record<string, unknown>;
  manifest?: string;
};

// Helm 3 keeps each revision in a Secret: base64 (from the API) of base64 of gzipped JSON.
export function decodeRelease(data: string): ReleaseJson {
  const inner = Buffer.from(Buffer.from(data, "base64").toString("utf8"), "base64");
  const raw = inner[0] === 0x1f && inner[1] === 0x8b ? gunzipSync(inner) : inner;
  return JSON.parse(raw.toString("utf8")) as ReleaseJson;
}

function summary(secret: HelmSecretLike, release: ReleaseJson | null): HelmRelease {
  const labels = secret.metadata?.labels ?? {};
  return {
    name: release?.name ?? labels.name ?? "",
    namespace: release?.namespace ?? secret.metadata?.namespace ?? "",
    revision: release?.version ?? Number(labels.version ?? 0),
    status: release?.info?.status ?? labels.status ?? "unknown",
    chart: release?.chart?.metadata?.name ?? "",
    chartVersion: release?.chart?.metadata?.version ?? "",
    appVersion: release?.chart?.metadata?.appVersion ?? "",
    updated: release?.info?.last_deployed ?? "",
    description: release?.info?.description ?? "",
  };
}

function isRelease(secret: HelmSecretLike): boolean {
  return secret.type === "helm.sh/release.v1" && Boolean(secret.metadata?.labels?.name);
}

function revisionOf(secret: HelmSecretLike): number {
  return Number(secret.metadata?.labels?.version ?? 0);
}

function safeDecode(secret: HelmSecretLike): ReleaseJson | null {
  try {
    return secret.data?.release ? decodeRelease(secret.data.release) : null;
  } catch {
    return null;
  }
}

// The newest revision of each release. Only that one is decoded, so a cluster with long histories stays quick.
export function latestReleases(secrets: HelmSecretLike[]): HelmRelease[] {
  const newest = new Map<string, HelmSecretLike>();
  for (const secret of secrets.filter(isRelease)) {
    const key = `${secret.metadata?.namespace ?? ""}/${secret.metadata?.labels?.name}`;
    const current = newest.get(key);
    if (!current || revisionOf(secret) > revisionOf(current)) newest.set(key, secret);
  }
  return [...newest.values()]
    .map((secret) => summary(secret, safeDecode(secret)))
    .sort((left, right) => left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name));
}

export function releaseDetail(secrets: HelmSecretLike[]): HelmReleaseDetail {
  const revisions = secrets.filter(isRelease).sort((left, right) => revisionOf(right) - revisionOf(left));
  const newest = revisions[0];
  if (!newest) throw new Error("No Helm release by that name here.");
  const release = safeDecode(newest);
  const history: HelmRevision[] = revisions.map((secret) => {
    const decoded = secret === newest ? release : safeDecode(secret);
    return {
      revision: decoded?.version ?? revisionOf(secret),
      status: decoded?.info?.status ?? secret.metadata?.labels?.status ?? "unknown",
      updated: decoded?.info?.last_deployed ?? "",
      chartVersion: decoded?.chart?.metadata?.version ?? "",
      appVersion: decoded?.chart?.metadata?.appVersion ?? "",
      description: decoded?.info?.description ?? "",
    };
  });
  const config = release?.config ?? {};
  return {
    ...summary(newest, release),
    values: Object.keys(config).length > 0 ? stringify(config) : "",
    manifest: release?.manifest ?? "",
    notes: release?.info?.notes ?? "",
    history,
  };
}

export function helmArgs(action: "rollback" | "uninstall", name: string, namespace: string, revision: number | undefined, kubeconfig: string, context: string): string[] {
  const base = action === "rollback"
    ? ["rollback", name, ...(revision ? [String(revision)] : [])]
    : ["uninstall", name];
  return [...base, "--namespace", namespace, "--kube-context", context, "--kubeconfig", kubeconfig, "--wait", "--timeout", "5m0s"];
}

export function helmCommandLine(action: "rollback" | "uninstall", name: string, namespace: string, revision?: number): string {
  return action === "rollback"
    ? `helm rollback ${name}${revision ? ` ${revision}` : ""} -n ${namespace}`
    : `helm uninstall ${name} -n ${namespace}`;
}

export type HelmRun = (args: string[], options?: { timeoutMs?: number }) => Promise<string>;

// Runs the helm CLI. Helm owns chart rendering, hooks, and release bookkeeping, so installs go through it
// rather than being re-implemented here.
export function createHelmRunner(exec: typeof import("node:child_process").execFile): HelmRun {
  return (args, options = {}) => new Promise((resolve, reject) => {
    exec("helm", args, { timeout: options.timeoutMs ?? 330_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new Error(missing
          ? "The helm command is not installed or not on PATH. Install Helm 3 (https://helm.sh/docs/intro/install/) and restart Podgaze."
          : String(stderr || error.message).replace(/^Error: /, "").trim()));
        return;
      }
      resolve(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim());
    });
  });
}

export function parseRepos(output: string): { name: string; url: string }[] {
  if (!output.trim().startsWith("[")) return [];
  return (JSON.parse(output) as { name?: string; url?: string }[])
    .filter((repo) => repo.name && repo.url)
    .map((repo) => ({ name: repo.name!, url: repo.url! }));
}

export function parseCharts(output: string): { name: string; version: string; appVersion: string; description: string }[] {
  if (!output.trim().startsWith("[")) return [];
  return (JSON.parse(output) as { name?: string; version?: string; app_version?: string; description?: string }[])
    .filter((chart) => chart.name)
    .map((chart) => ({ name: chart.name!, version: chart.version ?? "", appVersion: chart.app_version ?? "", description: chart.description ?? "" }));
}

const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function installArgs(request: { release: string; namespace: string; chart: string; version?: string; createNamespace?: boolean; dryRun?: boolean; upgrade?: boolean }, valuesFile: string, kubeconfig: string, context: string): string[] {
  if (!RELEASE_NAME.test(request.release) || request.release.length > 53) {
    throw new Error("A release name is lowercase letters, digits, and dashes, up to 53 characters.");
  }
  if (!request.chart.trim()) throw new Error("Choose a chart.");
  return [
    request.upgrade ? "upgrade" : "install",
    request.release,
    request.chart.trim(),
    "--namespace", request.namespace,
    "--values", valuesFile,
    ...(request.version?.trim() ? ["--version", request.version.trim()] : []),
    ...(request.createNamespace && !request.upgrade ? ["--create-namespace"] : []),
    ...(request.dryRun ? ["--dry-run=server"] : []),
    "--kube-context", context,
    "--kubeconfig", kubeconfig,
    "--timeout", "5m0s",
  ];
}

export function installCommandLine(request: { release: string; namespace: string; chart: string; version?: string; createNamespace?: boolean; upgrade?: boolean }): string {
  return `helm ${request.upgrade ? "upgrade" : "install"} ${request.release} ${request.chart} -n ${request.namespace}${request.version ? ` --version ${request.version}` : ""}${request.createNamespace && !request.upgrade ? " --create-namespace" : ""} -f values.yaml`;
}
