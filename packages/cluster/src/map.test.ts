import { describe, expect, it } from "vitest";
import { argoApp, hubCharts, nodeShellPod, syncPatch } from "./argo.js";
import { buildMap, parseEqualitySelector } from "./map.js";

const ns = "shop";
const meta = (name: string, extra: Record<string, unknown> = {}) => ({ name, namespace: ns, uid: `uid-${name}`, ...extra });

const input = {
  Ingress: [{ metadata: meta("web"), spec: { rules: [{ http: { paths: [{ backend: { service: { name: "api" } } }] } }], tls: [{ secretName: "web-tls" }] } }],
  Service: [{ metadata: meta("api", { uid: "svc-api" }), spec: { selector: { app: "api" } } }, { metadata: meta("cache", { uid: "svc-cache" }), spec: { selector: { app: "cache" } } }],
  Deployment: [{ metadata: meta("api", { labels: { team: "shop" } }), spec: { replicas: 2, template: { spec: { containers: [{ envFrom: [{ secretRef: { name: "shared" } }] }] } } } }],
  StatefulSet: [{ metadata: meta("cache"), spec: { template: { spec: { containers: [{ envFrom: [{ secretRef: { name: "shared" } }] }], volumes: [{ persistentVolumeClaim: { claimName: "data" } }] } } } }],
  ReplicaSet: [
    { metadata: meta("api-1", { ownerReferences: [{ uid: "uid-api" }] }), spec: { replicas: 2 } },
    { metadata: meta("api-0", { ownerReferences: [{ uid: "uid-api" }] }), spec: { replicas: 0 } },
  ],
  Pod: [
    { metadata: meta("api-1-a", { labels: { app: "api" }, ownerReferences: [{ uid: "uid-api-1" }] }), status: { phase: "Running" } },
    { metadata: meta("api-1-b", { labels: { app: "api" }, ownerReferences: [{ uid: "uid-api-1" }] }), status: { phase: "Running" } },
    { metadata: meta("cache-0", { labels: { app: "cache" }, ownerReferences: [{ uid: "uid-cache" }] }), status: { phase: "Running" } },
  ],
  Secret: [{ metadata: meta("shared") }, { metadata: meta("web-tls") }, { metadata: meta("unused") }],
  PersistentVolumeClaim: [{ metadata: meta("data") }],
};

describe("buildMap", () => {
  it("connects routing, ownership, and config, and skips idle ReplicaSets and unused config", () => {
    const map = buildMap(input);
    const ids = map.nodes.map((node) => node.id);
    expect(ids).not.toContain("ReplicaSet/shop/api-0");
    expect(ids).not.toContain("Secret/shop/unused");
    const edges = map.edges.map((edge) => `${edge.from} ${edge.relation} ${edge.to}`);
    expect(edges).toEqual(expect.arrayContaining([
      "Ingress/shop/web routes to Service/shop/api",
      "Service/shop/api routes to Deployment/shop/api",
      "Deployment/shop/api owns ReplicaSet/shop/api-1",
      "ReplicaSet/shop/api-1 owns Pod/shop/api-1-a",
      "Deployment/shop/api reads Secret/shop/shared",
      "StatefulSet/shop/cache mounts PersistentVolumeClaim/shop/data",
      "Ingress/shop/web TLS Secret/shop/web-tls",
    ]));
  });

  it("keeps two apps apart even when they share a Secret", () => {
    const map = buildMap(input);
    const group = (id: string) => map.nodes.find((node) => node.id === id)!.group;
    expect(group("Deployment/shop/api")).toBe(group("Pod/shop/api-1-b"));
    expect(group("Deployment/shop/api")).toBe(group("Ingress/shop/web"));
    expect(group("StatefulSet/shop/cache")).not.toBe(group("Deployment/shop/api"));
  });

  it("narrows to labelled objects and what hangs off them", () => {
    const map = buildMap(input, { labelSelector: parseEqualitySelector("team=shop") });
    const ids = map.nodes.map((node) => node.id);
    expect(ids).toContain("Pod/shop/api-1-a");
    expect(ids).toContain("Ingress/shop/web");
    expect(ids).not.toContain("StatefulSet/shop/cache");
    expect(() => parseEqualitySelector("team")).toThrow(/key=value/);
  });
});

describe("argo", () => {
  const raw = {
    metadata: { name: "shop", namespace: "argocd" },
    spec: { project: "default", source: { repoURL: "https://git/x", path: "charts/shop", targetRevision: "main" }, destination: { server: "https://kubernetes.default.svc", namespace: "shop" }, syncPolicy: { automated: {} } },
    status: {
      sync: { status: "OutOfSync", revision: "abc123" },
      health: { status: "Degraded", message: "1 pod failing" },
      operationState: { phase: "Failed", message: "one or more objects failed", startedAt: "2026-10-15T10:00:00Z" },
      resources: [{ kind: "Deployment", group: "apps", name: "api", namespace: "shop", status: "OutOfSync", health: { status: "Degraded" } }],
    },
  };

  it("reads sync, health, source, and resources", () => {
    expect(argoApp(raw)).toMatchObject({
      name: "shop", sync: "OutOfSync", health: "Degraded", repo: "https://git/x", path: "charts/shop", targetRevision: "main", revision: "abc123",
      destNamespace: "shop", autoSync: true, operation: { phase: "Failed" },
      resources: [{ kind: "Deployment", name: "api", sync: "OutOfSync", health: "Degraded" }],
    });
  });

  it("starts a sync the way the argocd CLI does", () => {
    expect(syncPatch(argoApp(raw)!, true)).toEqual({ operation: { initiatedBy: { username: "podgaze" }, sync: { revision: "main", prune: true, syncStrategy: { hook: {} } } } });
  });

  it("maps Artifact Hub results", () => {
    expect(hubCharts({ packages: [{ name: "redis", version: "1", app_version: "7", stars: 9, repository: { name: "bitnami", url: "https://charts.bitnami.com/bitnami", verified_publisher: true } }] })[0])
      .toMatchObject({ name: "redis", stars: 9, repo: { name: "bitnami", verified: true, official: false } });
  });

  it("builds a node shell pod that cleans itself up", () => {
    const pod = nodeShellPod("aks-node-1", "podgaze-node-shell-x") as { spec: Record<string, unknown> };
    expect(pod.spec).toMatchObject({ nodeName: "aks-node-1", hostPID: true, activeDeadlineSeconds: 14400, tolerations: [{ operator: "Exists" }] });
  });
});
