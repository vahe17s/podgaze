import { describe, expect, it } from "vitest";
import type { NodeRow, PodRow } from "@podgaze/contracts";
import { averageUsage, costReport, priceKey, workloadOf } from "./cost";

const node = (name: string, labels: Record<string, string>): NodeRow => ({
  uid: name, name, status: "Ready", roles: [], kubeletVersion: "", ageStart: "", internalIP: "", cpu: "4", memory: "16Gi", podCapacity: "110", os: "", runtime: "", unschedulable: false, labels,
});
const pod = (name: string, namespace: string, nodeName: string, controlledBy: string, cpu: number, memGi: number): PodRow => ({
  uid: name, name, namespace, status: "Running", ready: "1/1", restarts: 0, nodeName, ageStart: "", images: [], ip: "", qos: "", controlledBy, ports: [], containers: [], lastExit: "", labels: {},
  requests: { cpuMillicores: cpu, memoryBytes: memGi * 1024 ** 3 }, limits: { cpuMillicores: 0, memoryBytes: 0 },
});

describe("cost", () => {
  it("charges pods for their requests at their node's rates and leaves the rest idle", () => {
    const labels = { "node.kubernetes.io/instance-type": "Standard_D4s_v5", "topology.kubernetes.io/region": "westeurope" };
    const spot = { ...labels, "kubernetes.azure.com/scalesetpriority": "spot" };
    const report = costReport(
      [pod("api-7c9f8d6b5-x", "shop", "n1", "ReplicaSet/api-7c9f8d6b5", 2000, 8), pod("api-7c9f8d6b5-y", "shop", "n2", "ReplicaSet/api-7c9f8d6b5", 1000, 4), pod("job", "ops", "n1", "Job/backup-29340000", 0, 0)],
      [node("n1", labels), node("n2", spot)],
      { [priceKey("westeurope", "Standard_D4s_v5", false)]: 0.2 },
    );
    expect(report.totalHourly).toBeCloseTo(0.2);
    expect(report.unpriced).toEqual(["westeurope/Standard_D4s_v5/spot"]);
    // Half the cores and half the memory of n1: half its price.
    expect(report.namespaces[0]!.namespace).toBe("shop");
    expect(report.namespaces[0]!.hourly).toBeCloseTo(0.1);
    expect(report.namespaces[0]!.workloads).toMatchObject([{ kind: "Deployment", name: "api", pods: 2 }]);
    expect(report.idleHourly).toBeCloseTo(0.1);
  });

  it("applies a discount, prices storage by class, and prices what pods actually use", () => {
    const labels = { "node.kubernetes.io/instance-type": "Standard_D4s_v5", "topology.kubernetes.io/region": "westeurope" };
    const report = costReport(
      [pod("db-0", "shop", "n1", "StatefulSet/db", 2000, 8)],
      [node("n1", labels)],
      { [priceKey("westeurope", "Standard_D4s_v5", false)]: 0.2 },
      {
        discount: 25,
        usageOf: () => ({ cpuMillicores: 500, memoryBytes: 2 * 1024 ** 3 }),
        volumes: [
          { namespace: "shop", name: "data-db-0", storageClass: "premium", sizeBytes: 100 * 1024 ** 3, phase: "Bound", usedBy: ["db-0"] },
          { namespace: "shop", name: "orphan", storageClass: "premium", sizeBytes: 50 * 1024 ** 3, phase: "Bound", usedBy: [] },
          { namespace: "shop", name: "scratch", storageClass: "unknown", sizeBytes: 10 * 1024 ** 3, phase: "Bound", usedBy: [] },
        ],
        storagePrices: { premium: 0.146 },
      },
    );
    expect(report.totalHourly).toBeCloseTo(0.15);
    // Half the node requested, a quarter of that used.
    expect(report.allocatedHourly).toBeCloseTo(0.075);
    expect(report.usedHourly).toBeCloseTo(0.075 / 4);
    expect(report.storageHourly * 730).toBeCloseTo(150 * 0.146);
    expect(report.unpricedClasses).toEqual(["unknown"]);
    const workloads = report.namespaces[0]!.workloads;
    expect(workloads.map((item) => `${item.kind}/${item.name}`)).toEqual(["StatefulSet/db", "PersistentVolumeClaim/orphan", "PersistentVolumeClaim/scratch"]);
    expect(workloads[0]!.storageHourly * 730).toBeCloseTo(100 * 0.146);
    expect(workloads[0]!.usedCpuMillicores).toBe(500);
    expect(averageUsage([{ cpuMillicores: 100, memoryBytes: 10 }, { cpuMillicores: 300, memoryBytes: 30 }])).toEqual({ cpuMillicores: 200, memoryBytes: 20 });
    expect(averageUsage([])).toBeNull();
  });

  it("names the workload behind a pod", () => {
    expect(workloadOf({ controlledBy: "Job/backup-29340000", name: "x" } as PodRow)).toEqual({ kind: "CronJob", name: "backup" });
    expect(workloadOf({ controlledBy: "", name: "solo" } as PodRow)).toEqual({ kind: "Pod", name: "solo" });
    expect(workloadOf({ controlledBy: "ReplicaSet/api-7d9c", name: "api-7d9c-x", labels: { "pod-template-hash": "7d9c" } } as unknown as PodRow)).toEqual({ kind: "Deployment", name: "api" });
  });
});
