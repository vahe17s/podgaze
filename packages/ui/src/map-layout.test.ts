import { describe, expect, it } from "vitest";
import type { MapNode } from "@podgaze/contracts";
import { layoutMap } from "./map-layout";

const node = (kind: string, name: string, group: number): MapNode => ({ id: `${kind}/ns/${name}`, kind, name, namespace: "ns", status: "", group });

describe("layoutMap", () => {
  it("puts kinds in columns left to right and apps in separate bands", () => {
    const nodes = [node("Pod", "api-1", 0), node("Service", "api", 0), node("Deployment", "api", 0), node("Deployment", "worker", 1), node("Secret", "shared", 0)];
    const layout = layoutMap(nodes, [
      { from: "Service/ns/api", to: "Deployment/ns/api", relation: "routes to" },
      { from: "Deployment/ns/api", to: "Pod/ns/api-1", relation: "owns" },
      { from: "Deployment/ns/api", to: "Secret/ns/shared", relation: "reads" },
    ]);
    const at = (id: string) => layout.nodes.find((item) => item.id === id)!;
    expect(at("Service/ns/api").x).toBeLessThan(at("Deployment/ns/api").x);
    expect(at("Deployment/ns/api").x).toBeLessThan(at("Pod/ns/api-1").x);
    expect(at("Pod/ns/api-1").x).toBeLessThan(at("Secret/ns/shared").x);
    expect(layout.groups).toHaveLength(2);
    expect(at("Deployment/ns/worker").y).toBeGreaterThan(at("Deployment/ns/api").y);
    expect(layout.groups[0]!.label).toBe("api · ns");
  });
});
