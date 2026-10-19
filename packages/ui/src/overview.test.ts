import { describe, expect, it } from "vitest";
import type { DeploymentRow, NodeRow, PodRow } from "@podgaze/contracts";
import { attention, podIssue } from "./overview";

function pod(name: string, status: string, restarts = 0, lastExit = ""): PodRow {
  return {
    uid: name, name, namespace: "default", status, ready: status === "Running" ? "1/1" : "0/1", restarts, nodeName: "n1",
    ageStart: "", images: [], ip: "", qos: "", controlledBy: "", ports: [], containers: [], lastExit,
    labels: {}, requests: { cpuMillicores: 0, memoryBytes: 0 }, limits: { cpuMillicores: 0, memoryBytes: 0 },
  };
}

describe("overview attention list", () => {
  it("keeps a Running pod that was killed before, and skips healthy ones", () => {
    expect(podIssue(pod("ok", "Running"))).toBeNull();
    expect(podIssue(pod("oom", "Running", 3, "OOMKilled (137)"))?.detail).toBe("3 restarts · last exit OOMKilled (137)");
  });

  it("puts down nodes first, then crashing pods, then degraded deployments, then pods that recovered", () => {
    const nodes: NodeRow[] = [{ uid: "n1", name: "n1", status: "NotReady", roles: [], kubeletVersion: "", ageStart: "", internalIP: "", cpu: "", memory: "", podCapacity: "", os: "", runtime: "", unschedulable: false, labels: {} }];
    const deployments: DeploymentRow[] = [{ uid: "d", name: "api", namespace: "default", status: "Progressing", ready: "1/2", updated: "", available: "", ageStart: "", images: [], labels: {}, paused: false }];
    const order = attention([pod("oom", "Running", 3, "OOMKilled (137)"), pod("crash", "CrashLoopBackOff", 9, "Error (1)")], deployments, nodes)
      .map((issue) => issue.ref.name);
    expect(order).toEqual(["n1", "crash", "api", "oom"]);
  });
});
