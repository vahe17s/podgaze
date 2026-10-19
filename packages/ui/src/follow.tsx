import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClusterClient, ExecTarget, LogEvent, PodRow, ResourceRef } from "@podgaze/contracts";
import { saveText } from "./download";
import { getSettings } from "./settings";
import { Icon } from "./icons";
import { GazeInline } from "./loader";

// Lines containing the query, with each hit marked. Case-insensitive, plain text (no regex surprises).
export function matchLines(text: string, query: string): { lines: ReactNode[]; count: number } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { lines: [], count: 0 };
  const lines: ReactNode[] = [];
  let count = 0;
  text.split("\n").forEach((line, row) => {
    const lower = line.toLowerCase();
    if (!lower.includes(needle)) return;
    const parts: ReactNode[] = [];
    let from = 0;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      if (at > from) parts.push(line.slice(from, at));
      parts.push(<mark key={`${row}-${at}`}>{line.slice(at, at + needle.length)}</mark>);
      count += 1;
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    if (from < line.length) parts.push(line.slice(from));
    lines.push(<div key={row}>{parts}</div>);
  });
  return { lines, count };
}

export type LogRange = "tail" | "300" | "900" | "3600" | "21600" | "86400" | "all";

const rangeLabels: Record<LogRange, string> = {
  tail: "Last lines",
  "300": "Last 5 min",
  "900": "Last 15 min",
  "3600": "Last hour",
  "21600": "Last 6 hours",
  "86400": "Last 24 hours",
  all: "Since start",
};

function rangeRequest(range: LogRange): { tailLines?: number; sinceSeconds?: number; all?: boolean } {
  if (range === "tail") return { tailLines: getSettings().logTail };
  if (range === "all") return { all: true };
  return { sinceSeconds: Number(range) };
}

function RangePicker({ value, onChange }: { value: LogRange; onChange: (value: LogRange) => void }) {
  return (
    <select aria-label="Log time range" className="log-range" value={value} title="How far back to start" onChange={(event) => onChange(event.target.value as LogRange)}>
      {(Object.keys(rangeLabels) as LogRange[]).map((key) => (
        <option key={key} value={key}>{key === "tail" ? `Last ${getSettings().logTail} lines` : rangeLabels[key]}</option>
      ))}
    </select>
  );
}

export function FollowLogs({ client, pod, initialPrevious = false }: { client: ClusterClient; pod: PodRow; initialPrevious?: boolean }) {
  const names = pod.containers.map((item) => item.name).filter(Boolean);
  const [container, setContainer] = useState(names[0] ?? "");
  const [previous, setPrevious] = useState(initialPrevious);
  const [range, setRange] = useState<LogRange>("tail");
  const [saving, setSaving] = useState(false);
  const [live, setLive] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(() => getSettings().logWrap);
  const box = useRef<HTMLPreElement>(null);
  const found = useMemo(() => matchLines(text, query), [text, query]);

  useEffect(() => {
    setContainer(names[0] ?? "");
    setPrevious(initialPrevious);
    setLive(true);
    setText("");
    setError(null);
  }, [pod.uid]);

  useEffect(() => {
    if (!live || !container) return;
    let stopped = false;
    let current: string | null = null;
    const queued: LogEvent[] = [];
    const apply = (event: LogEvent) => {
      if (event.type === "data") setText((value) => (value + event.data).slice(-80_000));
      if (event.type === "error") setError(event.message);
      if (event.type === "end" || event.type === "error") setLive(false);
    };
    const stopListen = client.onLogs((event) => {
      if (current === null) {
        queued.push(event);
        return;
      }
      if (event.id === current) apply(event);
    });
    setText("");
    setError(null);
    void client.followLogs({
      namespace: pod.namespace,
      pod: pod.name,
      container,
      previous,
      ...rangeRequest(range),
    }).then(({ id }) => {
      if (stopped) {
        void client.stopFollow(id);
        return;
      }
      current = id;
      for (const event of queued) {
        if (event.id === id) apply(event);
      }
    }).catch((reason: unknown) => {
      if (!stopped) setError(reason instanceof Error ? reason.message : "Could not follow logs");
    });
    return () => {
      stopped = true;
      stopListen();
      if (current) void client.stopFollow(current);
    };
  }, [client, live, container, previous, range, pod.namespace, pod.name]);

  // Downloads the whole log (not just what is on screen) for the chosen container.
  async function download() {
    setSaving(true);
    setError(null);
    try {
      const bundle = await client.getLogs({ namespace: pod.namespace, pod: pod.name, containers: [container], previous });
      saveText(bundle.filename, bundle.text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not download logs");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text, query]);

  return (
    <div className="follow">
      <div className="exec-bar">
        {names.length > 1 ? (
          <label className="field">
            Container
            <select aria-label="Log container" value={container} onChange={(event) => setContainer(event.target.value)}>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        ) : <span className="muted">{container || "container"}</span>}
        <label className="check">
          <input type="checkbox" checked={previous} onChange={(event) => setPrevious(event.target.checked)} />
          Previous
        </label>
        <RangePicker value={range} onChange={setRange} />
        <label className="filter log-filter">
          <span className="sr">Search logs</span>
          <input role="searchbox" aria-label="Search logs" placeholder="Search logs" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {query.trim() ? <span className="muted">{found.count} match{found.count === 1 ? "" : "es"}</span> : null}
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
          Wrap
        </label>
        <button type="button" className="icon-btn" onClick={() => setLive((value) => !value)}>
          <Icon name={live ? "stop" : "log"} /> {live ? "Stop" : "Follow"}
        </button>
        <button type="button" className="icon-btn" disabled={saving || !container} onClick={() => void download()}>
          <Icon name="download" /> {saving ? "Saving" : "Download"}
        </button>
        {error ? <span className="problem">{error}</span> : null}
      </div>
      <pre ref={box} className={wrap ? "follow-log wrap" : "follow-log"} aria-label="Followed logs">
        {query.trim()
          ? (found.lines.length ? found.lines : "No lines match.")
          : text || (live ? "Waiting for logs…" : "Follow is stopped.")}
      </pre>
    </div>
  );
}

const MAX_PODS = 10;
const KEEP = 160_000;

// Follows the same container in every pod of a workload, one merged stream with each line tagged by its pod.
export function WorkloadLogs({ client, target }: { client: ClusterClient; target: ResourceRef }) {
  const [targets, setTargets] = useState<ExecTarget[] | null>(null);
  const [container, setContainer] = useState("");
  const [live, setLive] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(() => getSettings().logWrap);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [range, setRange] = useState<LogRange>("tail");
  const box = useRef<HTMLPreElement>(null);
  const found = useMemo(() => matchLines(text, query), [text, query]);

  useEffect(() => {
    let gone = false;
    setTargets(null);
    setError(null);
    client.listExecTargets(target).then(
      (list) => {
        if (gone) return;
        setTargets(list);
        setContainer((current) => current || list[0]?.containers[0] || "");
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not list the pods");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, target.kind, target.name, target.namespace, reload]);

  const followed = (targets ?? []).filter((item) => item.containers.includes(container)).slice(0, MAX_PODS);
  const followKey = followed.map((item) => `${item.namespace}/${item.pod}`).join(",");

  useEffect(() => {
    if (!live || !container || followed.length === 0) return;
    let stopped = false;
    const owners = new Map<string, string>();
    const partial = new Map<string, string>();
    const queued: LogEvent[] = [];
    const ids: string[] = [];
    // Chunks can split a line, so only whole lines are tagged and shown; the rest waits for the next chunk.
    const apply = (event: LogEvent) => {
      const pod = owners.get(event.id);
      if (!pod) return;
      if (event.type === "data") {
        const lines = ((partial.get(event.id) ?? "") + event.data).split("\n");
        partial.set(event.id, lines.pop() ?? "");
        if (lines.length > 0) setText((value) => (value + lines.map((line) => `[${pod}] ${line}\n`).join("")).slice(-KEEP));
      }
      if (event.type === "error") setError(`${pod}: ${event.message}`);
    };
    const stopListen = client.onLogs((event) => {
      if (owners.has(event.id)) apply(event);
      else queued.push(event);
    });
    setText("");
    setError(null);
    for (const item of followed) {
      void client.followLogs({ namespace: item.namespace, pod: item.pod, container, ...rangeRequest(range) }).then(({ id }) => {
        if (stopped) {
          void client.stopFollow(id);
          return;
        }
        ids.push(id);
        owners.set(id, item.pod);
        for (const event of queued) {
          if (event.id === id) apply(event);
        }
      }).catch((reason: unknown) => {
        if (!stopped) setError(`${item.pod}: ${reason instanceof Error ? reason.message : "could not follow"}`);
      });
    }
    return () => {
      stopped = true;
      stopListen();
      for (const id of ids) void client.stopFollow(id);
    };
  }, [client, live, container, followKey, range]);

  useEffect(() => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text, query]);

  async function download() {
    setSaving(true);
    setError(null);
    try {
      const parts: string[] = [];
      for (const item of followed) {
        const bundle = await client.getLogs({ namespace: item.namespace, pod: item.pod, containers: [container] });
        parts.push(bundle.text);
      }
      saveText(`${target.name}-${container}.log`, parts.join("\n"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not download logs");
    } finally {
      setSaving(false);
    }
  }

  const names = [...new Set((targets ?? []).flatMap((item) => item.containers))];
  const total = (targets ?? []).length;

  return (
    <div className="follow">
      <div className="exec-bar">
        {names.length > 1 ? (
          <label className="field">
            Container
            <select aria-label="Log container" value={container} onChange={(event) => setContainer(event.target.value)}>
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        ) : <span className="muted">{container || "container"}</span>}
        <span className="muted" title={total > MAX_PODS ? `Following the first ${MAX_PODS} of ${total} pods` : undefined}>
          {targets ? `${followed.length}${total > followed.length ? ` of ${total}` : ""} pod${followed.length === 1 ? "" : "s"}` : <GazeInline label="Finding pods…" />}
        </span>
        <RangePicker value={range} onChange={setRange} />
        <label className="filter log-filter">
          <span className="sr">Search logs</span>
          <input role="searchbox" aria-label="Search logs" placeholder="Search logs" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {query.trim() ? <span className="muted">{found.count} match{found.count === 1 ? "" : "es"}</span> : null}
        <label className="check">
          <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
          Wrap
        </label>
        <button type="button" className="icon-btn" onClick={() => setLive((value) => !value)}>
          <Icon name={live ? "stop" : "log"} /> {live ? "Stop" : "Follow"}
        </button>
        <button type="button" className="icon-btn" title="Look for pods again, e.g. after a rollout" onClick={() => setReload((value) => value + 1)}>
          <Icon name="refresh" /> Pods
        </button>
        <button type="button" className="icon-btn" disabled={saving || followed.length === 0} onClick={() => void download()}>
          <Icon name="download" /> {saving ? "Saving" : "Download"}
        </button>
        {error ? <span className="problem">{error}</span> : null}
      </div>
      <pre ref={box} className={wrap ? "follow-log wrap" : "follow-log"} aria-label="Followed logs">
        {query.trim()
          ? (found.lines.length ? found.lines : "No lines match.")
          : text || (targets && followed.length === 0 ? "No running pods to follow." : live ? "Waiting for logs…" : "Follow is stopped.")}
      </pre>
    </div>
  );
}
