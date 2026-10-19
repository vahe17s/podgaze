import { describe, expect, it } from "vitest";
import { manifestDiff, renderedManifest } from "./helm-diff";

const before = `---
# Source: shop/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
spec:
  replicas: 2
---
# Source: shop/templates/cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shop-old
data:
  a: "1"
---
# Source: shop/templates/svc.yaml
apiVersion: v1
kind: Service
metadata:
  name: shop
`;

const output = `Release "shop" has been upgraded. Happy Helming!
NAME: shop
HOOKS:
---
# Source: shop/templates/test.yaml
kind: Pod
MANIFEST:
---
# Source: shop/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
spec:
  replicas: 3
---
# Source: shop/templates/svc.yaml
apiVersion: v1
kind: Service
metadata:
  name: shop
---
# Source: shop/templates/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shop

NOTES:
Thanks
`;

describe("helm upgrade diff", () => {
  it("reads the rendered manifest out of the dry run and diffs it object by object", () => {
    const rendered = renderedManifest(output)!;
    expect(rendered).not.toContain("NOTES");
    expect(rendered).not.toContain("kind: Pod");
    const diff = manifestDiff(before, rendered);
    expect(diff.added.map((item) => item.label)).toEqual(["HorizontalPodAutoscaler shop"]);
    expect(diff.removed.map((item) => item.label)).toEqual(["ConfigMap shop-old"]);
    expect(diff.changed.map((item) => item.label)).toEqual(["Deployment shop"]);
    expect(diff.changed[0]!.rows.filter((row) => row.kind !== "same").map((row) => `${row.kind} ${row.text.trim()}`)).toEqual(["remove replicas: 2", "add replicas: 3"]);
    expect(diff.unchanged).toBe(1);
  });

  it("returns null when the output has no manifest", () => {
    expect(renderedManifest("Error: something")).toBeNull();
  });
});
