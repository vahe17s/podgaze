export function formatAge(iso: string, now = Date.now()): string {
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return "";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function isHealthy(status: string): boolean {
  return status === "Running" || status === "Succeeded" || status === "Ready" || status === "Completed" || status === "Available" || status === "Bound" || status === "Active" || status === "Complete" || status === "Normal"
    // Helm release states and the health words operators like Argo CD use.
    || status === "deployed" || status === "superseded" || status === "Healthy" || status === "Synced"
    // A Secret's "status" column is its type, which says nothing about health.
    || status === "Valid"
    || status === "Opaque" || status.startsWith("kubernetes.io/") || status.startsWith("helm.sh/") || status.startsWith("bootstrap.kubernetes.io/");
}

export function statusTone(status: string): "ok" | "warn" | "bad" {
  if (isHealthy(status)) return "ok";
  if (status === "Pending" || status === "ContainerCreating" || status === "Progressing" || status === "PodInitializing" || status === "Suspended" || status === "Empty") return "warn";
  if (status === "Renew soon" || status === "Stale") return "warn";
  if (status.startsWith("pending-") || status === "uninstalling" || status === "Missing" || status.includes("OutOfSync")) return "warn";
  return "bad";
}
