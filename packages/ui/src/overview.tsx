import { useEffect, useState } from "react";
import { cpuMillicores, memoryBytes, type ClusterClient, type ClusterWarning, type DeploymentRow, type NodeRow, type PodRow, type ResourceKind, type ResourceRef, type UsagePoint } from "@podgaze/contracts";
import { formatAge, statusTone } from "./format";
import { GazeInline } from "./loader";
import { formatCpu, formatMemory, readUsageHistory, usageHistoryKey, useUsage, useUsageTick } from "./usage";
import { sizingHints } from "./rightsizing";

type Slice = { label: string; value: number; color: string };

export type OpenView = (view: ResourceKind, filter?: { problems?: boolean; warnings?: boolean }) => void;

type Issue = {
  ref: ResourceRef;
  status: string;
  detail: string;
  severity: number;
};

const ATTENTION_SHOWN = 8;
const HOUR = 3_600_000;

// A pod that is Running again but keeps getting killed is still a problem.
export function podIssue(pod: PodRow): Issue | null {
  const tone = statusTone(pod.status);
  const crashed = pod.restarts > 0 && pod.lastExit !== "";
  if (tone === "ok" && !crashed) return null;
  const parts = [
    pod.restarts > 0 ? `${pod.restarts} restart${pod.restarts === 1 ? "" : "s"}` : "",
    pod.lastExit ? `last exit ${pod.lastExit}` : "",
    pod.ready !== "" && tone !== "ok" ? `${pod.ready} ready` : "",
  ].filter(Boolean);
  return {
    ref: { kind: "Pod", namespace: pod.namespace, name: pod.name },
    status: pod.status,
    detail: parts.join(" · "),
    severity: (tone === "bad" ? 0 : tone === "warn" ? 1 : 2) * 100_000 - pod.restarts,
  };
}

export function attention(pods: PodRow[], deployments: DeploymentRow[], nodes: NodeRow[]): Issue[] {
  const issues: Issue[] = [];
  for (const node of nodes) {
    if (node.status === "Ready") continue;
    issues.push({
      ref: { kind: "Node", namespace: null, name: node.name },
      status: node.unschedulable && node.status.startsWith("Ready") ? "Cordoned" : node.status.split(",")[0] ?? node.status,
      detail: node.unschedulable ? "scheduling disabled" : "node not ready",
      // A node that is down takes its pods with it, so it outranks any single pod.
      severity: node.status.startsWith("Ready") ? 150_000 : -1_000_000,
    });
  }
  for (const deployment of deployments) {
    if (statusTone(deployment.status) === "ok") continue;
    issues.push({
      ref: { kind: "Deployment", namespace: deployment.namespace, name: deployment.name },
      status: deployment.status,
      detail: `${deployment.ready} ready`,
      severity: 50_000,
    });
  }
  for (const pod of pods) {
    const issue = podIssue(pod);
    if (issue) issues.push(issue);
  }
  return issues.sort((left, right) => left.severity - right.severity);
}

export function Overview({
  client,
  refreshKey,
  pods,
  nodes,
  deployments,
  onNavigate = () => undefined,
  onOpenView = () => undefined,
}: {
  client: ClusterClient;
  refreshKey: string;
  pods: PodRow[];
  nodes: NodeRow[];
  deployments: DeploymentRow[];
  onNavigate?: (ref: ResourceRef) => void;
  onOpenView?: OpenView;
}) {
  const usage = useUsage(client, true, refreshKey);
  const warnings = useWarnings(client, refreshKey);
  const [showAll, setShowAll] = useState(false);
  const issues = attention(pods, deployments, nodes);
  const failingPods = pods.filter((pod) => podIssue(pod) !== null).length;
  const runningPods = pods.filter((pod) => pod.status === "Running" || pod.status === "Succeeded" || pod.status === "Completed").length;
  const readyNodes = nodes.filter((node) => node.status.startsWith("Ready")).length;
  const cordoned = nodes.filter((node) => node.unschedulable).length;
  const available = deployments.filter((deployment) => statusTone(deployment.status) === "ok").length;
  const recentWarnings = (warnings ?? []).filter((item) => Date.now() - Date.parse(item.time) < HOUR);
  const shown = showAll ? issues : issues.slice(0, ATTENTION_SHOWN);

  return (
    <div className="overview">
      <div className="stat-row">
        <StatTile
          label="Pods"
          value={`${runningPods}/${pods.length}`}
          note={failingPods > 0 ? `${failingPods} need${failingPods === 1 ? "s" : ""} attention` : "all healthy"}
          tone={failingPods > 0 ? "bad" : "ok"}
          onClick={() => onOpenView("Pod", { problems: failingPods > 0 })}
        />
        <StatTile
          label="Nodes"
          value={`${readyNodes}/${nodes.length}`}
          note={readyNodes < nodes.length ? `${nodes.length - readyNodes} not ready` : cordoned > 0 ? `${cordoned} cordoned` : "all ready"}
          tone={readyNodes < nodes.length ? "bad" : cordoned > 0 ? "warn" : "ok"}
          onClick={() => onOpenView("Node", { problems: readyNodes < nodes.length || cordoned > 0 })}
        />
        <StatTile
          label="Deployments"
          value={`${available}/${deployments.length}`}
          note={available < deployments.length ? `${deployments.length - available} not available` : "all available"}
          tone={available < deployments.length ? "warn" : "ok"}
          onClick={() => onOpenView("Deployment", { problems: available < deployments.length })}
        />
        <StatTile
          label="Warnings"
          value={warnings ? String(recentWarnings.length) : "—"}
          note={warnings ? "in the last hour" : "loading"}
          tone={recentWarnings.length > 0 ? "warn" : "ok"}
          onClick={() => onOpenView("Event", { warnings: true })}
        />
      </div>

      <section className="card span-7" aria-label="Needs attention">
        <header className="card-head">
          <h2>Needs attention</h2>
          {issues.length > 0 ? <span className="status bad">{issues.length}</span> : null}
        </header>
        {issues.length === 0 ? (
          <p className="all-good">Nothing needs attention. Pods, deployments, and nodes are healthy.</p>
        ) : (
          <ul className="issue-list">
            {shown.map((issue) => (
              <li key={`${issue.ref.kind}/${issue.ref.namespace ?? ""}/${issue.ref.name}`}>
                <button type="button" className="row-link" aria-label={`Open ${issue.ref.kind} ${issue.ref.name}`} onClick={() => onNavigate(issue.ref)}>
                  <span className={`status ${statusTone(issue.status)}`}>{issue.status}</span>
                  <span className="row-main">
                    <strong>{issue.ref.name}</strong>
                    <small>{issue.ref.kind}{issue.ref.namespace ? ` · ${issue.ref.namespace}` : ""}</small>
                  </span>
                  <span className="row-detail">{issue.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {issues.length > ATTENTION_SHOWN ? (
          <button type="button" className="link-btn" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${issues.length}`}
          </button>
        ) : null}
      </section>

      <section className="card span-5" aria-label="Recent warnings">
        <header className="card-head">
          <h2>Recent warnings</h2>
          <button type="button" className="link-btn" onClick={() => onOpenView("Event", { warnings: true })}>All events →</button>
        </header>
        {!warnings ? <GazeInline label="Reading events…" /> : null}
        {warnings && warnings.length === 0 ? <p className="all-good">No warning events.</p> : null}
        {warnings && warnings.length > 0 ? (
          <ul className="warning-list">
            {warnings.slice(0, 8).map((warning, index) => (
              <li key={`${warning.time}-${warning.reason}-${index}`}>
                <button
                  type="button"
                  className="row-link"
                  disabled={!warning.object}
                  title={warning.object ? `Open ${warning.objectLabel}` : `${warning.objectLabel} no longer exists or is not a kind Podgaze lists`}
                  onClick={() => warning.object && onNavigate(warning.object)}
                >
                  <span className="warning-when">{formatAge(warning.time) || "—"}</span>
                  <span className="row-main">
                    <strong className="warning-reason">{warning.reason}{warning.count > 1 ? <em> ×{warning.count}</em> : null}</strong>
                    <small>{warning.objectLabel}{warning.namespace ? ` · ${warning.namespace}` : ""}</small>
                    <span className="warning-message">{warning.message}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card span-6" aria-label="Nodes">
        <header className="card-head"><h2>Nodes</h2></header>
        {nodes.length === 0 ? <p className="muted">No nodes reported yet.</p> : null}
        <ul className="node-list">
          {nodes.map((node) => {
            const sample = usage?.available ? usage.nodes.find((item) => item.name === node.name) : undefined;
            const podCount = pods.filter((pod) => pod.nodeName === node.name).length;
            const podCap = Number(node.podCapacity) || 0;
            return (
              <li key={node.uid}>
                <button type="button" className="row-link node-row" aria-label={`Open Node ${node.name}`} onClick={() => onNavigate({ kind: "Node", namespace: null, name: node.name })}>
                  <span className="row-main">
                    <strong title={node.name}>{node.name}</strong>
                    <span className={`status ${statusTone(node.status.split(",")[0] ?? node.status)}`}>{node.unschedulable ? "Cordoned" : node.status}</span>
                  </span>
                  <Usage label="CPU" used={sample?.cpuMillicores} total={cpuMillicores(node.cpu)} format={formatCpu} />
                  <Usage label="Memory" used={sample?.memoryBytes} total={memoryBytes(node.memory)} format={formatMemory} />
                  <Usage label="Pods" used={podCount} total={podCap} format={(value) => String(Math.round(value))} />
                </button>
              </li>
            );
          })}
        </ul>
        {usage && !usage.available ? <p className="muted">The metrics server is not reporting usage, so only pod counts are shown.</p> : null}
      </section>

      <section className="card span-6" aria-label="Top pods">
        <TopPods usage={usage?.available ? usage.pods : null} pods={pods} loading={!usage} onNavigate={onNavigate} />
      </section>


      <section className="card span-4" aria-label="Pod status">
        <header className="card-head"><h2>Pod status</h2></header>
        <PodStatus pods={pods} />
      </section>

      <section className="card span-8" aria-label="Pods per namespace">
        <header className="card-head">
          <h2>Pods per namespace</h2>
          <small className="muted">Click to switch namespace</small>
        </header>
        <Namespaces pods={pods} onPick={(namespace) => void client.setNamespace(namespace)} />
      </section>

      <section className="card span-12" aria-label="Right-sizing">
        <RightSizing pods={pods} cluster={refreshKey.split(":")[0] ?? ""} available={Boolean(usage?.available)} onNavigate={onNavigate} />
      </section>
    </div>
  );
}

function useWarnings(client: ClusterClient, refreshKey: string) {
  const [warnings, setWarnings] = useState<ClusterWarning[] | null>(null);
  useEffect(() => {
    let stop = false;
    setWarnings(null);
    async function load() {
      try {
        const next = await client.listWarnings();
        if (!stop) setWarnings(next);
      } catch {
        if (!stop) setWarnings([]);
      }
    }
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [client, refreshKey]);
  return warnings;
}

function StatTile({ label, value, note, tone, onClick }: { label: string; value: string; note: string; tone: "ok" | "warn" | "bad"; onClick: () => void }) {
  return (
    <button type="button" className={`stat-tile ${tone}`} aria-label={`${label} ${value}, ${note}`} onClick={onClick}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-note">{note}</span>
    </button>
  );
}

function usageTone(pct: number): string {
  if (pct > 90) return "var(--bad)";
  if (pct > 75) return "var(--warn)";
  return "var(--accent)";
}

// Usage against real capacity. Without a sample (no metrics server) the row says so instead of drawing 0%.
function Usage({ label, used, total, format }: { label: string; used: number | undefined; total: number; format: (value: number) => string }) {
  const pct = used !== undefined && total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <span className="usage-line">
      <span className="usage-label">{label}</span>
      <span className="bar"><span style={{ width: `${pct}%`, background: usageTone(pct) }} /></span>
      <span className="usage-value">{used === undefined ? "—" : `${format(used)} / ${format(total)}`}</span>
    </span>
  );
}

function specTitle(label: string, used: number, request: number | undefined, limit: number | undefined, format: (value: number) => string): string {
  return `${label}: ${format(used)} used · request ${request ? format(request) : "none"} · limit ${limit ? format(limit) : "none"}. The tick marks the request.`;
}

function TopPods({ usage, pods, loading, onNavigate }: { usage: UsagePoint[] | null; pods: PodRow[]; loading: boolean; onNavigate: (ref: ResourceRef) => void }) {
  const specOf = (row: UsagePoint) => pods.find((pod) => pod.name === row.name && pod.namespace === row.namespace);
  const [by, setBy] = useState<"cpu" | "memory">("cpu");
  const rows = [...(usage ?? [])]
    .sort((left, right) => by === "cpu" ? right.cpuMillicores - left.cpuMillicores : right.memoryBytes - left.memoryBytes)
    .slice(0, 8);
  const topCpu = Math.max(1, ...rows.map((row) => row.cpuMillicores));
  const topMemory = Math.max(1, ...rows.map((row) => row.memoryBytes));
  return (
    <>
      <header className="card-head">
        <h2>Top pods</h2>
        <div className="segmented" role="group" aria-label="Rank pods by">
          <button type="button" aria-pressed={by === "cpu"} onClick={() => setBy("cpu")}>CPU</button>
          <button type="button" aria-pressed={by === "memory"} onClick={() => setBy("memory")}>Memory</button>
        </div>
      </header>
      {loading ? <GazeInline label="Reading metrics…" /> : null}
      {!loading && !usage ? <p className="muted">The metrics server is not reporting pod usage.</p> : null}
      {usage && rows.length === 0 ? <p className="muted">No pod metrics yet.</p> : null}
      {rows.length > 0 ? (
        <ul className="top-pods">
          <li className="top-pods-head" aria-hidden="true">
            <span>Pod</span>
            <span>CPU</span>
            <span>Memory</span>
          </li>
          {rows.map((row) => (
            <li key={`${row.namespace}/${row.name}`}>
              <button type="button" className="row-link" aria-label={`Open Pod ${row.name}`} onClick={() => onNavigate({ kind: "Pod", namespace: row.namespace, name: row.name })}>
                <span className="row-main">
                  <strong>{row.name}</strong>
                  <small>{row.namespace}</small>
                </span>
                {/* Bars compare pods with each other; they are not a percentage of any limit. */}
                <span className="top-metric" title={specTitle("CPU", row.cpuMillicores, specOf(row)?.requests.cpuMillicores, specOf(row)?.limits.cpuMillicores, formatCpu)}>
                  <span className="bar">
                    <span style={{ width: `${(row.cpuMillicores / topCpu) * 100}%` }} />
                    {specOf(row)?.requests.cpuMillicores ? <i className="req-mark" style={{ left: `${Math.min(100, (specOf(row)!.requests.cpuMillicores / topCpu) * 100)}%` }} /> : null}
                  </span>
                  <span>{formatCpu(row.cpuMillicores)}</span>
                </span>
                <span className="top-metric" title={specTitle("Memory", row.memoryBytes, specOf(row)?.requests.memoryBytes, specOf(row)?.limits.memoryBytes, formatMemory)}>
                  <span className="bar">
                    <span style={{ width: `${(row.memoryBytes / topMemory) * 100}%` }} />
                    {specOf(row)?.requests.memoryBytes ? <i className="req-mark" style={{ left: `${Math.min(100, (specOf(row)!.requests.memoryBytes / topMemory) * 100)}%` }} /> : null}
                  </span>
                  <span>{formatMemory(row.memoryBytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const statusColors: Record<"ok" | "warn" | "bad", string> = { ok: "#3fb950", warn: "#d29922", bad: "#f85149" };

function PodStatus({ pods }: { pods: PodRow[] }) {
  const counts = new Map<string, number>();
  for (const pod of pods) counts.set(pod.status, (counts.get(pod.status) ?? 0) + 1);
  const slices: Slice[] = [...counts.entries()]
    .map(([label, value]) => ({ label, value, color: statusColors[statusTone(label)] }))
    .sort((left, right) => right.value - left.value);
  if (pods.length === 0) return <p className="muted">No pods in view.</p>;
  return (
    <div className="chart-row">
      <Donut slices={slices} />
      <ul className="legend">
        {slices.map((slice) => (
          <li key={slice.label}>
            <i style={{ background: slice.color }} />
            <span title={slice.label}>{slice.label}</span>
            <strong>{slice.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Namespaces({ pods, onPick }: { pods: PodRow[]; onPick: (namespace: string) => void }) {
  const counts = new Map<string, { total: number; failing: number }>();
  for (const pod of pods) {
    const entry = counts.get(pod.namespace) ?? { total: 0, failing: 0 };
    entry.total += 1;
    if (podIssue(pod)) entry.failing += 1;
    counts.set(pod.namespace, entry);
  }
  const rows = [...counts.entries()].sort((left, right) => right[1].total - left[1].total);
  const widest = Math.max(1, ...rows.map(([, entry]) => entry.total));
  if (rows.length === 0) return <p className="muted">No pods in view.</p>;
  return (
    <ul className="ns-list">
      {rows.map(([namespace, entry]) => (
        <li key={namespace}>
          <button type="button" className="row-link" aria-label={`Switch to namespace ${namespace}`} onClick={() => onPick(namespace)}>
            <span className="ns-name">{namespace || "default"}</span>
            <span className="bar stacked">
              <span style={{ width: `${((entry.total - entry.failing) / widest) * 100}%` }} />
              <span className="failing" style={{ width: `${(entry.failing / widest) * 100}%` }} />
            </span>
            <strong>{entry.total}</strong>
            {entry.failing > 0 ? <span className="status bad">{entry.failing} failing</span> : <span className="ns-ok">healthy</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Donut({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg className="donut" viewBox="0 0 120 120" role="img" aria-label={`${total} pods`}>
      <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--track)" strokeWidth="14" />
      {total > 0 ? slices.map((slice) => {
        const length = (slice.value / total) * circumference;
        const element = (
          <circle
            key={slice.label}
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke={slice.color}
            strokeWidth="14"
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 60 60)"
          />
        );
        offset += length;
        return element;
      }) : null}
      <text x="60" y="58" textAnchor="middle">{total}</text>
      <text x="60" y="74" textAnchor="middle">pods</text>
    </svg>
  );
}

const hintLabels = { "near-memory-limit": "Near memory limit", "no-requests": "No requests", "over-cpu": "CPU over-requested", "over-memory": "Memory over-requested" } as const;

function RightSizing({ pods, cluster, available, onNavigate }: { pods: PodRow[]; cluster: string; available: boolean; onNavigate: (ref: ResourceRef) => void }) {
  useUsageTick();
  const hints = sizingHints(pods, (pod) => readUsageHistory(usageHistoryKey(cluster, "pod", pod.name, pod.namespace)));
  const sampled = pods.filter((pod) => readUsageHistory(usageHistoryKey(cluster, "pod", pod.name, pod.namespace)).length >= 4).length;
  return (
    <>
      <header className="card-head sizing-head">
        <h2>Right-sizing</h2>
        <span className="muted">Based on {sampled} pod{sampled === 1 ? "" : "s"} with a few minutes of usage. Requests reserve capacity; limits cap it.</span>
      </header>
      {!available ? <p className="muted">Needs the metrics server.</p> : null}
      {available && sampled === 0 ? <GazeInline label="Collecting usage: hints appear after a few minutes connected." /> : null}
      {available && sampled > 0 && hints.length === 0 ? <p className="muted">Requests and limits look about right for what these pods use.</p> : null}
      {hints.length > 0 ? (
        <ul className="sizing-list">
          {hints.slice(0, 10).map((hint) => (
            <li key={`${hint.namespace}/${hint.workload}/${hint.hint}`}>
              <button type="button" className="row-link" onClick={() => onNavigate({ kind: hint.kind, namespace: hint.namespace, name: hint.workload })}>
                <span className={`status ${hint.hint === "near-memory-limit" ? "bad" : hint.hint === "no-requests" ? "warn" : "muted"}`}>{hintLabels[hint.hint]}</span>
                <span className="row-main"><strong>{hint.workload}</strong><small>{hint.namespace} · {hint.pods} pod{hint.pods === 1 ? "" : "s"}</small></span>
                <span className="sizing-message">{hint.message}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
