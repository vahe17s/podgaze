import net from "node:net";
import { PortForward } from "@kubernetes/client-node";
import type { PortForwardInfo, PortForwardRequest } from "@podgaze/contracts";
import { createForwardResolver, loadContextConfig } from "@podgaze/cluster";

type Live = { info: PortForwardInfo; server: net.Server; sockets: Set<net.Socket>; streams: Set<{ close: () => void }> };

function validPort(value: number, allowZero: boolean): boolean {
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535;
}

export function createPortForwardHost(options: {
  kubeconfig: () => { path: string; context: string } | null;
}) {
  const sessions = new Map<string, Live>();
  let nextId = 0;

  async function close(id: string) {
    const live = sessions.get(id);
    if (!live) return;
    sessions.delete(id);
    // server.close() only finishes once every connection has ended; a psql session or a browser keep-alive would
    // hold it (and the cluster's credentials) open indefinitely. Cut them.
    for (const socket of live.sockets) socket.destroy();
    for (const stream of live.streams) {
      try {
        stream.close();
      } catch {
        // Already closed.
      }
    }
    await new Promise<void>((resolve) => {
      live.server.close(() => resolve());
      setTimeout(resolve, 2000).unref?.();
    });
  }

  return {
    list(): PortForwardInfo[] {
      return [...sessions.values()].map((item) => item.info);
    },
    async open(request: PortForwardRequest): Promise<PortForwardInfo> {
      const kube = options.kubeconfig();
      if (!kube) throw new Error("Not connected.");
      if (!validPort(request.remotePort, false)) throw new Error("Remote port must be between 1 and 65535.");
      const requestedLocal = request.localPort ?? 0;
      if (!validPort(requestedLocal, true)) throw new Error("Local port must be between 1 and 65535, or left empty.");
      const kc = loadContextConfig(kube.path, kube.context);
      const forward = new PortForward(kc);
      const resolve = createForwardResolver(kc);
      const kind = request.kind ?? "Pod";
      let cached: { pod: string; port: number; at: number } | null = null;
      // Services and workloads pick a ready pod per connection, so a rollout does not leave a dead forward behind.
      async function target() {
        if (cached && Date.now() - cached.at < 10_000) return cached;
        cached = { ...(await resolve(request)), at: Date.now() };
        return cached;
      }
      if (kind !== "Pod") await target();
      const sockets = new Set<net.Socket>();
      const streams = new Set<{ close: () => void }>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void target()
          .then((live) => forward.portForward(request.namespace, live.pod, [live.port], socket, null, socket))
          .then((stream) => {
            const closable = stream as unknown as { close?: () => void } | null;
            if (closable && typeof closable.close === "function") {
              streams.add(closable as { close: () => void });
              socket.once("close", () => streams.delete(closable as { close: () => void }));
            }
          })
          .catch(() => {
            cached = null;
            socket.destroy();
          });
      });
      let localPort = 0;
      try {
        localPort = await new Promise<number>((resolve, reject) => {
          const fail = (error: Error) => reject(error);
          server.once("error", fail);
          server.listen(requestedLocal, "127.0.0.1", () => {
            server.off("error", fail);
            const address = server.address();
            if (address && typeof address === "object") resolve(address.port);
            else reject(new Error("Could not open a local port."));
          });
        });
      } catch (error) {
        server.close();
        throw error instanceof Error ? error : new Error("Could not open a local port.");
      }
      const info: PortForwardInfo = {
        id: String(++nextId),
        namespace: request.namespace,
        kind,
        pod: request.pod,
        remotePort: request.remotePort,
        localPort,
      };
      sessions.set(info.id, { info, server, sockets, streams });
      return info;
    },
    close,
    closeAll() {
      for (const id of [...sessions.keys()]) void close(id);
    },
  };
}
