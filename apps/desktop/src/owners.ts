// Which cluster each followed log, port forward, and pod terminal belongs to, so closing a cluster's tab stops
// exactly its own and leaves the other open clusters' running.
export type Kind = "logs" | "forwards" | "terminals";

export function createOwners() {
  const maps: Record<Kind, Map<string, string>> = { logs: new Map(), forwards: new Map(), terminals: new Map() };
  return {
    remember(kind: Kind, id: string, clusterId: string | null | undefined) {
      if (clusterId) maps[kind].set(id, clusterId);
    },
    forget(kind: Kind, id: string) {
      maps[kind].delete(id);
    },
    // Hands back, and forgets, everything that belongs to the cluster.
    takeAll(clusterId: string): Record<Kind, string[]> {
      const taken = { logs: [] as string[], forwards: [] as string[], terminals: [] as string[] };
      for (const kind of Object.keys(maps) as Kind[]) {
        for (const [id, owner] of maps[kind]) {
          if (owner !== clusterId) continue;
          taken[kind].push(id);
          maps[kind].delete(id);
        }
      }
      return taken;
    },
    clearKind(kind: Kind) {
      maps[kind].clear();
    },
    clear() {
      for (const map of Object.values(maps)) map.clear();
    },
  };
}
