import { Fragment, useEffect, useMemo, useState } from "react";
import type { ClusterClient, NodeRow, PodRow, ResourceRef, VolumeReport } from "@podgaze/contracts";
import { averageUsage, costReport, HOURS_PER_MONTH, loadDiscount, loadPrices, loadStoragePrices, money, saveDiscount, savePrices, saveStoragePrices } from "./cost";
import { Icon } from "./icons";
import { formatCpu, formatMemory, readUsageHistory, usageHistoryKey, useUsage, useUsageTick } from "./usage";

const GIB = 1024 ** 3;

function PriceInput({ label, value, placeholder, onSave, width = 96 }: { label: string; value: number | undefined; placeholder: string; onSave: (text: string) => void; width?: number }) {
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      placeholder={placeholder}
      defaultValue={value ?? ""}
      key={`${label}-${value ?? ""}`}
      style={{ width }}
      onBlur={(event) => onSave(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

function parsePrice(text: string): number | null {
  const number = Number(text.trim().replace(",", "."));
  return text.trim() === "" || !Number.isFinite(number) || number < 0 ? null : number;
}

// "used / requested", with the used part dimmed when it is far below the request.
function UsedOf({ used, requested, format }: { used: number | null; requested: number; format: (value: number) => string }) {
  if (used === null) return <span>{requested ? format(requested) : "—"}</span>;
  const share = requested > 0 ? used / requested : null;
  return (
    <span className="cost-usedof">
      <span className={share !== null && share < 0.3 ? "low" : undefined}>{format(used)}</span>
      <span className="muted"> / {requested ? format(requested) : "none"}</span>
    </span>
  );
}

// What the cluster costs and who it costs for: node prices split by what each pod requests, storage by class,
// and what pods really use next to what they reserve.
export function CostView({ client, clusterId, pods, nodes, namespace, filter, onNavigate }: {
  client: ClusterClient;
  clusterId: string | null;
  pods: PodRow[];
  nodes: NodeRow[];
  namespace: string | null;
  filter: string;
  onNavigate: (ref: ResourceRef) => void;
}) {
  const [prices, setPrices] = useState<Record<string, number>>(loadPrices);
  const [discount, setDiscount] = useState(loadDiscount);
  const [storagePrices, setStoragePrices] = useState<Record<string, number>>(loadStoragePrices);
  const [volumes, setVolumes] = useState<VolumeReport | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [looking, setLooking] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const cluster = clusterId ?? "";
  const usage = useUsage(client, true, `${cluster}:cost`);
  const tick = useUsageTick();

  useEffect(() => {
    let gone = false;
    setVolumeError(null);
    setVolumes(null);
    client.listVolumes().then((found) => {
      if (!gone) setVolumes(found);
    }, (reason: unknown) => {
      if (!gone) setVolumeError(reason instanceof Error ? reason.message : "Could not read volumes");
    });
    return () => {
      gone = true;
    };
  }, [client, cluster, namespace]);

  const report = useMemo(() => costReport(pods, nodes, prices, {
    discount,
    storagePrices,
    volumes: volumes?.volumes ?? [],
    usageOf: (pod) => averageUsage(readUsageHistory(usageHistoryKey(cluster, "pod", pod.name, pod.namespace))),
  }), [pods, nodes, prices, discount, storagePrices, volumes, cluster, tick]);

  const needle = filter.trim().toLowerCase();
  const rows = report.namespaces.filter((item) => !needle || item.namespace.toLowerCase().includes(needle) || item.workloads.some((workload) => workload.name.toLowerCase().includes(needle)));
  const top = Math.max(0.000001, ...report.namespaces.map((item) => item.hourly + item.storageHourly));
  const kinds = useMemo(() => {
    const all = new Map<string, { region: string; instanceType: string; spot: boolean; count: number }>();
    for (const item of report.nodes) {
      const found = all.get(item.key) ?? { region: item.region, instanceType: item.instanceType, spot: item.spot, count: 0 };
      found.count += 1;
      all.set(item.key, found);
    }
    return [...all.entries()].sort((left, right) => right[1].count - left[1].count);
  }, [report.nodes]);
  const canLookUp = kinds.some(([, item]) => item.instanceType.startsWith("Standard_"));
  const classInfo = new Map((volumes?.classes ?? []).map((item) => [item.name, item]));

  function setPrice(key: string, text: string) {
    const next = { ...prices };
    const value = parsePrice(text);
    if (value === null) delete next[key];
    else next[key] = value;
    setPrices(next);
    savePrices(next);
  }

  function setStoragePrice(name: string, text: string) {
    const next = { ...storagePrices };
    const value = parsePrice(text);
    if (value === null) delete next[name];
    else next[name] = value;
    setStoragePrices(next);
    saveStoragePrices(next);
  }

  async function lookUp() {
    setLooking(true);
    setNotes([]);
    try {
      const quotes = await client.lookupPrices(kinds.map(([, item]) => ({ region: item.region, instanceType: item.instanceType, spot: item.spot })));
      // Merge into the prices as they are now: the user may have typed one while the lookup ran.
      setPrices((current) => {
        const next = { ...current };
        kinds.forEach(([key], index) => {
          const quote = quotes[index];
          if (quote?.hourly != null && current[key] === undefined) next[key] = quote.hourly;
        });
        savePrices(next);
        return next;
      });
      setNotes(quotes.filter((quote) => quote.hourly === null).map((quote) => `${quote.instanceType || "unknown type"}: ${quote.note}`));
    } catch (reason) {
      setNotes([reason instanceof Error ? reason.message : "Could not look up prices"]);
    } finally {
      setLooking(false);
    }
  }

  const idleShare = report.totalHourly > 0 ? Math.round((report.idleHourly / report.totalHourly) * 100) : 0;
  const usedShare = report.usedHourly !== null && report.allocatedHourly > 0 ? Math.round((report.usedHourly / report.allocatedHourly) * 100) : null;
  return (
    <div className="cost-view">
      {namespace ? <p className="warn-note">Showing pods in {namespace} only. Switch to All namespaces for the whole split and the idle share.</p> : null}
      <div className="stat-row cost-stats cost-stats-5">
        <div className="stat-tile ok">
          <span className="stat-label">Nodes per month</span>
          <strong className="stat-value">{money(report.totalHourly)}</strong>
          <span className="stat-note">{nodes.length} nodes{discount ? ` · ${discount}% off list` : ""}</span>
        </div>
        <div className={`stat-tile ${report.unpricedClasses.length ? "warn" : "ok"}`}>
          <span className="stat-label">Storage per month</span>
          <strong className="stat-value">{money(report.storageHourly)}</strong>
          <span className="stat-note">{volumes ? `${volumes.volumes.length} volumes${report.unpricedClasses.length ? ` · ${report.unpricedClasses.length} classes unpriced` : ""}` : "Reading volumes"}</span>
        </div>
        <div className="stat-tile ok">
          <span className="stat-label">Requested by pods</span>
          <strong className="stat-value">{money(report.allocatedHourly)}</strong>
          <span className="stat-note">What workloads reserve</span>
        </div>
        <div className={`stat-tile ${usedShare === null ? "ok" : usedShare < 30 ? "bad" : usedShare < 50 ? "warn" : "ok"}`}>
          <span className="stat-label">Actually used</span>
          <strong className="stat-value">{report.usedHourly === null ? "—" : money(report.usedHourly)}</strong>
          <span className="stat-note">{usedShare === null ? (usage && !usage.available ? "No metrics server" : "Collecting samples…") : `${usedShare}% of what is requested`}</span>
        </div>
        <div className={`stat-tile ${namespace ? "ok" : idleShare >= 50 ? "bad" : idleShare >= 30 ? "warn" : "ok"}`}>
          <span className="stat-label">Idle nodes</span>
          <strong className="stat-value">{namespace ? "—" : money(report.idleHourly)}</strong>
          <span className="stat-note">{namespace ? "Needs all namespaces" : `${idleShare}% that nobody requests`}</span>
        </div>
      </div>

      <section className="cost-card" aria-label="Node prices">
        <header>
          <h3>Node prices <span className="muted">USD per hour, per node, list price</span></h3>
          <label className="cost-discount">
            Your discount
            <PriceInput label="Discount percent" value={discount || undefined} placeholder="0" width={64} onSave={(text) => {
              const value = Math.min(95, parsePrice(text) ?? 0);
              setDiscount(value);
              saveDiscount(value);
            }} />
            %
          </label>
          {canLookUp ? (
            <button type="button" className="ghost icon-btn" disabled={looking} onClick={() => void lookUp()} title="Asks the public Azure Retail Prices API for each VM size and region. Nothing else is sent.">
              <Icon name="download" /> {looking ? "Looking up" : "Look up Azure prices"}
            </button>
          ) : null}
        </header>
        <table className="cost-table">
          <thead><tr><th>Instance type</th><th>Region</th><th>Nodes</th><th>$ / hour</th><th>$ / month, all{discount ? " (after discount)" : ""}</th></tr></thead>
          <tbody>
            {kinds.map(([key, item]) => (
              <tr key={key}>
                <td className="mono">{item.instanceType || "unknown"}{item.spot ? <span className="chip">spot</span> : null}</td>
                <td>{item.region || "—"}</td>
                <td>{item.count}</td>
                <td><PriceInput label={`Price per hour for ${item.instanceType || "unknown"}${item.spot ? " spot" : ""}`} value={prices[key]} placeholder="0.000" onSave={(text) => setPrice(key, text)} /></td>
                <td>{prices[key] !== undefined ? money(prices[key]! * item.count * (1 - discount / 100)) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {notes.map((note) => <p key={note} className="muted cost-note">{note}</p>)}
        <p className="muted cost-note">The discount stands for reservations, savings plans, or an enterprise agreement, and applies to nodes only. Each node's price is split between its cores and memory; each pod pays for its requests.</p>
      </section>

      <section className="cost-card" aria-label="Storage prices">
        <header><h3>Storage <span className="muted">USD per GiB per month, by storage class</span></h3></header>
        {volumeError ? <p className="problem">{volumeError}</p> : null}
        {volumes && report.storage.length === 0 ? <p className="muted">No PersistentVolumeClaims here.</p> : null}
        {report.storage.length > 0 ? (
          <table className="cost-table">
            <thead><tr><th>Storage class</th><th>Disk type</th><th>Claims</th><th>Size</th><th>$ / GiB-month</th><th>$ / month</th></tr></thead>
            <tbody>
              {report.storage.map((item) => (
                <tr key={item.name}>
                  <td className="mono">{item.name || "(none)"}{classInfo.get(item.name)?.isDefault ? <span className="chip">default</span> : null}</td>
                  <td className="muted">{[classInfo.get(item.name)?.sku, classInfo.get(item.name)?.provisioner].filter(Boolean).join(" · ") || "—"}</td>
                  <td>{item.claims}</td>
                  <td>{formatMemory(item.bytes)}</td>
                  <td><PriceInput label={`Price per GiB-month for ${item.name || "no class"}`} value={storagePrices[item.name]} placeholder="0.00" onSave={(text) => setStoragePrice(item.name, text)} /></td>
                  <td>{item.perGibMonth !== null ? money(item.hourly) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="muted cost-note">Priced by requested size. Cloud disks often bill by size tier (Azure: a 100 GiB Premium disk bills as 128 GiB), so use your effective price per GiB. Claims nothing mounts are listed on their own below.</p>
      </section>

      <section className="cost-card" aria-label="Cost by namespace">
        <header><h3>By namespace <span className="muted">used / requested; used is averaged over recent metrics samples</span></h3></header>
        {rows.length === 0 ? <p className="muted">No pods{needle ? " match" : ""}.</p> : null}
        {rows.length > 0 ? (
          <table className="cost-table">
            <thead><tr><th>Namespace</th><th>CPU used / requested</th><th>Memory used / requested</th><th>Storage</th><th>$ / month</th><th>$ used</th><th aria-label="Share" /></tr></thead>
            <tbody>
              {rows.map((item) => {
                const expanded = open.has(item.namespace) || Boolean(needle);
                return (
                  <Fragment key={item.namespace}>
                    <tr className="cost-ns">
                      <td>
                        <button type="button" className="link-btn" aria-expanded={expanded} onClick={() => setOpen((current) => {
                          const next = new Set(current);
                          if (next.has(item.namespace)) next.delete(item.namespace);
                          else next.add(item.namespace);
                          return next;
                        })}>
                          {expanded ? "▾" : "▸"} {item.namespace}
                        </button>
                      </td>
                      <td><UsedOf used={item.usedCpuMillicores} requested={item.cpuMillicores} format={formatCpu} /></td>
                      <td><UsedOf used={item.usedMemoryBytes} requested={item.memoryBytes} format={formatMemory} /></td>
                      <td>{item.storageBytes ? `${formatMemory(item.storageBytes)}${item.storageHourly ? ` · ${money(item.storageHourly)}` : ""}` : "—"}</td>
                      <td className="mono">{money(item.hourly + item.storageHourly)}</td>
                      <td className="mono">{item.usedHourly === null ? "—" : money(item.usedHourly)}</td>
                      <td><span className="cost-bar"><span style={{ width: `${((item.hourly + item.storageHourly) / top) * 100}%` }} /></span></td>
                    </tr>
                    {expanded ? item.workloads.filter((workload) => !needle || item.namespace.toLowerCase().includes(needle) || workload.name.toLowerCase().includes(needle)).map((workload) => (
                      <tr key={`${workload.kind}/${workload.name}`} className="cost-workload">
                        <td>
                          <button type="button" className="related-link" onClick={() => onNavigate({ kind: workload.kind as ResourceRef["kind"], namespace: item.namespace, name: workload.name })}>
                            <span className="related-name">{workload.name}</span>
                            <span className="muted">{workload.kind === "PersistentVolumeClaim" ? "unmounted volume" : `${workload.kind} · ${workload.pods} pod${workload.pods === 1 ? "" : "s"}`}</span>
                          </button>
                        </td>
                        <td>{workload.pods ? <UsedOf used={workload.usedCpuMillicores} requested={workload.cpuMillicores} format={formatCpu} /> : "—"}</td>
                        <td>{workload.pods ? <UsedOf used={workload.usedMemoryBytes} requested={workload.memoryBytes} format={formatMemory} /> : "—"}</td>
                        <td>{workload.storageBytes ? `${formatMemory(workload.storageBytes)}${workload.storageHourly ? ` · ${money(workload.storageHourly)}` : ""}` : "—"}</td>
                        <td className="mono">{money(workload.hourly + workload.storageHourly)}</td>
                        <td className="mono">{workload.usedHourly === null ? "—" : money(workload.usedHourly)}</td>
                        <td />
                      </tr>
                    )) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : null}
        <p className="muted cost-note">"$ used" prices what pods actually used at the same rates; the gap to "$ / month" is reserved but idle. Usage comes from the metrics server, sampled every 15 seconds while Podgaze is open. A month is {HOURS_PER_MONTH} hours.</p>
      </section>
    </div>
  );
}
