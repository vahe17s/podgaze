import { useEffect, useState } from "react";
import type { ClusterClient, ClusterUsage, UsagePoint } from "@podgaze/contracts";

export function formatCpu(millicores: number): string {
  if (millicores >= 1000) {
    const cores = millicores / 1000;
    return `${cores >= 10 ? cores.toFixed(0) : cores.toFixed(1)} cores`;
  }
  return `${Math.round(millicores)}m`;
}

export function formatMemory(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${(bytes / gib).toFixed(bytes >= 10 * gib ? 0 : 1)}Gi`;
  if (bytes >= mib) return `${Math.round(bytes / mib)}Mi`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}Ki`;
  return `${Math.round(bytes)}B`;
}

export type UsageSample = { time: number; cpuMillicores: number; memoryBytes: number };

const HISTORY = 60;
// Pods that are gone (rollouts, CronJobs) stop getting samples; their history is dropped after this long.
const STALE_MS = 30 * 60_000;
let lastPrune = 0;
const history = new Map<string, UsageSample[]>();
const historyListeners = new Set<() => void>();

// Keeps the last 15 minutes or so of samples per pod and node, in memory, from whatever is already polling.
export function recordUsage(cluster: string, usage: ClusterUsage, now = Date.now()) {
  if (!usage.available) return;
  const add = (key: string, point: UsagePoint) => {
    const list = history.get(key) ?? [];
    const last = list[list.length - 1];
    // Two views polling at once must not double the points.
    if (last && now - last.time < 5000) return;
    history.set(key, [...list, { time: now, cpuMillicores: point.cpuMillicores, memoryBytes: point.memoryBytes }].slice(-HISTORY));
  };
  for (const point of usage.pods) add(`${cluster}|pod|${point.namespace}/${point.name}`, point);
  if (now - lastPrune > 60_000) {
    lastPrune = now;
    for (const [key, list] of history) if (now - (list[list.length - 1]?.time ?? 0) > STALE_MS) history.delete(key);
  }
  for (const point of usage.nodes) add(`${cluster}|node|${point.name}`, point);
  for (const listener of historyListeners) listener();
}

// For tests: samples otherwise live as long as the window.
export function clearUsageHistory() {
  history.clear();
}

export function readUsageHistory(key: string): UsageSample[] {
  return history.get(key) ?? [];
}

// Re-renders when new samples arrive, for views that read many histories at once.
export function useUsageTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    historyListeners.add(bump);
    return () => {
      historyListeners.delete(bump);
    };
  }, []);
  return tick;
}

export function usageHistoryKey(cluster: string, kind: "pod" | "node", name: string, namespace = ""): string {
  return kind === "pod" ? `${cluster}|pod|${namespace}/${name}` : `${cluster}|node|${name}`;
}

export function useUsageHistory(key: string): UsageSample[] {
  const [samples, setSamples] = useState<UsageSample[]>(() => history.get(key) ?? []);
  useEffect(() => {
    const refresh = () => setSamples(history.get(key) ?? []);
    refresh();
    historyListeners.add(refresh);
    return () => {
      historyListeners.delete(refresh);
    };
  }, [key]);
  return samples;
}

export function Sparkline({ values, label, format }: { values: number[]; label: string; format: (value: number) => string }) {
  if (values.length < 2) return <span className="sparkline-empty" title="A trend appears after a few readings">collecting…</span>;
  const width = 120;
  const height = 26;
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = Math.max(max - min, max * 0.05, 1);
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 2 - ((value - min) / span) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${label} trend, ${format(min)} to ${format(max)}`}>
      <title>{`${label}: ${format(min)} – ${format(max)} over ${values.length} readings`}</title>
      <polyline points={`0,${height} ${points.join(" ")} ${width},${height}`} className="sparkline-fill" />
      <polyline points={points.join(" ")} className="sparkline-line" />
    </svg>
  );
}

export function useUsage(client: ClusterClient, enabled: boolean, refreshKey: string) {
  const [usage, setUsage] = useState<ClusterUsage | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    // Context names can contain ":" (EKS ARNs); the part after the last ":" is the caller's suffix.
    const cut = refreshKey.lastIndexOf(":");
    const cluster = cut >= 0 ? refreshKey.slice(0, cut) : refreshKey;
    async function load() {
      try {
        const next = await client.readUsage();
        recordUsage(cluster, next);
        if (!stop) setUsage(next);
      } catch {
        if (!stop) setUsage({ available: false, nodes: [], pods: [] });
      }
    }
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [client, enabled, refreshKey]);
  return usage;
}

function tone(pct: number): string {
  if (pct > 90) return "var(--bad)";
  if (pct > 75) return "var(--warn)";
  return "var(--accent)";
}

function Gauge({ label, used, total, value, max, of = "" }: { label: string; used: string; total: string; value: number; max: number; of?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const detail = total ? `${used} / ${total}${of ? ` ${of}` : ""}` : used;
  const percent = max > 0 ? `${Math.round(pct)}%` : "";
  return (
    <div className="gauge">
      <div className="gauge-top">
        <span>{label}</span>
        <strong>{percent ? `${detail} · ${percent}` : detail}</strong>
      </div>
      <span className="gauge-track" role="img" aria-label={`${label} ${detail}`}>
        <i style={{ width: `${max > 0 ? pct : 0}%`, background: tone(pct) }} />
      </span>
    </div>
  );
}

export function UsageMeters({ sample, cpuCapacity, memoryCapacity, cpuOf, memoryOf }: { sample: UsagePoint; cpuCapacity: number; memoryCapacity: number; cpuOf?: string; memoryOf?: string }) {
  return (
    <div className="pod-usage">
      <Gauge label="CPU" used={formatCpu(sample.cpuMillicores)} total={cpuCapacity ? formatCpu(cpuCapacity) : ""} value={sample.cpuMillicores} max={cpuCapacity} of={cpuOf} />
      <Gauge label="Memory" used={formatMemory(sample.memoryBytes)} total={memoryCapacity ? formatMemory(memoryCapacity) : ""} value={sample.memoryBytes} max={memoryCapacity} of={memoryOf} />
    </div>
  );
}
