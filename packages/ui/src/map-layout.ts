import type { MapEdge, MapNode } from "@podgaze/contracts";

export const NODE_W = 196;
export const NODE_H = 38;
const COL_GAP = 64;
const ROW_GAP = 12;
const GROUP_GAP = 34;
const GROUP_LABEL = 22;

const columns: Record<string, number> = {
  Ingress: 0,
  "gateways.networking.istio.io": 0,
  "virtualservices.networking.istio.io": 1,
  "destinationrules.networking.istio.io": 1,
  Service: 2,
  HorizontalPodAutoscaler: 2,
  Deployment: 3,
  StatefulSet: 3,
  DaemonSet: 3,
  CronJob: 3,
  ReplicaSet: 4,
  Job: 4,
  Pod: 5,
  ConfigMap: 6,
  Secret: 6,
  PersistentVolumeClaim: 6,
};

// Gateway, then routing, then Service: traffic reads left to right. Unused columns collapse.
function columnFor(kind: string): number {
  return columns[kind] ?? 6;
}

export type Placed = MapNode & { x: number; y: number };
export type GroupBox = { group: number; label: string; x: number; y: number; width: number; height: number };
export type Layout = { nodes: Placed[]; edges: MapEdge[]; groups: GroupBox[]; width: number; height: number };

// Columns left to right follow traffic and ownership: Ingress, Service, workload, ReplicaSet or Job, Pod, config.
// Each app gets its own band; inside a column, nodes sit near the average height of what points at them.
export function layoutMap(nodes: MapNode[], edges: MapEdge[]): Layout {
  const used = [...new Set(nodes.map((node) => columnFor(node.kind)))].sort((left, right) => left - right);
  const columnX = new Map(used.map((column, index) => [column, index * (NODE_W + COL_GAP)]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);

  const groups = new Map<number, MapNode[]>();
  for (const node of nodes) groups.set(node.group, [...(groups.get(node.group) ?? []), node]);
  const ordered = [...groups.entries()].sort((left, right) => right[1].length - left[1].length || headName(left[1]).localeCompare(headName(right[1])));

  const placed: Placed[] = [];
  const boxes: GroupBox[] = [];
  let top = 0;
  let width = 0;
  for (const [group, members] of ordered) {
    const y = new Map<string, number>();
    let tallest = 0;
    for (const column of used) {
      const inColumn = members.filter((node) => columnFor(node.kind) === column);
      const weight = (node: MapNode) => {
        const parents = (incoming.get(node.id) ?? []).map((id) => y.get(id)).filter((value): value is number => value !== undefined);
        return parents.length > 0 ? parents.reduce((sum, value) => sum + value, 0) / parents.length : Number.POSITIVE_INFINITY;
      };
      inColumn.sort((left, right) => weight(left) - weight(right) || left.name.localeCompare(right.name));
      inColumn.forEach((node, index) => {
        const offset = index * (NODE_H + ROW_GAP);
        y.set(node.id, offset);
        placed.push({ ...node, x: columnX.get(column)!, y: top + GROUP_LABEL + offset });
      });
      tallest = Math.max(tallest, inColumn.length * (NODE_H + ROW_GAP) - ROW_GAP);
    }
    const right = Math.max(...members.map((node) => columnX.get(columnFor(node.kind))!)) + NODE_W;
    width = Math.max(width, right);
    boxes.push({ group, label: groupLabel(members), x: -12, y: top, width: right + 24, height: GROUP_LABEL + tallest + 12 });
    top += GROUP_LABEL + tallest + GROUP_GAP;
  }
  return { nodes: placed, edges, groups: boxes, width, height: Math.max(0, top - GROUP_GAP) };
}

function headName(members: MapNode[]): string {
  const order = ["Ingress", "Service", "Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job", "Pod"];
  const head = [...members].sort((left, right) => (order.indexOf(left.kind) + 99) % 99 - (order.indexOf(right.kind) + 99) % 99)[0];
  return head?.name ?? "";
}

function groupLabel(members: MapNode[]): string {
  const workload = members.find((node) => ["Deployment", "StatefulSet", "DaemonSet", "CronJob"].includes(node.kind))
    ?? members.find((node) => node.kind === "Service")
    ?? members[0];
  const namespaces = [...new Set(members.map((node) => node.namespace).filter(Boolean))];
  return `${workload?.name ?? "objects"}${namespaces.length === 1 ? ` · ${namespaces[0]}` : ""}`;
}

export function edgePath(from: Placed, to: Placed): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const bend = Math.max(30, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
