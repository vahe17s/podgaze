import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { VolumeReport, ArgoApp, CertInfo, ClusterClient, ClusterWarning, DeploymentRow, NodeRow, PodRow, ResourceRef } from "@podgaze/contracts";
import { averageUsage, costReport, loadDiscount, loadPrices, loadStoragePrices, money } from "./cost";
import { formatAge, statusTone } from "./format";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { useProjects } from "./projects-view";
import { SearchSelect } from "./search-select";
import { readUsageHistory, usageHistoryKey } from "./usage";
import { inScope, needsRenewal, teamHealth, type TeamScope } from "./team";

type Loaded<T> = { data: T | null; error: string | null };

function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null });
  useEffect(() => {
    let gone = false;
    setState({ data: null, error: null });
    load().then(
      (data) => {
        if (!gone) setState({ data, error: null });
      },
      (reason: unknown) => {
        if (!gone) setState({ data: null, error: reason instanceof Error ? reason.message : "Could not load" });
      },
    );
    return () => {
      gone = true;
    };
  }, [key]);
  return state;
}

function Card({ title, note, action, children }: { title: string; note?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="team-card" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {note ? <span className="muted">{note}</span> : null}
        <span className="head-spacer" />
        {action}
      </header>
      {children}
    </section>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone: "ok" | "warn" | "bad" | "none" }) {
  return (
    <div className={`stat-tile ${tone === "none" ? "ok" : tone}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-note">{note}</span>
    </div>
  );
}

const MAX_ROWS = 8;

// One page for one namespace or one team's project: is it healthy, what does it cost, and what is about to expire.
export function TeamView({ client, clusterId, namespaces, currentNamespace, pods, nodes, deployments, refreshKey, onNavigate, onOpenView }: {
  client: ClusterClient;
  clusterId: string | null;
  namespaces: string[];
  currentNamespace: string | null;
  pods: PodRow[];
  nodes: NodeRow[];
  deployments: DeploymentRow[];
  refreshKey: string;
  onNavigate: (ref: ResourceRef) => void;
  onOpenView: (view: "Cost" | "Certificates" | "Argo") => void;
}) {
  const { projects } = useProjects(clusterId);
  const [pick, setPick] = useState<string>(() => (currentNamespace ? `ns:${currentNamespace}` : ""));

  // The sidebar's namespace drives the page when the page shows a single namespace.
  useEffect(() => {
    if (currentNamespace && (pick === "" || pick.startsWith("ns:"))) setPick(`ns:${currentNamespace}`);
  }, [currentNamespace]);

  const scope: TeamScope | null = useMemo(() => {
    if (pick.startsWith("ns:")) return { id: pick, title: pick.slice(3), namespaces: [pick.slice(3)], labels: "" };
    const project = projects.find((item) => `project:${item.id}` === pick);
    return project ? { id: pick, title: project.name, namespaces: project.namespaces, labels: project.labels } : null;
  }, [pick, projects]);

  // Rows only arrive for the namespace the sidebar watches; a project across several needs all of them.
  const missing = scope && currentNamespace !== null && !(scope.namespaces.length === 1 && scope.namespaces[0] === currentNamespace);
  function choose(value: string) {
    setPick(value);
    if (value.startsWith("ns:")) void client.setNamespace(value.slice(3));
    else {
      const project = projects.find((item) => `project:${item.id}` === value);
      if (project) void client.setNamespace(project.namespaces.length === 1 ? project.namespaces[0]! : null);
    }
  }

  const scopeKey = `${scope?.id ?? ""}|${scope?.namespaces.join(",") ?? ""}|${refreshKey}`;
  const scopedPods = useMemo(() => (scope ? inScope(pods, scope) : []), [pods, scope]);
  const scopedDeployments = useMemo(() => (scope ? inScope(deployments, scope) : []), [deployments, scope]);
  const health = useMemo(() => teamHealth(scopedPods, scopedDeployments), [scopedPods, scopedDeployments]);
  const volumes = useLoad<VolumeReport>(() => client.listVolumes(), scope ? scopeKey : "");
  const cost = useMemo(() => {
    const podNames = new Set(scopedPods.map((pod) => `${pod.namespace}/${pod.name}`));
    // A project narrowed by labels owns only the volumes its pods mount; a whole namespace owns all of them.
    const scopedVolumes = (volumes.data?.volumes ?? []).filter((volume) => scope?.namespaces.includes(volume.namespace)
      && (!scope.labels.trim() || volume.usedBy.some((pod) => podNames.has(`${volume.namespace}/${pod}`))));
    const report = costReport(scopedPods, nodes, loadPrices(), {
      discount: loadDiscount(),
      storagePrices: loadStoragePrices(),
      volumes: scopedVolumes,
      usageOf: (pod) => averageUsage(readUsageHistory(usageHistoryKey(clusterId ?? "", "pod", pod.name, pod.namespace))),
    });
    const hourly = report.namespaces.reduce((sum, item) => sum + item.hourly + item.storageHourly, 0);
    const workloads = report.namespaces.flatMap((item) => item.workloads.map((workload) => ({ ...workload, namespace: item.namespace }))).sort((left, right) => right.hourly - left.hourly);
    const used = report.namespaces.every((item) => item.usedHourly === null) ? null : report.namespaces.reduce((sum, item) => sum + (item.usedHourly ?? 0), 0);
    return { hourly, used, workloads, unpriced: report.unpriced.length > 0 };
  }, [scopedPods, nodes, volumes.data, scope, clusterId]);

  const warnings = useLoad<ClusterWarning[]>(() => client.listWarnings(), scope ? scopeKey : "");
  const certs = useLoad<CertInfo[]>(() => client.listCertificates(), scope ? scopeKey : "");
  const argo = useLoad<ArgoApp[]>(() => client.listArgoApps(), scope ? scopeKey : "");

  const scopeWarnings = (warnings.data ?? []).filter((item) => scope?.namespaces.includes(item.namespace));
  const expiring = scope ? needsRenewal(certs.data ?? [], scope.namespaces) : [];
  const apps = (argo.data ?? []).filter((app) => scope?.namespaces.includes(app.destNamespace));

  const options = [
    ...(pick ? [] : [{ value: "", label: "Pick a namespace or project" }]),
    ...projects.map((project) => ({ value: `project:${project.id}`, label: project.name, detail: `Project · ${project.namespaces.join(", ")}` })),
    ...namespaces.map((namespace) => ({ value: `ns:${namespace}`, label: namespace, detail: "Namespace" })),
  ];

  return (
    <div className="team-view">
      <div className="team-head">
        <SearchSelect label="Namespace or project" value={pick} placeholder="Find a namespace or project" options={options} onPick={choose} />
        {scope ? <span className="muted">{scope.namespaces.length > 1 || scope.labels ? `${scope.namespaces.join(", ")}${scope.labels ? ` · ${scope.labels}` : ""}` : ""}</span> : null}
      </div>
      {!scope ? <p className="empty-state">Pick a namespace, or a project from the Projects page to see a whole team at once.</p> : null}
      {scope && missing ? (
        <p className="warn-note">
          The sidebar is watching {currentNamespace}, so pods here are not loaded.{" "}
          <button type="button" className="link-btn" onClick={() => choose(pick)}>Watch {scope.namespaces.length === 1 ? scope.namespaces[0] : "all namespaces"}</button>
        </p>
      ) : null}
      {scope ? (
        <>
          <div className="stat-row team-tiles">
            <Tile label="Health" value={`${health.running}/${health.pods}`} note={health.verdict} tone={health.tone} />
            <Tile label="Cost per month" value={cost.unpriced && cost.hourly === 0 ? "—" : money(cost.hourly)} note={cost.unpriced ? "Some node prices missing" : cost.used !== null ? `${money(cost.used)} actually used` : "By requests, incl. storage"} tone="none" />
            <Tile label="Expiring" value={certs.data ? String(expiring.length) : "…"} note={expiring.length === 0 ? "Nothing within 30 days" : `Soonest: ${expiring[0]!.name}`} tone={expiring.some((item) => (item.days ?? 0) < 7) ? "bad" : expiring.length ? "warn" : "ok"} />
          </div>

          <div className="team-grid">
            <Card title="Needs attention" note={health.tone === "ok" ? "Nothing failing" : `${health.degraded.length + health.failingPods.length} to look at`}>
              {health.degraded.length === 0 && health.failingPods.length === 0 ? <p className="muted">All {health.pods} pods are running; {health.restarts} restarts in total.</p> : null}
              <ul className="team-list">
                {health.degraded.slice(0, MAX_ROWS).map((deployment) => (
                  <li key={deployment.uid}>
                    <button type="button" className="related-link" onClick={() => onNavigate({ kind: "Deployment", namespace: deployment.namespace, name: deployment.name })}>
                      <span className={`status ${deployment.ready.startsWith("0/") ? "bad" : "warn"}`}>{deployment.ready}</span>
                      <span className="related-name">{deployment.name}</span>
                      <span className="muted">Deployment · {deployment.namespace}</span>
                    </button>
                  </li>
                ))}
                {health.failingPods.slice(0, MAX_ROWS).map((pod) => (
                  <li key={pod.uid}>
                    <button type="button" className="related-link" onClick={() => onNavigate({ kind: "Pod", namespace: pod.namespace, name: pod.name })}>
                      <span className={`status ${statusTone(pod.status)}`}>{pod.status}</span>
                      <span className="related-name">{pod.name}</span>
                      <span className="muted">{pod.restarts} restarts{pod.lastExit ? ` · ${pod.lastExit}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Recent warnings" note={warnings.data ? `${scopeWarnings.length}` : undefined}>
              {warnings.error ? <p className="problem">{warnings.error}</p> : null}
              {!warnings.data && !warnings.error ? <GazeInline label="Reading events…" /> : null}
              {warnings.data && scopeWarnings.length === 0 ? <p className="muted">No warning events.</p> : null}
              <ul className="team-list">
                {scopeWarnings.slice(0, MAX_ROWS).map((warning, index) => (
                  <li key={`${warning.time}-${index}`}>
                    <button type="button" className="related-link" disabled={!warning.object} onClick={() => warning.object && onNavigate(warning.object)}>
                      <span className="status warn">{warning.reason}{warning.count > 1 ? ` ×${warning.count}` : ""}</span>
                      <span className="related-name">{warning.objectLabel}</span>
                      <span className="muted team-message" title={warning.message}>{formatAge(warning.time)} · {warning.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Cost" note={cost.hourly > 0 ? "Most expensive workloads" : "Largest requests; set node prices to see money"} action={<button type="button" className="link-btn" onClick={() => onOpenView("Cost")}>{cost.unpriced ? "Set prices" : "All costs"}</button>}>
              {cost.workloads.length === 0 ? <p className="muted">No running pods.</p> : null}
              <ul className="team-list">
                {cost.workloads.slice(0, MAX_ROWS).map((workload) => (
                  <li key={`${workload.namespace}/${workload.kind}/${workload.name}`}>
                    <button type="button" className="related-link" onClick={() => onNavigate({ kind: workload.kind as ResourceRef["kind"], namespace: workload.namespace, name: workload.name })}>
                      <span className="mono team-money">{cost.hourly > 0 ? money(workload.hourly + workload.storageHourly) : `${workload.cpuMillicores}m`}</span>
                      <span className="related-name">{workload.name}</span>
                      <span className="muted">{workload.kind} · {workload.pods} pod{workload.pods === 1 ? "" : "s"}{cost.hourly > 0 ? "" : ` · ${Math.round(workload.memoryBytes / 1024 / 1024)}Mi requested`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Expiring" note="Certificates and secret syncs" action={<button type="button" className="link-btn" onClick={() => onOpenView("Certificates")}>All</button>}>
              {certs.error ? <p className="problem">{certs.error}</p> : null}
              {!certs.data && !certs.error ? <GazeInline label="Reading certificates…" /> : null}
              {certs.data && expiring.length === 0 ? <p className="muted">Nothing expires within 30 days and every sync is healthy.</p> : null}
              <ul className="team-list">
                {expiring.slice(0, MAX_ROWS).map((cert) => (
                  <li key={`${cert.source}/${cert.name}`}>
                    <button type="button" className="related-link" onClick={() => onNavigate(cert.source === "Certificate"
                      ? { kind: "certificates.cert-manager.io", namespace: cert.namespace, name: cert.name }
                      : cert.source === "ExternalSecret" ? { kind: "externalsecrets.external-secrets.io", namespace: cert.namespace, name: cert.name } : { kind: "Secret", namespace: cert.namespace, name: cert.name })}>
                      <span className={`status ${cert.days === null || cert.days < 7 ? "bad" : "warn"}`}>{cert.days === null ? "Sync failing" : cert.days < 0 ? "Expired" : `${cert.days}d`}</span>
                      <span className="related-name">{cert.name}</span>
                      <span className="muted">{cert.source === "ExternalSecret" ? cert.problem : cert.dnsNames[0] ?? cert.subject}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            {apps.length > 0 ? (
              <Card title="Argo CD" note={`${apps.length} app${apps.length === 1 ? "" : "s"}`} action={<button type="button" className="link-btn" onClick={() => onOpenView("Argo")}>Open</button>}>
                <ul className="team-list">
                  {apps.slice(0, MAX_ROWS).map((app) => (
                    <li key={`${app.namespace}/${app.name}`}>
                      <span className="related-link static">
                        <span className={`status ${statusTone(app.health)}`}>{app.health}</span>
                        <span className="related-name">{app.name}</span>
                        <span className="muted">{app.sync}{app.revision ? ` · ${app.revision.slice(0, 8)}` : ""}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        </>
      ) : null}
      <p className="muted team-foot"><Icon name="refresh" /> Health and cost follow the live rows; the rest reloads when you switch here.</p>
    </div>
  );
}
