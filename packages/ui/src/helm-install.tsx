import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClusterClient, CommandResult, ContextGuard, HelmChart, HelmRepo, HubChart } from "@podgaze/contracts";
import { effectiveGuard } from "./guards";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { YamlEditor } from "./lazy";
import { valuesIssue } from "./yaml-check";

import { manifestDiff, renderedManifest, type ManifestDiff } from "./helm-diff";

function UpgradeDiff({ diff }: { diff: ManifestDiff }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(diff.changed.slice(0, 3).map((item) => item.key)));
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  return (
    <section className="helm-diff" aria-label="What the upgrade changes">
      <header>
        <strong>{total === 0 ? "The upgrade changes nothing in the cluster" : "What the upgrade changes"}</strong>
        <span className="chip warn-chip">{diff.changed.length} changed</span>
        <span className="chip ok-chip">{diff.added.length} added</span>
        <span className="chip bad-chip">{diff.removed.length} removed</span>
        <span className="muted">{diff.unchanged} unchanged</span>
      </header>
      {diff.removed.map((item) => <p key={item.key} className="helm-diff-object removed"><span className="mono">− {item.label}</span><small className="muted">{item.source}</small></p>)}
      {diff.added.map((item) => <p key={item.key} className="helm-diff-object added"><span className="mono">+ {item.label}</span><small className="muted">{item.source}</small></p>)}
      {diff.changed.map((item) => (
        <div key={item.key} className="helm-diff-changed">
          <button type="button" className="link-btn" aria-expanded={open.has(item.key)} onClick={() => setOpen((current) => {
            const next = new Set(current);
            if (next.has(item.key)) next.delete(item.key);
            else next.add(item.key);
            return next;
          })}>
            {open.has(item.key) ? "▾" : "▸"} <span className="mono">~ {item.label}</span> <small className="muted">{item.rows.filter((row) => row.kind === "add").length} added, {item.rows.filter((row) => row.kind === "remove").length} removed lines</small>
          </button>
          {open.has(item.key) ? (
            <div className="diff" aria-label={`Diff of ${item.label}`}>
              {item.rows.map((row, index) => (
                <div key={`${row.kind}-${index}`} className={row.kind}>{row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  "}{row.text}</div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export type UpgradeTarget = { release: string; namespace: string; chart: string; chartVersion: string; values: string };

function looksLikeRef(term: string): boolean {
  return /^oci:\/\//.test(term) || /^https?:\/\//.test(term) || /^[\w.-]+\/[\w.-]+$/.test(term);
}

function shortName(chart: string): string {
  return (chart.split("/").pop() ?? chart).replace(/[^a-z0-9-]/g, "-").slice(0, 53);
}

// Installs a chart or upgrades a release with the local helm CLI: pick a chart, edit values, dry run, install.
export function HelmInstallDialog({
  client,
  namespace,
  guard,
  upgrade,
  onDone,
  onClose,
}: {
  client: ClusterClient;
  namespace: string | null;
  guard: ContextGuard;
  upgrade?: UpgradeTarget;
  onDone: () => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const [source, setSource] = useState<"repos" | "hub">("repos");
  const [hub, setHub] = useState<HubChart[] | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [results, setResults] = useState<HelmChart[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [repos, setRepos] = useState<HelmRepo[] | null>(null);
  const [repoForm, setRepoForm] = useState<HelmRepo | null>(null);
  const [repoBusy, setRepoBusy] = useState(false);
  const [chart, setChart] = useState("");
  const [version, setVersion] = useState(upgrade?.chartVersion ?? "");
  const [release, setRelease] = useState(upgrade?.release ?? "");
  const [targetNamespace, setTargetNamespace] = useState(upgrade?.namespace ?? namespace ?? "default");
  const [createNamespace, setCreateNamespace] = useState(false);
  const [values, setValues] = useState(upgrade?.values ?? "");
  const [loadingValues, setLoadingValues] = useState(false);
  const [busy, setBusy] = useState<"dry" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<CommandResult | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const defaultsSeq = useRef(0);
  const readOnly = effectiveGuard(guard, targetNamespace).readOnly;
  const signature = JSON.stringify([chart, version, release, targetNamespace, createNamespace, values]);
  // On a protected cluster a real install needs a passing dry run of exactly these settings.
  // Upgrades always show what they change first; installs only on protected clusters.
  const [currentManifest, setCurrentManifest] = useState<string | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [skipDiff, setSkipDiff] = useState(false);

  useEffect(() => {
    if (!upgrade) return;
    let gone = false;
    client.getHelmRelease(upgrade.namespace, upgrade.release).then((detail) => {
      if (!gone) setCurrentManifest(detail.manifest);
    }, (reason: unknown) => {
      if (!gone) setManifestError(reason instanceof Error ? reason.message : "Could not read the current release");
    });
    return () => {
      gone = true;
    };
  }, [client, upgrade?.namespace, upgrade?.release]);

  const rendered = useMemo(() => (output?.title === "Dry run" ? renderedManifest(output.output) : null), [output]);
  const diff = useMemo(() => (upgrade && rendered !== null && currentManifest !== null ? manifestDiff(currentManifest, rendered) : null), [upgrade, rendered, currentManifest]);
  // An upgrade unlocks only after a dry run of exactly these settings whose changes could be shown, unless the
  // current release cannot be read and the user chose to go ahead without a diff.
  const diffMissing = Boolean(upgrade) && checked === signature && diff === null && !skipDiff;
  const needsCheck = ((guard.protected || Boolean(upgrade)) && checked !== signature) || diffMissing;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !(event.target as HTMLElement | null)?.closest?.(".cm-editor")) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    client.helmRepos().then(setRepos, (reason: unknown) => {
      setRepos([]);
      setError(reason instanceof Error ? reason.message : "Could not run helm");
    });
  }, [client]);

  // An upgrade needs the chart reference the release came from; the release only remembers the chart's name.
  useEffect(() => {
    if (!upgrade) return;
    client.helmSearch(upgrade.chart).then((found) => {
      const match = found.find((item) => item.name.endsWith(`/${upgrade.chart}`));
      if (match) setChart(match.name);
      setResults(found);
    }, () => setResults([]));
  }, [client, upgrade?.chart]);

  useEffect(() => {
    const query = term.trim();
    if (source === "hub") {
      if (query.length < 2) {
        searchSeq.current += 1;
        setSearching(false);
        setHub(null);
        return;
      }
      const seq = ++searchSeq.current;
      setSearching(true);
      const timer = window.setTimeout(() => {
        client.hubSearch(query).then(
          (found) => {
            if (seq === searchSeq.current) setHub(found);
          },
          (reason: unknown) => {
            if (seq === searchSeq.current) setError(reason instanceof Error ? reason.message : "Artifact Hub search failed");
          },
        ).finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
      }, 350);
      return () => window.clearTimeout(timer);
    }
    if (query.length < 2) {
      searchSeq.current += 1;
      setSearching(false);
      if (!upgrade) setResults(null);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      client.helmSearch(query).then(
        (found) => {
          if (seq === searchSeq.current) setResults(found);
        },
        (reason: unknown) => {
          if (seq === searchSeq.current) setError(reason instanceof Error ? reason.message : "Search failed");
        },
      ).finally(() => {
        if (seq === searchSeq.current) setSearching(false);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [client, term, source]);

  // An Artifact Hub chart lives in some repository; add it under its own name (or reuse it) before installing.
  async function pickHub(item: HubChart) {
    if (item.repo.url.startsWith("oci://")) {
      pick(`${item.repo.url.replace(/\/$/, "")}/${item.name}`, item.version);
      return;
    }
    setPreparing(`${item.repo.name}/${item.name}`);
    setError(null);
    try {
      const known = await client.helmRepos();
      let name = known.find((repo) => repo.url.replace(/\/$/, "") === item.repo.url.replace(/\/$/, ""))?.name;
      if (!name) {
        name = known.some((repo) => repo.name === item.repo.name) ? `${item.repo.name}-hub` : item.repo.name;
        await client.helmAddRepo({ name, url: item.repo.url });
        setRepos(await client.helmRepos());
      }
      pick(`${name}/${item.name}`, item.version);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add the chart's repository");
    } finally {
      setPreparing(null);
    }
  }

  async function loadDefaults(ref: string, chartVersion: string) {
    // Picking chart B while chart A's defaults are still loading must end with B's defaults.
    const seq = ++defaultsSeq.current;
    setLoadingValues(true);
    setError(null);
    try {
      const found = await client.helmChartValues(ref, chartVersion || undefined);
      if (seq === defaultsSeq.current) setValues(found);
    } catch (reason) {
      if (seq === defaultsSeq.current) setError(reason instanceof Error ? reason.message : "Could not read the chart's values");
    } finally {
      if (seq === defaultsSeq.current) setLoadingValues(false);
    }
  }

  function pick(ref: string, chartVersion: string) {
    setChart(ref);
    setVersion(chartVersion);
    setOutput(null);
    if (!upgrade) {
      setRelease((current) => current || shortName(ref));
      void loadDefaults(ref, chartVersion);
    }
  }

  async function addRepo() {
    if (!repoForm) return;
    setRepoBusy(true);
    setError(null);
    try {
      await client.helmAddRepo({ name: repoForm.name.trim(), url: repoForm.url.trim() });
      setRepos(await client.helmRepos());
      setRepoForm(null);
      setTerm(`${repoForm.name.trim()}/`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add the repository");
    } finally {
      setRepoBusy(false);
    }
  }

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "install");
    setError(null);
    setOutput(null);
    try {
      const result = await client.helmInstall({
        release: release.trim(),
        namespace: targetNamespace.trim(),
        chart: chart.trim(),
        version: version.trim() || undefined,
        values,
        createNamespace,
        dryRun,
        upgrade: Boolean(upgrade),
      });
      setOutput(result);
      if (dryRun) setChecked(signature);
      else onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Helm refused");
    } finally {
      setBusy(null);
    }
  }

  const query = term.trim();
  const issue = valuesIssue(values);
  const ready = Boolean(chart.trim() && release.trim() && targetNamespace.trim()) && !issue;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="context-panel helm-install" role="dialog" aria-modal="true" aria-label={upgrade ? `Upgrade ${upgrade.release}` : "Install a Helm chart"} onMouseDown={(event) => event.stopPropagation()}>
        <header className="context-head">
          <div>
            <p className="eyebrow">Helm</p>
            <h2>{upgrade ? `Upgrade ${upgrade.release}` : "Install a chart"}</h2>
            <p className="muted">Runs your local <code>helm</code> against this cluster. The values below are the whole values file used.</p>
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close Helm install" onClick={onClose}><Icon name="x" /></button>
        </header>

        <div className="helm-pick">
          {!upgrade ? (
            <div className="segmented" role="group" aria-label="Where to search">
              <button type="button" aria-pressed={source === "repos"} onClick={() => setSource("repos")}>My repositories</button>
              <button type="button" aria-pressed={source === "hub"} onClick={() => setSource("hub")}>Artifact Hub</button>
            </div>
          ) : null}
          <label className="field">
            {upgrade ? "Chart this release comes from" : source === "hub" ? "Search Artifact Hub" : "Find a chart"}
            <input
              role="searchbox"
              aria-label="Find a chart"
              placeholder="redis, bitnami/postgresql, or oci://registry/chart"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              autoFocus={!upgrade}
            />
          </label>
          {source === "hub" ? (
            <>
              {searching ? <GazeInline label="Searching Artifact Hub…" /> : null}
              {preparing ? <GazeInline label={`Adding the repository for ${preparing}…`} /> : null}
              {hub && hub.length === 0 && !searching ? <p className="muted">Nothing on Artifact Hub matches.</p> : null}
              {hub && hub.length > 0 ? (
                <ul className="helm-results" role="listbox" aria-label="Artifact Hub charts">
                  {hub.map((item) => (
                    <li key={`${item.repo.url}/${item.name}`}>
                      <button type="button" role="option" aria-selected={chart.endsWith(`/${item.name}`)} disabled={preparing !== null} onClick={() => void pickHub(item)}>
                        <strong>
                          {item.name} <span className="muted">· {item.repo.name}</span>
                          {item.repo.official ? <span className="chip ok-chip">official</span> : item.repo.verified ? <span className="chip">verified</span> : null}
                        </strong>
                        <span className="mono">{item.version}{item.appVersion ? ` · app ${item.appVersion}` : ""} · ★ {item.stars}</span>
                        <small>{item.description}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {source === "repos" ? <>
          <div className="helm-repos">
            <span className="muted">Repositories:</span>
            {repos === null ? <GazeInline label="Reading…" /> : null}
            {repos && repos.length === 0 ? <span className="muted">none yet</span> : null}
            {repos?.map((repo) => (
              <button key={repo.name} type="button" className="chip-btn" title={repo.url} onClick={() => setTerm(`${repo.name}/`)}>{repo.name}</button>
            ))}
            <button type="button" className="link-btn" onClick={() => setRepoForm(repoForm ? null : { name: "", url: "" })}>{repoForm ? "Cancel" : "+ Add repository"}</button>
          </div>
          {repoForm ? (
            <form
              className="helm-repo-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addRepo();
              }}
            >
              <input aria-label="Repository name" placeholder="bitnami" value={repoForm.name} onChange={(event) => setRepoForm({ ...repoForm, name: event.target.value })} />
              <input aria-label="Repository URL" placeholder="https://charts.bitnami.com/bitnami" value={repoForm.url} onChange={(event) => setRepoForm({ ...repoForm, url: event.target.value })} />
              <button type="submit" className="connect" disabled={repoBusy || !repoForm.name.trim() || !repoForm.url.trim()}>{repoBusy ? "Adding" : "Add"}</button>
            </form>
          ) : null}
          {searching ? <GazeInline label="Searching repositories…" /> : null}
          {(results && results.length > 0) || looksLikeRef(query) ? (
            <ul className="helm-results" role="listbox" aria-label="Charts">
              {looksLikeRef(query) && !results?.some((item) => item.name === query) ? (
                <li>
                  <button type="button" role="option" aria-selected={chart === query} onClick={() => pick(query, "")}>
                    <strong>Use {query}</strong>
                    <small>As a chart reference, exactly as typed</small>
                  </button>
                </li>
              ) : null}
              {results?.slice(0, 30).map((item) => (
                <li key={item.name}>
                  <button type="button" role="option" aria-selected={chart === item.name} onClick={() => pick(item.name, item.version)}>
                    <strong>{item.name}</strong>
                    <span className="mono">{item.version}{item.appVersion ? ` · app ${item.appVersion}` : ""}</span>
                    <small>{item.description}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : results && query.length >= 2 && !searching ? (
            <p className="muted">No chart matches in your repositories. Try Artifact Hub, add the repository that has it, or type its oci:// reference.</p>
          ) : null}
          </> : null}
        </div>

        <div className="helm-form">
          <label className="field">
            Chart
            <input aria-label="Chart" value={chart} placeholder="repo/chart" onChange={(event) => setChart(event.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            Version
            <input aria-label="Chart version" value={version} placeholder="latest" onChange={(event) => setVersion(event.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            Release name
            <input aria-label="Release name" value={release} disabled={Boolean(upgrade)} onChange={(event) => setRelease(event.target.value.toLowerCase())} spellCheck={false} />
          </label>
          <label className="field">
            Namespace
            <input aria-label="Release namespace" value={targetNamespace} disabled={Boolean(upgrade)} onChange={(event) => setTargetNamespace(event.target.value.trim())} spellCheck={false} />
          </label>
          {!upgrade ? (
            <label className="check">
              <input type="checkbox" checked={createNamespace} onChange={(event) => setCreateNamespace(event.target.checked)} />
              Create the namespace if it does not exist
            </label>
          ) : null}
        </div>

        <div className="helm-values-head">
          <strong>Values</strong>
          <span className="muted">{upgrade ? "Values set on the current release. Anything left out goes back to the chart's default." : "The chart's defaults. Change what you need; the rest can stay."}</span>
          {chart ? (
            <button type="button" className="link-btn" disabled={loadingValues} onClick={() => void loadDefaults(chart, version)}>
              {loadingValues ? "Loading" : "Load chart defaults"}
            </button>
          ) : null}
        </div>
        <div className="create-editor helm-values">
          {loadingValues ? <GazeInline label="Reading the chart's values…" /> : <YamlEditor value={values} onChange={setValues} mode="values" label="Values" />}
        </div>

        {issue ? <p className="problem" role="alert">Values: {issue.message}</p> : null}
        {error ? <p className="problem" role="alert">{error}</p> : null}
        {readOnly ? <p className="warn-note">{targetNamespace} is read-only in Podgaze. You can dry run, but not install.</p> : null}
        {diff ? <UpgradeDiff diff={diff} /> : null}
        {output ? (
          diff ? (
            <details className="helm-raw">
              <summary>Full dry run output</summary>
              <div className="command-output helm-output">
                <div className="cmd-head"><p className="cmd-line">$ {output.command} --dry-run=server</p></div>
                <pre>{output.output}</pre>
              </div>
            </details>
          ) : (
            <div className="command-output helm-output">
              <div className="cmd-head"><p className="cmd-line">$ {output.command}{output.title === "Dry run" ? " --dry-run=server" : ""}</p></div>
              <pre>{output.output}</pre>
            </div>
          )
        ) : null}
        <footer className="context-actions">
          <button type="button" className="ghost icon-btn" disabled={!ready || busy !== null} onClick={() => void run(true)}>
            <Icon name="check" /> {busy === "dry" ? "Rendering" : "Dry run"}
          </button>
          <button
            type="button"
            className="connect icon-btn"
            disabled={!ready || busy !== null || readOnly || needsCheck}
            title={needsCheck ? (upgrade ? "Dry run first to see what the upgrade changes" : "Protected cluster: dry run these exact settings first") : undefined}
            onClick={() => void run(false)}
          >
            <Icon name={upgrade ? "refresh" : "download"} /> {busy === "install" ? (upgrade ? "Upgrading" : "Installing") : upgrade ? "Upgrade" : "Install"}
          </button>
          <span className="muted">{diffMissing ? (manifestError || (rendered === null && output) ? "The changes could not be shown." : "Reading the current release to show what changes…") : needsCheck ? (upgrade ? "Dry run first: it shows every object the upgrade changes." : "Protected cluster: dry run first, then install.") : "Dry run renders the chart and has the API server validate it. Nothing is created."}</span>
          {diffMissing && (manifestError || (rendered === null && output)) ? (
            <label className="check" title={manifestError ?? "The dry run printed no manifest"}>
              <input type="checkbox" checked={skipDiff} onChange={(event) => setSkipDiff(event.target.checked)} /> Upgrade without seeing the changes
            </label>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
