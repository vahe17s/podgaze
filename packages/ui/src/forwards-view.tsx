import { useEffect, useRef, useState } from "react";
import type { ClusterClient, ForwardKind, PortForwardInfo, Session } from "@podgaze/contracts";
import { Icon } from "./icons";

export type SavedForward = { kind: ForwardKind; namespace: string; name: string; remotePort: number; localPort: number };
export type ForwardSet = { id: string; name: string; autoStart: boolean; forwards: SavedForward[] };

const KEY = "podgaze.forwardSets";

function readSets(clusterId: string | null): ForwardSet[] {
  if (!clusterId) return [];
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, ForwardSet[]>;
    return all[clusterId] ?? [];
  } catch {
    return [];
  }
}

function writeSets(clusterId: string, sets: ForwardSet[]) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, ForwardSet[]>;
    localStorage.setItem(KEY, JSON.stringify({ ...all, [clusterId]: sets }));
  } catch {
    // Sets last until the window closes.
  }
}

function same(info: PortForwardInfo, saved: SavedForward): boolean {
  return info.namespace === saved.namespace && info.pod === saved.name && (info.kind ?? "Pod") === saved.kind && info.remotePort === saved.remotePort;
}

export async function startSet(client: ClusterClient, set: ForwardSet): Promise<string[]> {
  const active = await client.listPortForwards();
  const problems: string[] = [];
  for (const forward of set.forwards) {
    if (active.some((info) => same(info, forward))) continue;
    try {
      await client.openPortForward({ namespace: forward.namespace, pod: forward.name, remotePort: forward.remotePort, localPort: forward.localPort, ...(forward.kind === "Pod" ? {} : { kind: forward.kind }) });
    } catch (reason) {
      problems.push(`${forward.kind} ${forward.name}:${forward.remotePort} → ${reason instanceof Error ? reason.message : "failed"}`);
    }
  }
  return problems;
}

// Starts the sets marked "on connect" once per connection to a cluster.
export function useAutoStartForwards(client: ClusterClient, session: Session) {
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (session.state !== "connected" || !session.clusterId || started.current === session.clusterId) return;
    started.current = session.clusterId;
    for (const set of readSets(session.clusterId).filter((item) => item.autoStart)) void startSet(client, set);
  }, [client, session.state, session.clusterId]);
}

// Running port forwards, plus named sets of them ("dev databases") that start with one click.
export function ForwardsView({ client, clusterId }: { client: ClusterClient; clusterId: string | null }) {
  const [active, setActive] = useState<PortForwardInfo[] | null>(null);
  const [sets, setSets] = useState<ForwardSet[]>(() => readSets(clusterId));
  const [naming, setNaming] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setSets(readSets(clusterId));
  }, [clusterId]);

  useEffect(() => {
    let gone = false;
    client.listPortForwards().then((found) => {
      if (!gone) setActive(found);
    }, () => {
      if (!gone) setActive([]);
    });
    const timer = window.setTimeout(() => setTick((value) => value + 1), 5000);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [client, tick]);

  function save(next: ForwardSet[]) {
    if (!clusterId) return;
    setSets(next);
    writeSets(clusterId, next);
  }

  async function stopSet(set: ForwardSet) {
    for (const info of active ?? []) if (set.forwards.some((forward) => same(info, forward))) await client.closePortForward(info.id);
    setTick((value) => value + 1);
  }

  const running = (set: ForwardSet) => set.forwards.filter((forward) => (active ?? []).some((info) => same(info, forward))).length;

  return (
    <div className="activity-view forwards-view">
      <section className="cmd-card" aria-label="Running forwards">
        <header>
          <h4>Running now</h4>
          <p>Start one from any Pod, Deployment, StatefulSet, or Service: right-click it, then Port forward.</p>
        </header>
        {active && active.length === 0 ? <p className="muted">No port forwards are running.</p> : null}
        <ul className="forward-list">
          {(active ?? []).map((info) => (
            <li key={info.id}>
              <a href={`http://127.0.0.1:${info.localPort}/`} target="_blank" rel="noreferrer" className="mono">127.0.0.1:{info.localPort}</a>
              <span>→ {info.kind ?? "Pod"} <strong>{info.pod}</strong>:{info.remotePort}</span>
              <span className="muted">{info.namespace}</span>
              <button type="button" className="icon-btn" onClick={() => void client.closePortForward(info.id).then(() => setTick((value) => value + 1))}><Icon name="stop" /> Stop</button>
            </li>
          ))}
        </ul>
        {active && active.length > 0 && clusterId ? (
          naming === null ? (
            <button type="button" className="ghost icon-btn" onClick={() => setNaming("")}><Icon name="plus" /> Save these as a set</button>
          ) : (
            <form
              className="cmd-inline"
              onSubmit={(event) => {
                event.preventDefault();
                if (!naming.trim()) return;
                save([...sets, {
                  id: `s${Date.now().toString(36)}`,
                  name: naming.trim(),
                  autoStart: false,
                  forwards: active.map((info) => ({ kind: info.kind ?? "Pod", namespace: info.namespace, name: info.pod, remotePort: info.remotePort, localPort: info.localPort })),
                }]);
                setNaming(null);
              }}
            >
              <label className="grow"><span>Set name</span><input aria-label="Set name" value={naming} placeholder="dev databases" onChange={(event) => setNaming(event.target.value)} autoFocus /></label>
              <button type="submit" className="connect">Save set</button>
              <button type="button" className="ghost" onClick={() => setNaming(null)}>Cancel</button>
            </form>
          )
        ) : null}
      </section>
      <section className="cmd-card" aria-label="Saved sets">
        <header>
          <h4>Saved sets{clusterId ? ` for ${clusterId}` : ""}</h4>
          <p>Each forward keeps its local port, so bookmarks and connection strings keep working.</p>
        </header>
        {sets.length === 0 ? <p className="muted">No saved sets yet.</p> : null}
        <ul className="forward-sets">
          {sets.map((set) => (
            <li key={set.id}>
              <div className="forward-set-head">
                <strong>{set.name}</strong>
                <span className="muted">{running(set)}/{set.forwards.length} running</span>
                <label className="check" title="Start this set whenever you connect to this cluster">
                  <input type="checkbox" checked={set.autoStart} onChange={(event) => save(sets.map((item) => (item.id === set.id ? { ...item, autoStart: event.target.checked } : item)))} />
                  Start on connect
                </label>
                <span className="head-spacer" />
                {running(set) < set.forwards.length ? (
                  <button type="button" className="connect icon-btn" onClick={() => void startSet(client, set).then((problems) => {
                    setMessages(problems);
                    setTick((value) => value + 1);
                  })}><Icon name="arrow" /> Start</button>
                ) : (
                  <button type="button" className="icon-btn" onClick={() => void stopSet(set)}><Icon name="stop" /> Stop</button>
                )}
                <button type="button" className="dock-icon ghost" aria-label={`Delete set ${set.name}`} onClick={() => save(sets.filter((item) => item.id !== set.id))}><Icon name="x" /></button>
              </div>
              <ul className="forward-set-items">
                {set.forwards.map((forward) => (
                  <li key={`${forward.kind}/${forward.namespace}/${forward.name}/${forward.remotePort}`} className="mono">
                    127.0.0.1:{forward.localPort} → {forward.kind.toLowerCase()}/{forward.name}:{forward.remotePort} <span className="muted">({forward.namespace})</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {messages.map((message) => <p key={message} className="problem">{message}</p>)}
      </section>
    </div>
  );
}
