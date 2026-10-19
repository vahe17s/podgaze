import { describe, expect, it } from "vitest";
import {
  describePod,
  restartPatch,
  rolloutHistoryText,
  rolloutStatusText,
  scalePatch,
  shellCommand,
} from "./commands.js";

describe("kubectl-style commands", () => {
  it("describes a pod with containers and events", () => {
    const text = describePod(
      {
        name: "api-7d9c",
        namespace: "default",
        node: "ip-10-0-4",
        ip: "10.0.1.8",
        qos: "Burstable",
        status: "CrashLoopBackOff",
        start: "2026-01-01T00:00:00.000Z",
        controlledBy: "ReplicaSet/api",
        labels: { app: "api" },
        containers: [
          { name: "api", image: "api:1.8.2", ports: ["8080/TCP"], state: "CrashLoopBackOff", ready: false, restarts: 14 },
        ],
        conditions: [{ type: "Ready", status: "False" }],
      },
      [{ time: "4m", type: "Warning", reason: "BackOff", source: "kubelet", message: "Back-off restarting failed container", count: 12 }],
    );
    expect(text).toMatch(/Name\s+api-7d9c/);
    expect(text).toMatch(/IP\s+10\.0\.1\.8/);
    expect(text).toContain("CrashLoopBackOff");
    expect(text).toContain("app=api");
    expect(text).toContain("Back-off restarting failed container");
  });

  it("writes rollout status the way kubectl does", () => {
    expect(rolloutStatusText({ name: "api", desired: 3, updated: 1, available: 1, observed: 3 })).toContain(
      "1 out of 3 new replicas have been updated",
    );
    expect(rolloutStatusText({ name: "api", desired: 3, updated: 3, available: 3, observed: 3 })).toBe(
      'deployment "api" successfully rolled out',
    );
  });

  it("lists rollout history and builds the shell command", () => {
    expect(rolloutHistoryText([{ revision: 2, cause: "restart" }, { revision: 1, cause: "" }])).toBe(
      "REVISION  CHANGE-CAUSE\n1         <none>\n2         restart",
    );
    expect(
      shellCommand({ name: "rollout-restart", kind: "Pod", resourceName: "api-7d9c", namespace: "shop" }, "api"),
    ).toBe("kubectl rollout restart deployment/api -n shop");
    expect(shellCommand({ name: "delete", kind: "Pod", resourceName: "api-7d9c", namespace: "shop" })).toBe(
      "kubectl delete pod api-7d9c -n shop",
    );
  });

  it("patches the restart annotation and replica count", () => {
    expect(restartPatch(undefined, "2026-09-30T00:00:00.000Z")).toEqual([
      {
        op: "add",
        path: "/spec/template/metadata/annotations",
        value: { "kubectl.kubernetes.io/restartedAt": "2026-09-30T00:00:00.000Z" },
      },
    ]);
    expect(scalePatch(true, 4)).toEqual([{ op: "replace", path: "/spec/replicas", value: 4 }]);
  });
});
