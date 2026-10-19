import { useEffect, useState } from "react";
import type { ClusterClient, PodRow } from "@podgaze/contracts";

export function podFault(pod: PodRow): { container: string; state: string; restarts: number } | null {
  const failing = pod.containers.find((item) => !item.ready) ?? null;
  const badStatus = pod.status !== "Running" && pod.status !== "Succeeded";
  if (!failing && !badStatus) return null;
  const container = failing ?? pod.containers[0];
  return {
    container: container?.name || "container",
    state: failing?.state || pod.status,
    restarts: container?.restarts || pod.restarts,
  };
}

function notable(output: string) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return [...lines].reverse().find((line) => /warning|error|unhealthy|backoff|failed|oom/i.test(line)) ?? lines.at(-1) ?? "";
}

function tail(text: string) {
  return text.split("\n").filter((line) => line.trim() && !line.startsWith("# ")).slice(-12).join("\n");
}

export function WhatsWrong({ client, pod }: { client: ClusterClient; pod: PodRow }) {
  const fault = podFault(pod);
  const [event, setEvent] = useState("");
  const [log, setLog] = useState("");

  useEffect(() => {
    if (!fault) return;
    let gone = false;
    setEvent("");
    setLog("");
    void (async () => {
      try {
        const result = await client.runCommand({
          name: "events",
          kind: "Pod",
          resourceName: pod.name,
          namespace: pod.namespace,
        });
        if (!gone) setEvent(notable(result.output));
      } catch {
        if (!gone) setEvent("");
      }
      try {
        const bundle = await client.getLogs({
          namespace: pod.namespace,
          pod: pod.name,
          containers: [fault.container],
          tailLines: 40,
          previous: fault.restarts > 0,
        });
        const text = tail(bundle.text);
        if (!gone) setLog(text || "No log lines.");
      } catch (error) {
        if (!gone) setLog(error instanceof Error ? error.message : "Logs unavailable");
      }
    })();
    return () => {
      gone = true;
    };
  }, [client, pod.uid, pod.status, fault?.container, fault?.restarts]);

  if (!fault) return null;
  return (
    <section className="whats" aria-label="What's wrong">
      <h3>What's wrong</h3>
      <p><strong>{fault.container}</strong> is {fault.state} · {fault.restarts} restarts{pod.lastExit ? ` · last exit ${pod.lastExit}` : ""}</p>
      {event ? <p className="muted">{event}</p> : null}
      {log ? <pre>{log}</pre> : <p className="muted">Reading the last lines…</p>}
    </section>
  );
}
