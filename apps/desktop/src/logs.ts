import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Log } from "@kubernetes/client-node";
import type { LogEvent, LogFollowRequest } from "@podgaze/contracts";
import { loadContextConfig } from "@podgaze/cluster";

type Kube = { path: string; context: string };

export function createLogHost(options: {
  kubeconfig: () => Kube | null;
  emit: (event: LogEvent) => void;
}) {
  const stops = new Map<string, AbortController>();

  return {
    async open(request: LogFollowRequest) {
      const kube = options.kubeconfig();
      if (!kube) throw new Error("Not connected.");
      const id = randomUUID();
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          options.emit({ id, type: "data", data: chunk.toString() });
          callback();
        },
      });
      const log = new Log(loadContextConfig(kube.path, kube.context));
      const controller = await log.log(request.namespace, request.pod, request.container, stream, {
        follow: true,
        // The renderer is not trusted to ask for an unbounded backlog: a time window or "all" is capped in bytes.
        ...(request.sinceSeconds
          ? { sinceSeconds: Math.min(7 * 86_400, Math.max(1, Math.round(request.sinceSeconds))), limitBytes: 20 * 1024 * 1024 }
          : request.all
            ? { limitBytes: 20 * 1024 * 1024 }
            : { tailLines: Math.min(5000, Math.max(10, Math.round(request.tailLines ?? 200))) }),
        timestamps: true,
        previous: Boolean(request.previous),
      });
      stops.set(id, controller);
      controller.signal.addEventListener("abort", () => {
        if (stops.delete(id)) options.emit({ id, type: "end" });
      });
      return { id };
    },
    async close(id: string) {
      stops.get(id)?.abort();
    },
    closeAll() {
      for (const controller of [...stops.values()]) controller.abort();
    },
  };
}
