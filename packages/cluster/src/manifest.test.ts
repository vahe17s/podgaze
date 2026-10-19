import { describe, expect, it } from "vitest";
import { matchLabelsSelector, readManifest, selectorMatches, selectorString } from "./manifest.js";

describe("live manifests", () => {
  it("reads a namespaced manifest", () => {
    const manifest = readManifest("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: shop\n");
    expect(manifest.kind).toBe("ConfigMap");
    expect(manifest.metadata.name).toBe("app");
    expect(manifest.metadata.namespace).toBe("shop");
  });

  it("rejects a manifest without a name", () => {
    expect(() => readManifest("apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n")).toThrow(/metadata.name/);
  });

  it("builds a label selector", () => {
    expect(matchLabelsSelector({ app: "api", tier: "front" })).toBe("app=api,tier=front");
    expect(matchLabelsSelector({})).toBeNull();
  });

  it("keeps labels whose value is empty", () => {
    expect(matchLabelsSelector({ app: "api", canary: "" })).toBe("app=api,canary=");
  });

  it("includes matchExpressions so Helm-style selectors find their pods", () => {
    expect(selectorString({
      matchLabels: { app: "api" },
      matchExpressions: [
        { key: "tier", operator: "In", values: ["web", "edge"] },
        { key: "track", operator: "NotIn", values: ["canary"] },
        { key: "owner", operator: "Exists" },
        { key: "legacy", operator: "DoesNotExist" },
      ],
    })).toBe("app=api,tier in (web,edge),track notin (canary),owner,!legacy");
    expect(selectorString({ matchExpressions: [{ key: "app", operator: "In", values: ["api"] }] })).toBe("app in (api)");
    expect(selectorString({})).toBeNull();
  });

  it("matches labels in memory the way the API server does", () => {
    const labels = { app: "api", tier: "web" };
    expect(selectorMatches({ matchLabels: { app: "api" } }, labels)).toBe(true);
    expect(selectorMatches({ matchLabels: { app: "worker" } }, labels)).toBe(false);
    expect(selectorMatches({ matchExpressions: [{ key: "tier", operator: "In", values: ["web"] }] }, labels)).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: "tier", operator: "NotIn", values: ["web"] }] }, labels)).toBe(false);
    expect(selectorMatches({ matchExpressions: [{ key: "zone", operator: "DoesNotExist" }] }, labels)).toBe(true);
    expect(selectorMatches({}, labels)).toBe(false);
  });
});
