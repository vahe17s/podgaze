export type ClusterGroup = { id: string; name: string };

export type ClusterGrouping = {
  groups: ClusterGroup[];
  membership: Record<string, string>;
  // Contexts kept in the kubeconfig but left off Home.
  hidden?: string[];
};

const empty = (): ClusterGrouping => ({ groups: [], membership: {} });

export function groupingKey(path: string | null): string {
  return `podgaze.cluster-groups:${path ?? "default"}`;
}

export function loadGrouping(path: string | null): ClusterGrouping {
  try {
    const raw = localStorage.getItem(groupingKey(path));
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<ClusterGrouping>;
    if (!Array.isArray(parsed.groups) || !parsed.membership || typeof parsed.membership !== "object") return empty();
    return {
      groups: parsed.groups.filter((group) => group && typeof group.id === "string" && typeof group.name === "string"),
      membership: { ...parsed.membership },
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return empty();
  }
}

export function saveGrouping(path: string | null, grouping: ClusterGrouping) {
  localStorage.setItem(groupingKey(path), JSON.stringify(grouping));
}

export function addGroup(grouping: ClusterGrouping, name: string, id: string = crypto.randomUUID()): { grouping: ClusterGrouping; id: string } {
  return { grouping: { ...grouping, groups: [...grouping.groups, { id, name }] }, id };
}

export function renameGroup(grouping: ClusterGrouping, id: string, name: string): ClusterGrouping {
  return { ...grouping, groups: grouping.groups.map((group) => group.id === id ? { ...group, name } : group) };
}

// Deleting a group sends its clusters back to Ungrouped; it never hides a cluster.
export function deleteGroup(grouping: ClusterGrouping, id: string): ClusterGrouping {
  const membership = Object.fromEntries(Object.entries(grouping.membership).filter(([, groupId]) => groupId !== id));
  return { ...grouping, groups: grouping.groups.filter((group) => group.id !== id), membership };
}

// An empty group id means Ungrouped. A cluster is in at most one group.
export function assignCluster(grouping: ClusterGrouping, clusterId: string, groupId: string): ClusterGrouping {
  const membership = { ...grouping.membership };
  if (groupId) membership[clusterId] = groupId;
  else delete membership[clusterId];
  return { ...grouping, membership };
}

export function groupOf(grouping: ClusterGrouping, clusterId: string): ClusterGroup | null {
  const id = grouping.membership[clusterId];
  return grouping.groups.find((group) => group.id === id) ?? null;
}

export function setHidden(grouping: ClusterGrouping, clusterId: string, hide: boolean): ClusterGrouping {
  const hidden = (grouping.hidden ?? []).filter((id) => id !== clusterId);
  return { ...grouping, hidden: hide ? [...hidden, clusterId] : hidden };
}
