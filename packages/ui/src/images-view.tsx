import { useEffect, useState } from "react";
import type { ClusterClient, ResourceRef, WorkloadImages } from "@podgaze/contracts";
import { splitImage } from "./compare";
import { GazeInline } from "./loader";

type Use = { clusterId: string; kind: string; namespace: string; name: string; container: string; tag: string };

// Which version of each image runs where, across every open cluster: spot prod still on an old build.
export function ImagesView({ client, clusterIds, activeCluster, filter, onOpen }: {
  client: ClusterClient;
  clusterIds: string[];
  activeCluster: string | null;
  filter: string;
  onOpen: (clusterId: string, ref: ResourceRef) => void;
}) {
  const clusters = clusterIds.length > 0 ? clusterIds : activeCluster ? [activeCluster] : [];
  const [byCluster, setByCluster] = useState<Record<string, WorkloadImages[] | string>>({});
  const [driftOnly, setDriftOnly] = useState(false);

  useEffect(() => {
    let gone = false;
    setByCluster({});
    for (const clusterId of clusters) {
      client.listImagesIn(clusterId).then(
        (found) => {
          if (!gone) setByCluster((current) => ({ ...current, [clusterId]: found }));
        },
        (reason: unknown) => {
          if (!gone) setByCluster((current) => ({ ...current, [clusterId]: reason instanceof Error ? reason.message : "Could not read images" }));
        },
      );
    }
    return () => {
      gone = true;
    };
  }, [client, clusters.join(",")]);

  const loading = clusters.some((id) => byCluster[id] === undefined);
  const repos = new Map<string, Use[]>();
  for (const clusterId of clusters) {
    const found = byCluster[clusterId];
    if (!Array.isArray(found)) continue;
    for (const workload of found) {
      for (const container of workload.containers) {
        const { repo, tag } = splitImage(container.image);
        repos.set(repo, [...(repos.get(repo) ?? []), { clusterId, kind: workload.kind, namespace: workload.namespace, name: workload.name, container: container.name, tag }]);
      }
    }
  }
  const needle = filter.trim().toLowerCase();
  const groups = [...repos.entries()]
    .map(([repo, uses]) => ({ repo, uses, tags: [...new Set(uses.map((use) => use.tag))] }))
    .filter((group) => !driftOnly || group.tags.length > 1)
    .filter((group) => !needle || group.repo.toLowerCase().includes(needle) || group.uses.some((use) => use.name.toLowerCase().includes(needle)))
    .sort((left, right) => right.tags.length - left.tags.length || left.repo.localeCompare(right.repo));
  const drifting = [...repos.values()].filter((uses) => new Set(uses.map((use) => use.tag)).size > 1).length;

  return (
    <div className="activity-view">
      <div className="activity-tools">
        <span className="muted">{repos.size} images in {clusters.length === 1 ? clusters[0] : `${clusters.length} open clusters`} · {drifting} with more than one version</span>
        <label className="check"><input type="checkbox" checked={driftOnly} onChange={(event) => setDriftOnly(event.target.checked)} /> Only images running different versions</label>
      </div>
      {loading ? <GazeInline label="Reading workloads in every open cluster…" /> : null}
      {clusters.map((id) => (typeof byCluster[id] === "string" ? <p key={id} className="problem">{id}: {byCluster[id] as string}</p> : null))}
      {!loading && groups.length === 0 ? <p className="empty-state">No image matches.</p> : null}
      <ul className="image-groups">
        {groups.slice(0, 300).map((group) => (
          <li key={group.repo}>
            <div className="image-head">
              <span className="mono image-repo">{group.repo}</span>
              {group.tags.length > 1 ? <span className="chip warn-chip">{group.tags.length} versions</span> : <span className="chip">{group.tags[0]}</span>}
            </div>
            <ul className="image-uses">
              {group.uses.map((use) => (
                <li key={`${use.clusterId}/${use.namespace}/${use.name}/${use.container}`}>
                  <button type="button" className="related-link" onClick={() => onOpen(use.clusterId, { kind: use.kind, namespace: use.namespace, name: use.name })}>
                    <span className={`image-tag mono tag-${group.tags.indexOf(use.tag) % 6}`}>{use.tag}</span>
                    <span className="related-name">{use.name}</span>
                    <span className="muted">{clusters.length > 1 ? `${use.clusterId} · ` : ""}{use.namespace} · {use.kind}{use.container !== use.name ? ` · ${use.container}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
