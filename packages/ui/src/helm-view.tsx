import { useEffect, useState } from "react";
import type { ClusterClient, CommandResult, ContextGuard, HelmRelease, HelmReleaseDetail } from "@podgaze/contracts";
import { formatAge, statusTone } from "./format";
import { effectiveGuard } from "./guards";
import { Icon } from "./icons";
import { GazeInline, GazeLoader } from "./loader";
import { HelmInstallDialog, type UpgradeTarget } from "./helm-install";
import { countMatches, Highlighted, matchesSearch, PanelSearchBox } from "./panel-search";
import { ResizablePanel } from "./resizable-panel";
import { ResourceTable, type TableColumn } from "./table";

type Row = HelmRelease & { uid: string };

const columns = (showNamespace: boolean): TableColumn<Row>[] => [
  { key: "name", header: "Name", width: "1.2fr", cell: (row) => row.name },
  ...(showNamespace ? [{ key: "namespace", header: "Namespace", width: "0.8fr", cell: (row: Row) => row.namespace }] : []),
  { key: "status", header: "Status", width: "0.7fr", cell: (row) => row.status, status: true },
  { key: "chart", header: "Chart", width: "1fr", cell: (row) => `${row.chart}-${row.chartVersion}` },
  { key: "app", header: "App version", width: "0.6fr", cell: (row) => row.appVersion },
  { key: "revision", header: "Revision", width: "0.5fr", cell: (row) => String(row.revision) },
  { key: "updated", header: "Updated", width: "0.5fr", cell: (row) => row.updated, age: true },
];

type Armed = { action: "rollback"; revision: number } | { action: "uninstall" };

// Helm releases read straight from their release Secrets, so this works without the helm binary. Rollback and
// uninstall do need helm on PATH; without it the exact command is shown to run by hand.
export function HelmView({ client, namespace, guard, filter, refreshKey }: { client: ClusterClient; namespace: string | null; guard: ContextGuard; filter: string; refreshKey: string }) {
  const [releases, setReleases] = useState<HelmRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ namespace: string; name: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [installing, setInstalling] = useState<{ upgrade?: UpgradeTarget } | null>(null);

  useEffect(() => {
    let gone = false;
    setError(null);
    client.listHelmReleases().then(
      (found) => {
        if (!gone) setReleases(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read Helm releases");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, refreshKey, reload]);

  const needle = filter.trim().toLowerCase();
  const rows: Row[] = (releases ?? [])
    .filter((release) => !needle || `${release.name} ${release.chart}`.toLowerCase().includes(needle))
    .map((release) => ({ ...release, uid: `${release.namespace}/${release.name}` }));
  const current = selected ? rows.find((row) => row.namespace === selected.namespace && row.name === selected.name) : undefined;

  if (error) return <p className="empty-state" role="alert">{error}</p>;
  if (!releases) return <GazeLoader label="Reading Helm releases" detail="From the release Secrets in each namespace" />;
  return (
    <div className="helm-view">
      <div className="helm-toolbar">
        <button type="button" className="connect icon-btn" onClick={() => setInstalling({})}><Icon name="download" /> Install chart</button>
        <span className="muted">{rows.length} release{rows.length === 1 ? "" : "s"}{namespace ? ` in ${namespace}` : ""}</span>
      </div>
      {installing ? (
        <HelmInstallDialog
          client={client}
          namespace={namespace}
          guard={guard}
          upgrade={installing.upgrade}
          onClose={() => setInstalling(null)}
          onDone={() => setReload((value) => value + 1)}
        />
      ) : null}
      {rows.length === 0 ? (
        <div className="empty-state" role="status">
          <p>{needle ? "No release matches." : `No Helm releases${namespace ? ` in ${namespace}` : " in this cluster"}.`}</p>
          {!needle ? (
            <p className="muted">
              Only charts installed with <code>helm install</code> leave a release here. Apps that Argo CD or Flux render from a Helm chart do not;
              look for them under Custom resources (Application, HelmRelease).
            </p>
          ) : null}
          {namespace ? <button type="button" className="ghost" onClick={() => void client.setNamespace(null)}>Show all namespaces</button> : null}
        </div>
      ) : (
        <ResourceTable
          rows={rows}
          tableId="HelmRelease"
          columns={columns(namespace === null)}
          selectedUid={current?.uid ?? null}
          onSelect={(row) => setSelected({ namespace: row.namespace, name: row.name })}
        />
      )}
      {current ? (
        <ReleasePanel
          key={current.uid}
          client={client}
          release={current}
          guard={effectiveGuard(guard, current.namespace)}
          onClose={() => setSelected(null)}
          onChanged={() => setReload((value) => value + 1)}
          onUpgrade={(target) => setInstalling({ upgrade: target })}
        />
      ) : null}
    </div>
  );
}

function ReleasePanel({ client, release, guard, onClose, onChanged, onUpgrade }: { client: ClusterClient; release: HelmRelease; guard: ContextGuard; onClose: () => void; onChanged: () => void; onUpgrade: (target: UpgradeTarget) => void }) {
  const [detail, setDetail] = useState<HelmReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"history" | "values" | "manifest" | "notes">("history");
  const [armed, setArmed] = useState<Armed | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<CommandResult | null>(null);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    let gone = false;
    client.getHelmRelease(release.namespace, release.name).then(
      (found) => {
        if (!gone) setDetail(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read this release");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, release.namespace, release.name, release.revision, reload]);

  async function run(next: Armed) {
    setBusy(true);
    setError(null);
    setOutput(null);
    try {
      const result = await client.helmAction({
        name: release.name,
        namespace: release.namespace,
        action: next.action,
        ...(next.action === "rollback" ? { revision: next.revision } : {}),
      });
      setOutput(result);
      setArmed(null);
      setTyped("");
      onChanged();
      setReload((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Helm refused");
    } finally {
      setBusy(false);
    }
  }

  const confirmText = armed?.action === "rollback" ? `Roll back to revision ${armed.revision}` : "Uninstall release";
  return (
    <ResizablePanel storageKey="helm" label={`Release ${release.name}`} className="helm-panel">
      <header className="helm-head">
        <div>
          <p className="eyebrow">Helm release · {release.namespace}</p>
          <h2>{release.name} <span className={`status ${statusTone(release.status)}`}>{release.status}</span></h2>
          <p className="muted">{release.chart}-{release.chartVersion} · app {release.appVersion || "—"} · revision {release.revision} · {formatAge(release.updated) || "—"} ago</p>
        </div>
        <div className="helm-head-actions">
          <button
            type="button"
            className="icon-btn"
            disabled={!detail || guard.readOnly}
            title="Change values or move to another chart version"
            onClick={() => detail && onUpgrade({ release: release.name, namespace: release.namespace, chart: release.chart, chartVersion: release.chartVersion, values: detail.values })}
          >
            <Icon name="sliders" /> Upgrade / edit values
          </button>
          <button type="button" className="dock-icon ghost" aria-label="Close release" onClick={onClose}><Icon name="x" /></button>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {(["history", "values", "manifest", "notes"] as const).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
            {name[0]!.toUpperCase() + name.slice(1)}
            {needle && detail && name !== "history" ? <em className="tab-count">{countMatches(name === "values" ? detail.values : name === "manifest" ? detail.manifest : detail.notes, needle)}</em> : null}
          </button>
        ))}
        <PanelSearchBox value={query} onChange={setQuery} placeholder="Find in history, values, manifest" label="Find in release" />
      </div>
      {!detail && !error ? <GazeInline label="Decoding the release…" /> : null}
      {error ? <p className="problem" role="alert">{error}</p> : null}
      {guard.readOnly ? <p className="muted">Read-only: rollback and uninstall are off for this namespace.</p> : null}
      {armed ? (
        <form
          className="confirm-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (!guard.protected || typed === release.name) void run(armed);
          }}
        >
          <span>{confirmText}?</span>
          {guard.protected ? (
            <label className="field">
              Type <strong>{release.name}</strong> to confirm
              <input aria-label="Confirm release name" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
            </label>
          ) : null}
          <button type="submit" className="danger" disabled={busy || (guard.protected && typed !== release.name)}>{busy ? "Running" : `${confirmText} now`}</button>
          <button type="button" onClick={() => setArmed(null)}>Cancel</button>
        </form>
      ) : null}
      {output ? (
        <div className="command-output">
          <div className="cmd-head"><p className="cmd-line">$ {output.command}</p></div>
          <pre>{output.output}</pre>
        </div>
      ) : null}
      {detail && tab === "history" ? (
        <>
          <ul className="helm-history">
            {detail.history.filter((item) => matchesSearch(needle, String(item.revision), item.status, item.chartVersion, item.appVersion, item.description)).map((item) => (
              <li key={item.revision}>
                <span className="helm-rev">#{item.revision}</span>
                <span className={`status ${statusTone(item.status)}`}>{item.status}</span>
                <span className="mono">{item.chartVersion}</span>
                <span className="muted">{formatAge(item.updated) || "—"} ago</span>
                <span className="helm-desc" title={item.description}>{item.description}</span>
                {item.revision !== detail.revision ? (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={guard.readOnly || busy}
                    onClick={() => {
                      setArmed({ action: "rollback", revision: item.revision });
                      setTyped("");
                    }}
                  >
                    <Icon name="refresh" /> Roll back here
                  </button>
                ) : <span className="chip">current</span>}
              </li>
            ))}
          </ul>
          <div className="cmd-card danger-card helm-danger">
            <header><h4>Danger zone</h4><p>Removes everything the chart installed and the release history.</p></header>
            <div className="command-grid">
              <button type="button" className="danger icon-btn" disabled={guard.readOnly || busy} onClick={() => setArmed({ action: "uninstall" })}>
                <Icon name="x" /> Uninstall
              </button>
            </div>
          </div>
        </>
      ) : null}
      {detail && tab === "values" ? (
        detail.values ? <pre className="yaml helm-pre" aria-label="Values"><Highlighted text={detail.values} needle={needle} /></pre> : <p className="muted">Installed with the chart's default values.</p>
      ) : null}
      {detail && tab === "manifest" ? <pre className="yaml helm-pre" aria-label="Manifest"><Highlighted text={detail.manifest || "No manifest stored."} needle={needle} /></pre> : null}
      {detail && tab === "notes" ? <pre className="yaml helm-pre" aria-label="Notes"><Highlighted text={detail.notes || "This chart has no notes."} needle={needle} /></pre> : null}
    </ResizablePanel>
  );
}
