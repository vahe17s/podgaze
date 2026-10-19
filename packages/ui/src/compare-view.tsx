import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ClusterClient, ResourceRow } from "@podgaze/contracts";
import { appBase, compareFacts, workloadFacts, type CompareRow } from "./compare";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { getSettings } from "./settings";

type Candidate = { clusterId: string; row: ResourceRow };
type Column = Candidate & { yaml: string | null; error: string | null };

const MAX = 4;
const LIST_KEY = "podgaze.compare.list";

function readListHeight(): number {
  try {
    const saved = Number(localStorage.getItem(LIST_KEY));
    return saved >= 80 && saved <= 2000 ? saved : 220;
  } catch {
    return 220;
  }
}

function keyOf(candidate: Candidate): string {
  return `${candidate.clusterId}/${candidate.row.kind}/${candidate.row.namespace}/${candidate.row.name}`;
}

// The same app in several environments, side by side: what differs between dev, staging, and production.
export function CompareView({ client, clusterIds, activeCluster, initial }: {
  client: ClusterClient;
  clusterIds: string[];
  activeCluster: string | null;
  initial?: string;
}) {
  const [query, setQuery] = useState(initial ?? "");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [picking, setPicking] = useState(true);
  const [listHeight, setListHeight] = useState(readListHeight);
  const listRef = useRef<HTMLDivElement>(null);
  const clusters = clusterIds.length > 0 ? clusterIds : activeCluster ? [activeCluster] : [];

  useEffect(() => {
    const base = appBase(query.trim());
    if (base.length < 2) {
      setCandidates(null);
      setSearching(false);
      return;
    }
    let gone = false;
    setSearching(true);
    setPicking(true);
    const timer = window.setTimeout(() => {
      void Promise.all(clusters.map((clusterId) => client.findWorkloads(clusterId, base).then(
        (rows) => ({ clusterId, rows, error: null as string | null }),
        (reason: unknown) => ({ clusterId, rows: [] as ResourceRow[], error: reason instanceof Error ? reason.message : "search failed" }),
      ))).then((results) => {
        if (gone) return;
        const found = results.flatMap((result) => result.rows.map((row) => ({ clusterId: result.clusterId, row })));
        setCandidates(found);
        setProblems(results.filter((result) => result.error).map((result) => `${result.clusterId}: ${result.error}`));
        // Only the environments of exactly this app are picked for you; a broad search picks nothing.
        const same = found.filter((item) => appBase(item.row.name) === base).slice(0, MAX).map(keyOf);
        setChosen(same.length >= 2 ? same : []);
        if (same.length >= 2) setPicking(false);
      }).finally(() => {
        if (!gone) setSearching(false);
      });
    }, 300);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [client, query, clusters.join(",")]);

  useEffect(() => {
    const picked = (candidates ?? []).filter((item) => chosen.includes(keyOf(item)));
    let gone = false;
    setColumns(picked.map((item) => ({ ...item, yaml: null, error: null })));
    for (const item of picked) {
      client.getYamlIn(item.clusterId, { kind: item.row.kind, namespace: item.row.namespace || null, name: item.row.name }).then(
        (yaml) => {
          if (!gone) setColumns((current) => current.map((column) => (keyOf(column) === keyOf(item) ? { ...column, yaml } : column)));
        },
        (reason: unknown) => {
          if (!gone) setColumns((current) => current.map((column) => (keyOf(column) === keyOf(item) ? { ...column, error: reason instanceof Error ? reason.message : "Could not read it" } : column)));
        },
      );
    }
    return () => {
      gone = true;
    };
  }, [client, chosen.join("|"), candidates]);

  // Apps that show up under several names once environment suffixes are removed: one click compares them all.
  const quickPicks = (() => {
    const groups = new Map<string, string[]>();
    for (const item of candidates ?? []) {
      const base = appBase(item.row.name);
      groups.set(base, [...(groups.get(base) ?? []), keyOf(item)]);
    }
    return [...groups.entries()]
      .filter(([, keys]) => keys.length >= 2)
      .map(([base, keys]) => ({ base, keys: keys.slice(0, MAX) }))
      .sort((left, right) => right.keys.length - left.keys.length || left.base.localeCompare(right.base))
      .slice(0, 10);
  })();

  function onResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const start = listRef.current?.offsetHeight ?? listHeight;
    const scale = getSettings().zoom || 1;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    let latest = start;
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(window.innerHeight * 0.75, Math.max(80, start + (ev.clientY - startY) / scale)));
      setListHeight(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      try {
        localStorage.setItem(LIST_KEY, String(latest));
      } catch {
        // Height resets next time.
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  const location = (item: Candidate) => [clusters.length > 1 ? item.clusterId : "", item.row.namespace, item.row.kind].filter(Boolean).join(" · ");
  const ready = columns.length >= 2 && columns.every((column) => column.yaml !== null || column.error !== null);
  const rows: CompareRow[] = useMemo(
    () => (ready ? compareFacts(columns.map((column) => (column.yaml ? workloadFacts(column.yaml) : []))) : []),
    [ready, columns],
  );
  const shown = onlyDiff ? rows.filter((row) => row.differs) : rows;
  const differences = rows.filter((row) => row.differs).length;
  const multiCluster = new Set(columns.map((column) => column.clusterId)).size > 1;

  return (
    <div className="compare-view">
      <div className="compare-pick">
        <input
          role="searchbox"
          aria-label="App to compare"
          placeholder="App name, e.g. checkout-api"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <span className="muted">
          Searches Deployments, StatefulSets, and DaemonSets in {clusters.length === 1 ? clusters[0] : `${clusters.length} open clusters`}. Open more clusters as tabs to compare across them.
        </span>
      </div>
      {searching ? <GazeInline label="Looking in every open cluster…" /> : null}
      {problems.map((problem) => <p key={problem} className="problem">{problem}</p>)}
      {candidates && candidates.length === 0 && !searching ? <p className="empty-state">Nothing named like that.</p> : null}
      {candidates && candidates.length > 0 && !picking && columns.length > 0 ? (
        <div className="compare-summary" role="group" aria-label="Compared workloads">
          <span className="muted">Comparing</span>
          {columns.map((column) => (
            <span key={keyOf(column)} className="compare-tag">
              <span className="mono">{column.row.name}</span>
              <small>{location(column)}</small>
              <button type="button" aria-label={`Remove ${column.row.name}`} onClick={() => setChosen((current) => current.filter((value) => value !== keyOf(column)))}><Icon name="x" /></button>
            </span>
          ))}
          <button type="button" className="ghost compare-change" onClick={() => setPicking(true)}>Change…</button>
        </div>
      ) : null}
      {candidates && candidates.length > 0 && picking ? (
        <div className="compare-picker">
          {quickPicks.length > 0 ? (
            <div className="compare-quick" role="group" aria-label="Apps in several environments">
              <span className="muted">In several environments</span>
              {quickPicks.map((pick) => (
                <button key={pick.base} type="button" className="chip-btn" onClick={() => {
                  setChosen(pick.keys);
                  setPicking(false);
                }}>
                  {pick.base} <span className="muted">×{pick.keys.length}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="compare-list-head">
            <span className="muted">{chosen.length === 0 ? "Pick two to four" : `${chosen.length} of ${MAX} picked`} · {candidates.length > 60 ? `first 60 of ${candidates.length}, type more to narrow` : `${candidates.length} found`}</span>
            {columns.length >= 2 ? <button type="button" className="ghost compare-change" onClick={() => setPicking(false)}>Done</button> : null}
          </div>
          <div ref={listRef} className="compare-candidates" role="group" aria-label="Workloads to compare" style={{ maxHeight: listHeight }}>
            {candidates.slice(0, 60).map((item) => {
              const key = keyOf(item);
              const on = chosen.includes(key);
              return (
                <label key={key} className={on ? "compare-chip on" : "compare-chip"} title={`${item.clusterId} · ${item.row.namespace} · ${item.row.kind}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && chosen.length >= MAX}
                    onChange={() => setChosen((current) => (on ? current.filter((value) => value !== key) : [...current, key]))}
                  />
                  <span className="mono">{item.row.name}</span>
                  <small>{location(item)}</small>
                </label>
              );
            })}
          </div>
          <div className="compare-list-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the list" title="Drag to resize" onPointerDown={onResize} />
        </div>
      ) : null}
      {columns.length === 1 ? <p className="muted">Pick at least one more to compare with.</p> : null}
      {columns.length >= 2 && !ready ? <GazeInline label="Reading manifests…" /> : null}
      {ready ? (
        <>
          <div className="compare-tools">
            <strong>{differences === 0 ? "No differences" : `${differences} difference${differences === 1 ? "" : "s"}`}</strong>
            <label className="check"><input type="checkbox" checked={onlyDiff} onChange={(event) => setOnlyDiff(event.target.checked)} /> Only differences</label>
            <span className="muted">Values from Secrets and ConfigMaps are shown as references, not read.</span>
          </div>
          <div className="compare-scroll">
            <table className="compare-table" style={{ ["--cols" as string]: columns.length }}>
              <thead>
                <tr>
                  <th>Setting</th>
                  {columns.map((column) => (
                    <th key={keyOf(column)}>
                      <span className="mono">{column.row.name}</span>
                      <small>{column.clusterId} · {column.row.namespace}</small>
                      {column.error ? <small className="problem">{column.error}</small> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, index) => (
                  <Fragment key={`${row.section}-${row.field}`}>
                    {index === 0 || shown[index - 1]!.section !== row.section ? (
                      <tr key={`s-${row.section}`} className="compare-section"><td colSpan={columns.length + 1}>{row.section}</td></tr>
                    ) : null}
                    <tr className={row.differs ? "differs" : undefined}>
                      <td className="mono">{row.field}</td>
                      {row.values.map((value, column) => (
                        <td key={column} className={value ? "mono" : "mono missing"}>{value || "—"}</td>
                      ))}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 ? <p className="empty-state">These are configured the same way.</p> : null}
        </>
      ) : null}
    </div>
  );
}
