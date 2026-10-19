import type { PodRow } from "@podgaze/contracts";
import type { UsageSample } from "./usage";

export type SizingHint = {
  workload: string;
  // What to open: the Deployment behind a ReplicaSet, or the owner itself.
  kind: string;
  namespace: string;
  pods: number;
  hint: "over-cpu" | "over-memory" | "near-memory-limit" | "no-requests";
  message: string;
  // Rough savings, to sort the list: millicores or MiB that are requested but not used.
  waste: number;
};

const MIN_SAMPLES = 4;
const MIB = 1024 * 1024;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function roundCpu(millicores: number): number {
  return Math.max(10, Math.ceil(millicores / 10) * 10);
}

function roundMemory(bytes: number): number {
  return Math.max(16, Math.ceil(bytes / MIB / 16) * 16);
}

// Compares what pods ask for with what they used over the samples Podgaze has seen. It needs a few minutes of
// metrics before it says anything, and it suggests generous numbers on purpose.
export function sizingHints(pods: PodRow[], historyOf: (pod: PodRow) => UsageSample[]): SizingHint[] {
  const groups = new Map<string, { pods: PodRow[]; cpu: number[]; memory: number[] }>();
  for (const pod of pods) {
    const samples = historyOf(pod);
    if (samples.length < MIN_SAMPLES) continue;
    const key = `${pod.namespace}/${pod.controlledBy || pod.name}`;
    const group = groups.get(key) ?? { pods: [], cpu: [], memory: [] };
    group.pods.push(pod);
    group.cpu.push(...samples.map((sample) => sample.cpuMillicores));
    group.memory.push(...samples.map((sample) => sample.memoryBytes));
    groups.set(key, group);
  }
  const hints: SizingHint[] = [];
  for (const [key, group] of groups) {
    const pod = group.pods[0]!;
    const [ownerKind, ...rest] = (pod.controlledBy || `Pod/${pod.name}`).split("/");
    const ownerName = rest.join("/");
    // A ReplicaSet's name is its Deployment's plus a template hash.
    const kind = ownerKind === "ReplicaSet" ? "Deployment" : ownerKind!;
    const workload = ownerKind === "ReplicaSet" ? ownerName.replace(/-[a-z0-9]{8,10}$/, "") : ownerName;
    const namespace = key.split("/")[0]!;
    const cpu95 = percentile(group.cpu, 0.95);
    const memMax = Math.max(...group.memory);
    const base = { workload, kind, namespace, pods: group.pods.length };
    if (pod.requests.cpuMillicores === 0 && pod.requests.memoryBytes === 0) {
      hints.push({ ...base, hint: "no-requests", waste: 0, message: `No requests set. It used up to ${Math.round(cpu95)}m CPU and ${Math.round(memMax / MIB)}Mi memory; requests of ${roundCpu(cpu95 * 1.3)}m and ${roundMemory(memMax * 1.3)}Mi would let the scheduler place it properly.` });
      continue;
    }
    if (pod.limits.memoryBytes > 0 && memMax > pod.limits.memoryBytes * 0.9) {
      hints.push({ ...base, hint: "near-memory-limit", waste: 0, message: `Peaks at ${Math.round(memMax / MIB)}Mi of its ${Math.round(pod.limits.memoryBytes / MIB)}Mi memory limit: one spike from an OOM kill. Consider ${roundMemory(memMax * 1.5)}Mi.` });
    }
    if (pod.requests.cpuMillicores >= 100 && cpu95 * 3 < pod.requests.cpuMillicores) {
      hints.push({ ...base, hint: "over-cpu", waste: (pod.requests.cpuMillicores - cpu95) * group.pods.length, message: `Requests ${pod.requests.cpuMillicores}m CPU, uses about ${Math.round(cpu95)}m (95th percentile). ${roundCpu(cpu95 * 1.5)}m would still leave room.` });
    }
    if (pod.requests.memoryBytes >= 128 * MIB && memMax * 2.5 < pod.requests.memoryBytes) {
      hints.push({ ...base, hint: "over-memory", waste: ((pod.requests.memoryBytes - memMax) / MIB) * group.pods.length, message: `Requests ${Math.round(pod.requests.memoryBytes / MIB)}Mi memory, peaks at ${Math.round(memMax / MIB)}Mi. ${roundMemory(memMax * 1.5)}Mi would still leave room.` });
    }
  }
  const order = { "near-memory-limit": 0, "no-requests": 1, "over-cpu": 2, "over-memory": 3 };
  return hints.sort((left, right) => order[left.hint] - order[right.hint] || right.waste - left.waste);
}
