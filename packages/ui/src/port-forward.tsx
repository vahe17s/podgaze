import { useEffect, useRef, useState } from "react";
import type { ClusterClient, ForwardKind, PortForwardInfo, ResourceKind } from "@podgaze/contracts";
import { Icon } from "./icons";

function portNumbers(ports: string[]): number[] {
  return [...new Set(ports.map((port) => Number(port.split("/")[0])).filter((port) => Number.isInteger(port) && port > 0))];
}

const forwardKinds: ResourceKind[] = ["Pod", "Deployment", "StatefulSet", "Service"];

export function canForward(kind: ResourceKind): boolean {
  return forwardKinds.includes(kind);
}

export function PortForward({
  client,
  kind = "Pod",
  namespace,
  name,
  ports,
  focusToken = 0,
}: {
  // Bumped by the right-click "Port forward…" so the port field is ready to type into.
  focusToken?: number;
  client: ClusterClient;
  kind?: ForwardKind;
  namespace: string;
  name: string;
  ports: string[];
}) {
  const known = portNumbers(ports);
  const [remote, setRemote] = useState(known[0] ? String(known[0]) : "");
  const [local, setLocal] = useState("");
  const [sessions, setSessions] = useState<PortForwardInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remoteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusToken === 0) return;
    remoteRef.current?.focus();
    remoteRef.current?.select();
    remoteRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusToken]);

  useEffect(() => {
    let cancelled = false;
    void client.listPortForwards().then((all) => {
      if (!cancelled) setSessions(all.filter((item) => item.namespace === namespace && item.pod === name && (item.kind ?? "Pod") === kind));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, kind, namespace, name]);

  async function start() {
    const remotePort = Number(remote);
    const localPort = local.trim() === "" ? undefined : Number(local);
    setBusy(true);
    setError(null);
    try {
      const info = await client.openPortForward({
        namespace,
        pod: name,
        remotePort,
        localPort,
        ...(kind === "Pod" ? {} : { kind }),
      });
      setSessions((current) => [...current.filter((item) => item.id !== info.id), info]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not forward the port");
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    setError(null);
    try {
      await client.closePortForward(id);
      setSessions((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not stop the forward");
    }
  }

  return (
    <section className="forward" aria-label="Port forward">
      <form
        className="forward-line"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <span className="forward-title" title={kind === "Pod" ? undefined : "Picks a ready pod for each connection, so restarts do not break it"}><Icon name="link" /> Port forward</span>
        <label className="forward-field">
          {kind === "Service" ? "Service" : kind === "Pod" ? "Pod" : "Port"}
          <input ref={remoteRef} aria-label={kind === "Service" ? "Service port" : "Pod port"} inputMode="numeric" value={remote} onChange={(event) => setRemote(event.target.value)} />
        </label>
        <span className="forward-to">to</span>
        <label className="forward-field">
          localhost
          <input aria-label="Local port" inputMode="numeric" placeholder="auto" value={local} onChange={(event) => setLocal(event.target.value)} />
        </label>
        <button type="submit" className="icon-btn" disabled={busy || remote.trim() === ""}>
          <Icon name="arrow" />
          Forward
        </button>
      </form>
      {known.length > 1 ? (
        <div className="forward-ports">
          {known.map((port) => (
            <button key={port} type="button" aria-pressed={remote === String(port)} onClick={() => setRemote(String(port))}>{port}</button>
          ))}
        </div>
      ) : null}
      {error ? <p className="problem">{error}</p> : null}
      {sessions.map((session) => {
        const address = `127.0.0.1:${session.localPort}`;
        return (
          <div key={session.id} className="forward-live">
            <a href={`http://${address}/`} target="_blank" rel="noreferrer">{address}</a>
            <span>{(session.kind ?? "Pod") === "Pod" ? "pod" : (session.kind ?? "").toLowerCase()} :{session.remotePort}</span>
            <button type="button" className="icon-btn" onClick={() => void stop(session.id)}>
              <Icon name="stop" />
              Stop
            </button>
          </div>
        );
      })}
    </section>
  );
}
