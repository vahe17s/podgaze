import { describe, expect, it } from "vitest";
import { nodeToRow, podToRow } from "./project.js";

describe("podToRow", () => {
  it("uses a waiting reason instead of the pod phase", () => {
    const row = podToRow({
      metadata: { uid: "u1", name: "worker", namespace: "default", creationTimestamp: "2026-01-01T00:00:00.000Z" },
      spec: { nodeName: "ip-10", containers: [{ image: "worker:1" }, { image: "sidecar:2" }] },
      status: {
        phase: "Running",
        containerStatuses: [
          { ready: false, restartCount: 14, state: { waiting: { reason: "CrashLoopBackOff" } } },
          { ready: true, restartCount: 1 },
        ],
      },
    });

    expect(row).toMatchObject({
      uid: "u1",
      name: "worker",
      namespace: "default",
      status: "CrashLoopBackOff",
      ready: "1/2",
      restarts: 15,
      nodeName: "ip-10",
      images: ["worker:1", "sidecar:2"],
    });
  });

  it("uses the phase when no container is waiting", () => {
    const row = podToRow({
      metadata: { uid: "u2", name: "api", namespace: "shop" },
      spec: { containers: [{ image: "api:1" }] },
      status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
    });
    expect(row?.status).toBe("Running");
    expect(row?.ready).toBe("1/1");
  });
});

describe("nodeToRow", () => {
  it("reads the Ready condition, roles, and kubelet version", () => {
    const row = nodeToRow({
      metadata: {
        uid: "n1",
        name: "node-a",
        creationTimestamp: new Date("2026-02-01T00:00:00.000Z"),
        labels: {
          "node-role.kubernetes.io/control-plane": "",
          "kubernetes.io/role": "control-plane",
        },
      },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        nodeInfo: { kubeletVersion: "v1.32.1" },
      },
    });
    expect(row).toMatchObject({
      status: "Ready",
      roles: ["control-plane"],
      kubeletVersion: "v1.32.1",
      ageStart: "2026-02-01T00:00:00.000Z",
    });
  });

  it("marks a node NotReady when the Ready condition is not True", () => {
    expect(
      nodeToRow({
        metadata: { uid: "n2", name: "node-b" },
        status: { conditions: [{ type: "Ready", status: "False" }] },
      })?.status,
    ).toBe("NotReady");
  });
});
