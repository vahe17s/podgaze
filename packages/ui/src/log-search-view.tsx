import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClusterClient, LogMatch, LogSearchResult, ResourceRef } from "@podgaze/contracts";
import { saveText } from "./download";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { SearchSelect } from "./search-select";
import { MAX_LOG_QUERIES } from "./share";

const ranges = [
  { seconds: 900, label: "15 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 6 * 3600, label: "6 hours" },
  { seconds: 24 * 3600, label: "24 hours" },
  { seconds: 7 * 24 * 3600, label: "7 days" },
];

type Saved = { pattern: string; regex: boolean; caseSensitive: boolean };
const SAVED_KEY = "podgaze.log-queries";

function loadSaved(): Saved[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is Saved => Boolean(item) && typeof (item as Saved).pattern === "string").slice(0, MAX_LOG_QUERIES) : [];
  } catch {
    return [];
  }
}

function storeSaved(saved: Saved[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    // Saved queries last for this run.
  }
}

function Highlighted({ match }: { match: LogMatch }) {
  const parts: ReactNode[] = [];
  let at = 0;
  match.ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(<span key={`t${index}`}>{match.line.slice(at, start)}</span>);
    parts.push(<mark key={`m${index}`}>{match.line.slice(Math.max(start, at), end)}</mark>);
    at = Math.max(at, end);
  });
  if (at < match.line.length) parts.push(<span key="rest">{match.line.slice(at)}</span>);
  return <>{parts}</>;
}

export type LogSearchStart = { namespace: string; workload?: ResourceRef };

// grep across every replica of a workload, or a whole namespace, at once.
export function LogSearchView({ client, clusterId, namespaces, currentNamespace, start }: {
  client: ClusterClient;
  clusterId: string | null;
  namespaces: string[];
  currentNamespace: string | null;
  start?: LogSearchStart | null;
}) {
  const [namespace, setNamespace] = useState(start?.namespace ?? currentNamespace ?? "");
  const [workload, setWorkload] = useState(start?.workload ? `${start.workload.kind}/${start.workload.name}` : "");
  const [workloads, setWorkloads] = useState<ResourceRef[]>([]);
  const [pattern, setPattern] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [since, setSince] = useState(3600);
  const [result, setResult] = useState<LogSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [podFilter, setPodFilter] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>(loadSaved);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (start) {
      setNamespace(start.namespace);
      setWorkload(start.workload ? `${start.workload.kind}/${start.workload.name}` : "");
    }
  }, [start]);

  useEffect(() => {
    if (!clusterId || !namespace) {
      setWorkloads([]);
      return;
    }
    let gone = false;
    client.findWorkloads(clusterId, "").then(
      (rows) => {
        if (!gone) setWorkloads(rows.filter((row) => row.namespace === namespace).map((row) => ({ kind: row.kind, namespace: row.namespace, name: row.name })));
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [client, clusterId, namespace]);

  async function search(query: Saved = { pattern, regex, caseSensitive }) {
    if (!namespace || !query.pattern) return;
    // Only the newest search may show its results; an older, slower one finishing later is dropped.
    const seq = ++searchSeq.current;
    setBusy(true);
    setError(null);
    setPodFilter(null);
    try {
      const [kind, ...name] = workload.split("/");
      const found = await client.searchLogs({
        namespace,
        workload: workload ? { kind: kind as ResourceRef["kind"], namespace, name: name.join("/") } : undefined,
        pattern: query.pattern,
        regex: query.regex,
        caseSensitive: query.caseSensitive,
        sinceSeconds: since,
      });
      if (seq === searchSeq.current) setResult(found);
    } catch (reason) {
      if (seq !== searchSeq.current) return;
      setResult(null);
      setError(reason instanceof Error ? reason.message : "Search failed");
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  }

  const pods = useMemo(() => {
    const counts = new Map<string, number>();
    for (const match of result?.matches ?? []) counts.set(match.pod, (counts.get(match.pod) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [result]);
  const shown = (result?.matches ?? []).filter((match) => !podFilter || match.pod === podFilter);
  const isSaved = saved.some((item) => item.pattern === pattern && item.regex === regex && item.caseSensitive === caseSensitive);

  return (
    <div className="log-search">
      <form
        className="log-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <SearchSelect
          label="Namespace to search"
          value={namespace}
          placeholder="Namespace"
          options={[...(namespace ? [] : [{ value: "", label: "Pick a namespace" }]), ...namespaces.map((item) => ({ value: item, label: item }))]}
          onPick={(value) => {
            setNamespace(value);
            setWorkload("");
          }}
        />
        <SearchSelect
          label="Workload to search"
          value={workload}
          placeholder="Every pod in the namespace"
          options={[
            { value: "", label: "Every pod in the namespace" },
            ...(workload && !workloads.some((item) => `${item.kind}/${item.name}` === workload) ? [{ value: workload, label: workload.split("/").slice(1).join("/"), detail: workload.split("/")[0] }] : []),
            ...workloads.map((item) => ({ value: `${item.kind}/${item.name}`, label: item.name, detail: item.kind })),
          ]}
          onPick={setWorkload}
        />
        <input role="searchbox" aria-label="Text to find in logs" className="log-search-input" placeholder={regex ? "Regular expression, e.g. timeout|5\\d\\d" : "Text to find, e.g. timeout"} value={pattern} onChange={(event) => setPattern(event.target.value)} spellCheck={false} />
        <select aria-label="How far back" value={since} onChange={(event) => setSince(Number(event.target.value))}>
          {ranges.map((item) => <option key={item.seconds} value={item.seconds}>Last {item.label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} /> Regex</label>
        <label className="check"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Match case</label>
        <button type="submit" className="connect icon-btn" disabled={!namespace || !pattern || busy}><Icon name="search" /> {busy ? "Searching" : "Search"}</button>
        <button
          type="button"
          className="ghost icon-btn"
          disabled={!pattern || isSaved}
          title="Keep this query for later"
          onClick={() => {
            const next = [{ pattern, regex, caseSensitive }, ...saved].slice(0, MAX_LOG_QUERIES);
            setSaved(next);
            storeSaved(next);
          }}
        >
          <Icon name="star" /> {isSaved ? "Saved" : "Save query"}
        </button>
      </form>
      {saved.length > 0 ? (
        <div className="log-saved" role="group" aria-label="Saved queries">
          <span className="muted">Saved</span>
          {saved.map((item) => (
            <span key={`${item.pattern}-${item.regex}-${item.caseSensitive}`} className="compare-tag">
              <button
                type="button"
                className="log-saved-run mono"
                title="Search with this query"
                onClick={() => {
                  setPattern(item.pattern);
                  setRegex(item.regex);
                  setCaseSensitive(item.caseSensitive);
                  void search(item);
                }}
              >
                {item.regex ? `/${item.pattern}/` : item.pattern}
              </button>
              <button type="button" aria-label={`Forget ${item.pattern}`} onClick={() => {
                const next = saved.filter((other) => other !== item);
                setSaved(next);
                storeSaved(next);
              }}><Icon name="x" /></button>
            </span>
          ))}
        </div>
      ) : null}
      {!namespace ? <p className="muted">Pick a namespace, and optionally one workload, then search its pods' logs.</p> : null}
      {busy ? <GazeInline label="Reading logs from every pod…" /> : null}
      {error ? <p className="problem">{error}</p> : null}
      {result && !busy ? (
        <>
          <div className="log-search-summary">
            <strong>{result.matches.length.toLocaleString()} match{result.matches.length === 1 ? "" : "es"}{result.truncated ? " (newest kept)" : ""}</strong>
            <span className="muted">in {result.lines.toLocaleString()} lines from {result.pods} pod{result.pods === 1 ? "" : "s"}, {result.containers} container{result.containers === 1 ? "" : "s"}</span>
            {result.matches.length > 0 ? (
              <button type="button" className="ghost icon-btn" onClick={() => saveText(`log-search-${namespace}.log`, shown.map((match) => `${match.time} [${match.pod}/${match.container}] ${match.line}`).join("\n"))}>
                <Icon name="download" /> Download
              </button>
            ) : null}
          </div>
          {pods.length > 1 ? (
            <div className="log-pods" role="group" aria-label="Matches per pod">
              <button type="button" className="chip-btn" aria-pressed={podFilter === null} onClick={() => setPodFilter(null)}>All pods</button>
              {pods.map(([pod, count]) => (
                <button key={pod} type="button" className="chip-btn" aria-pressed={podFilter === pod} onClick={() => setPodFilter(podFilter === pod ? null : pod)}>
                  <span className="mono">{pod}</span> <span className="muted">{count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {result.problems.map((problem) => <p key={problem} className="warn-note">{problem}</p>)}
          {shown.length === 0 ? <p className="empty-state">No line matches.</p> : (
            <ol className="log-hits" aria-label="Matching lines">
              {shown.map((match, index) => (
                <li key={`${match.pod}-${match.container}-${match.time}-${index}`}>
                  <time className="mono" title={match.time}>{match.time ? new Date(match.time).toLocaleTimeString() : ""}</time>
                  <span className="log-source mono" title={`${match.pod} / ${match.container}`}>{match.pod}{match.container !== match.pod ? `/${match.container}` : ""}</span>
                  <span className="log-line mono"><Highlighted match={match} /></span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  );
}
