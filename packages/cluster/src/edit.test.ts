import { describe, expect, it } from "vitest";
import { conflictPaths, editable, identityProblem, mergePatch } from "./edit.js";

const base = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "api", namespace: "shop", resourceVersion: "10", labels: { app: "api", team: "core" }, managedFields: [{ manager: "kubectl" }] },
  spec: { replicas: 2, template: { spec: { containers: [{ name: "api", image: "api:1" }] } } },
  status: { readyReplicas: 2 },
};

function edited(change: (copy: typeof base) => void) {
  const copy = JSON.parse(JSON.stringify(base)) as typeof base;
  change(copy);
  return copy;
}

describe("editing a live object", () => {
  it("sends only the fields the user changed", () => {
    const draft = edited((copy) => {
      copy.spec.replicas = 3;
    });
    expect(mergePatch(editable(base), editable(draft))).toEqual({ spec: { replicas: 3 } });
  });

  it("removes a deleted key with null and replaces lists whole", () => {
    const draft = edited((copy) => {
      delete (copy.metadata.labels as Record<string, string>).team;
      copy.spec.template.spec.containers[0]!.image = "api:2";
    });
    expect(mergePatch(editable(base), editable(draft))).toEqual({
      metadata: { labels: { team: null } },
      spec: { template: { spec: { containers: [{ name: "api", image: "api:2" }] } } },
    });
  });

  it("ignores status and server bookkeeping", () => {
    const draft = edited((copy) => {
      copy.status.readyReplicas = 0;
      copy.metadata.resourceVersion = "99";
      copy.metadata.managedFields = [];
    });
    expect(mergePatch(editable(base), editable(draft))).toBeNull();
  });

  it("refuses to rename, move, or retype the object", () => {
    expect(identityProblem(base, edited((copy) => { copy.metadata.name = "api-2"; }))).toMatch(/does not create or rename/);
    expect(identityProblem(base, edited((copy) => { copy.metadata.namespace = "other"; }))).toMatch(/does not move/);
    expect(identityProblem(base, edited((copy) => { copy.kind = "StatefulSet"; }))).toMatch(/Kind changed/);
    expect(identityProblem(base, edited((copy) => { copy.spec.replicas = 5; }))).toBeNull();
  });

  it("treats a dropped namespace line as the same namespace", () => {
    const draft = edited((copy) => {
      delete (copy.metadata as { namespace?: string }).namespace;
    });
    expect(identityProblem(base, draft)).toBeNull();
  });

  it("flags only the changed fields that someone else also changed", () => {
    const draft = edited((copy) => {
      copy.spec.replicas = 3;
    });
    const patch = mergePatch(editable(base), editable(draft))!;
    const liveImageChanged = edited((copy) => {
      copy.spec.template.spec.containers[0]!.image = "api:9";
    });
    expect(conflictPaths(patch, editable(base), editable(liveImageChanged))).toEqual([]);
    const liveScaled = edited((copy) => {
      copy.spec.replicas = 6;
    });
    expect(conflictPaths(patch, editable(base), editable(liveScaled))).toEqual(["spec.replicas"]);
  });
});
