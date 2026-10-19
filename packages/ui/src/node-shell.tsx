import { useEffect, useRef, useState } from "react";
import type { ClusterClient, ContextGuard, NodeShell } from "@podgaze/contracts";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { TerminalPane } from "./lazy";

// A root shell on the node through a short-lived privileged pod. The pod is removed when the shell closes,
// and stops on its own after four hours if Podgaze cannot remove it.
export function NodeShellPanel({ client, node, guard }: { client: ClusterClient; node: string; guard: ContextGuard }) {
  const [shell, setShell] = useState<NodeShell | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<NodeShell | null>(null);

  useEffect(() => () => {
    const open = live.current;
    if (open) void client.stopNodeShell(open.namespace, open.pod).catch(() => undefined);
  }, [client, node]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const opened = await client.startNodeShell(node);
      live.current = opened;
      setShell(opened);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open a node shell");
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    const open = live.current;
    live.current = null;
    setShell(null);
    if (open) await client.stopNodeShell(open.namespace, open.pod).catch(() => undefined);
  }

  if (guard.readOnly) return <p className="muted node-shell-note">Read-only context: node shell is off, because root on a node can change anything.</p>;
  if (shell) {
    return (
      <div className="node-shell">
        <div className="exec-bar">
          <span className="muted">Root shell on <strong>{node}</strong> through pod <code>{shell.namespace}/{shell.pod}</code>.</span>
          <button type="button" className="icon-btn danger" onClick={() => void stop()}><Icon name="stop" /> Close and remove pod</button>
        </div>
        <TerminalPane client={client} request={{ mode: "exec", namespace: shell.namespace, pod: shell.pod, container: shell.container, command: shell.command }} />
      </div>
    );
  }
  return (
    <div className="node-shell-start">
      <p>
        Opens a root shell on <strong>{node}</strong>. Podgaze starts a privileged <code>busybox</code> pod on the node in
        <code>kube-system</code> and enters the host with <code>nsenter</code>, like <code>kubectl debug node</code>.
      </p>
      <p className="muted">The pod is deleted when you close the shell, and stops by itself after 4 hours otherwise. Needs permission to create privileged pods in kube-system.</p>
      {error ? <p className="problem" role="alert">{error}</p> : null}
      <button type="button" className="connect icon-btn" disabled={starting} onClick={() => void start()}>
        <Icon name="terminal" /> {starting ? "Starting" : "Open node shell"}
      </button>
      {starting ? <GazeInline label="Starting the shell pod on the node…" /> : null}
    </div>
  );
}
