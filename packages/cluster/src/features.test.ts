import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { catalogEntry, registerCustomKinds, type RowBatch, type Session } from "@podgaze/contracts";
import { crdEntries } from "./custom-kinds.js";
import { FakeBackend, files, kubeconfig, settle } from "./fakes.js";
import { helmArgs, latestReleases, releaseDetail, type HelmSecretLike } from "./helm.js";
import { createClusterHub } from "./hub.js";
import { evaluatePath } from "./jsonpath.js";
import { customStatus, objectToRow, podToRow } from "./project.js";
import { whoCan } from "./rbac.js";
import { createClusterApp, memoryAudit } from "./session.js";

afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

function twoContexts(): string {
  const file = path.join(os.tmpdir(), `podgaze-hub-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  fs.writeFileSync(file, kubeconfig.replace("contexts:\n", "contexts:\n- name: staging\n  context:\n    cluster: prod\n    user: admin\n"));
  files.push(file);
  return file;
}

describe("evaluatePath", () => {
  const object = { status: { phase: "Bound", conditions: [{ type: "Synced", status: "False" }, { type: "Ready", status: "True" }] }, spec: { hosts: ["a", "b"] } };
  it("reads fields, indexes, wildcards, and filters", () => {
    expect(evaluatePath(object, ".status.phase")).toBe("Bound");
    expect(evaluatePath(object, ".spec.hosts[1]")).toBe("b");
    expect(evaluatePath(object, ".spec.hosts[*]")).toBe("a, b");
    expect(evaluatePath(object, ".spec.hosts")).toBe("a, b");
    expect(evaluatePath(object, '.status.conditions[?(@.type=="Ready")].status')).toBe("True");
    expect(evaluatePath(object, ".missing.field")).toBe("");
  });
});

describe("custom resources", () => {
  const crd = {
    spec: {
      group: "cert-manager.io",
      scope: "Namespaced",
      names: { kind: "Certificate", plural: "certificates" },
      versions: [
        { name: "v1alpha2", served: false },
        {
          name: "v1",
          served: true,
          storage: true,
          additionalPrinterColumns: [
            { name: "Ready", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
            { name: "Secret", type: "string", jsonPath: ".spec.secretName" },
            { name: "Debug", type: "string", jsonPath: ".x", priority: 1 },
            { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
          ],
        },
      ],
    },
  };

  it("builds a catalog entry from the served storage version and its printer columns", () => {
    const [entry] = crdEntries([crd]);
    expect(entry).toMatchObject({
      kind: "certificates.cert-manager.io",
      apiKind: "Certificate",
      apiVersion: "cert-manager.io/v1",
      group: "Custom",
      namespaced: true,
      columns: [{ key: "ready", header: "Ready" }, { key: "secret", header: "Secret" }],
    });
  });

  it("projects custom objects with their printer columns and a sensible status", () => {
    registerCustomKinds(crdEntries([crd]));
    expect(catalogEntry("certificates.cert-manager.io")?.apiKind).toBe("Certificate");
    const row = objectToRow("certificates.cert-manager.io", {
      metadata: { name: "web-tls", namespace: "shop", uid: "c1", labels: { team: "web" } },
      spec: { secretName: "web-tls-secret" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    expect(row).toMatchObject({ status: "Ready", columns: { ready: "True", secret: "web-tls-secret" }, labels: { team: "web" } });
    expect(customStatus({ status: { health: { status: "Healthy" }, sync: { status: "OutOfSync" } } })).toBe("Healthy, OutOfSync");
    expect(customStatus({ status: { conditions: [{ type: "Ready", status: "False", reason: "Pending" }] } })).toBe("Pending");
  });
});

describe("pod requests and limits", () => {
  it("sums container requests and limits", () => {
    const row = podToRow({
      metadata: { uid: "p", name: "api", labels: { app: "api" } },
      spec: {
        containers: [
          { name: "a", resources: { requests: { cpu: "250m", memory: "128Mi" }, limits: { cpu: "1", memory: "256Mi" } } },
          { name: "b", resources: { requests: { cpu: "0.25" } } },
        ],
      },
    });
    expect(row?.requests).toEqual({ cpuMillicores: 500, memoryBytes: 128 * 1024 * 1024 });
    expect(row?.limits).toEqual({ cpuMillicores: 1000, memoryBytes: 256 * 1024 * 1024 });
    expect(row?.labels).toEqual({ app: "api" });
  });
});

function helmSecret(name: string, revision: number, status: string, values: Record<string, unknown> = {}): HelmSecretLike {
  const release = {
    name,
    namespace: "shop",
    version: revision,
    info: { status, last_deployed: `2026-0${revision}-01T00:00:00Z`, description: `rev ${revision}`, notes: "Visit http://api" },
    chart: { metadata: { name: "api", version: `1.${revision}.0`, appVersion: "2.0" } },
    config: values,
    manifest: "kind: Deployment\n",
  };
  const inner = gzipSync(Buffer.from(JSON.stringify(release))).toString("base64");
  return {
    metadata: { name: `sh.helm.release.v1.${name}.v${revision}`, namespace: "shop", labels: { owner: "helm", name, version: String(revision), status } },
    type: "helm.sh/release.v1",
    data: { release: Buffer.from(inner).toString("base64") },
  };
}

describe("helm", () => {
  it("lists the newest revision of each release", () => {
    const releases = latestReleases([helmSecret("api", 1, "superseded"), helmSecret("api", 2, "deployed"), helmSecret("web", 1, "failed")]);
    expect(releases.map((item) => [item.name, item.revision, item.status, item.chartVersion])).toEqual([
      ["api", 2, "deployed", "1.2.0"],
      ["web", 1, "failed", "1.1.0"],
    ]);
  });

  it("reads values, notes, and history for one release", () => {
    const detail = releaseDetail([helmSecret("api", 1, "superseded"), helmSecret("api", 2, "deployed", { replicas: 3 })]);
    expect(detail.values).toBe("replicas: 3\n");
    expect(detail.notes).toBe("Visit http://api");
    expect(detail.history.map((item) => item.revision)).toEqual([2, 1]);
  });

  it("builds helm arguments scoped to the context", () => {
    expect(helmArgs("rollback", "api", "shop", 1, "/k", "prod")).toEqual(["rollback", "api", "1", "--namespace", "shop", "--kube-context", "prod", "--kubeconfig", "/k", "--wait", "--timeout", "5m0s"]);
  });
});

describe("who can", () => {
  it("finds subjects through cluster and namespace bindings", () => {
    const subjects = whoCan({ verb: "delete", resource: "pods", group: "", namespace: "shop" }, {
      clusterRoles: [
        { metadata: { name: "admin" }, rules: [{ verbs: ["*"], apiGroups: ["*"], resources: ["*"] }] },
        { metadata: { name: "view" }, rules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods"] }] },
      ],
      roles: [{ metadata: { name: "pod-killer", namespace: "shop" }, rules: [{ verbs: ["delete"], apiGroups: [""], resources: ["pods"] }] }],
      clusterRoleBindings: [
        { metadata: { name: "ops" }, roleRef: { kind: "ClusterRole", name: "admin" }, subjects: [{ kind: "Group", name: "ops" }] },
        { metadata: { name: "viewers" }, roleRef: { kind: "ClusterRole", name: "view" }, subjects: [{ kind: "Group", name: "everyone" }] },
      ],
      roleBindings: [
        { metadata: { name: "ci", namespace: "shop" }, roleRef: { kind: "Role", name: "pod-killer" }, subjects: [{ kind: "ServiceAccount", name: "ci", namespace: "shop" }] },
        { metadata: { name: "other", namespace: "web" }, roleRef: { kind: "ClusterRole", name: "admin" }, subjects: [{ kind: "User", name: "eve" }] },
      ],
    });
    expect(subjects.map((item) => `${item.kind}/${item.name} via ${item.binding}`)).toEqual([
      "Group/ops via ClusterRoleBinding/ops",
      "ServiceAccount/ci via RoleBinding/ci",
    ]);
  });
});

describe("namespace guards and history", () => {
  it("lets one namespace stay writable on a read-only cluster, and records changes", async () => {
    const file = twoContexts();
    const backend = new FakeBackend();
    const audit = memoryAudit();
    const app = createClusterApp({ resolvePath: () => file, backendFor: () => backend, audit });
    await app.connect("prod");
    await app.setGuard("prod", { protected: false, readOnly: true, namespaces: { sandbox: "writable" } });
    await expect(app.runCommand({ name: "delete", kind: "Pod", resourceName: "api", namespace: "default" })).rejects.toThrow(/read-only/);
    await app.runCommand({ name: "delete", kind: "Pod", resourceName: "api", namespace: "sandbox" });
    expect(() => app.assertWritable("sandbox")).not.toThrow();
    expect(() => app.assertWritable(null)).toThrow(/read-only/);
    const history = await app.listAudit();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "delete", target: "pod/api", namespace: "sandbox", cluster: "prod", ok: true, kubectl: "kubectl delete pod api -n sandbox" });
  });
});

describe("createClusterHub", () => {
  it("cleans up a cluster before its tab closes, also when the oldest tab is dropped at the limit", async () => {
    const file = twoContexts();
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("contexts:\n", "contexts:\n- name: qa\n  context:\n    cluster: prod\n    user: admin\n"));
    const closing: string[] = [];
    const hub = createClusterHub({
      maxOpen: 2,
      makeApp: () => createClusterApp({ resolvePath: () => file, batchMs: 0, backendFor: () => new FakeBackend() }),
      beforeTabClose: (clusterId) => {
        closing.push(clusterId);
      },
    });
    await hub.connect("prod");
    await hub.connect("staging");
    expect(closing).toEqual([]);
    // A third cluster drops the least recently used one that is not on screen.
    await hub.connect("qa");
    expect(closing).toEqual(["prod"]);
    expect(hub.isOpen("prod")).toBe(false);
    await hub.closeCluster("staging");
    expect(closing).toEqual(["prod", "staging"]);
  });

  it("keeps clusters open and replays rows when switching back", async () => {
    const file = twoContexts();
    const backends = new Map<string, FakeBackend>();
    const hub = createClusterHub({
      makeApp: () => createClusterApp({
        resolvePath: () => file,
        batchMs: 0,
        backendFor: (_path, context) => {
          const backend = new FakeBackend();
          if (context === "staging") backend.pods = { resourceVersion: "1", rows: [{ ...backend.pods.rows[0]!, uid: "s1", name: "staging-api" }] };
          backends.set(context, backend);
          return backend;
        },
      }),
    });
    const sessions: Session[] = [];
    const batches: RowBatch[] = [];
    hub.onSession((session) => sessions.push(session));
    hub.subscribeRows((batch) => batches.push(batch));

    await hub.connect("prod");
    await hub.connect("staging");
    // Rows reach the hub through each session's batch timer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(sessions.at(-1)?.clusterId).toBe("staging");
    expect(sessions.at(-1)?.open?.map((item) => item.id)).toEqual(["prod", "staging"]);

    batches.length = 0;
    await hub.connect("prod");
    expect(sessions.at(-1)?.clusterId).toBe("prod");
    expect(batches[0]?.pods?.reset).toBe(true);
    expect(batches[0]?.pods?.upsert.map((row) => row.name)).toEqual(["api"]);
    expect(backends.size).toBe(2);

    await hub.closeCluster("staging");
    expect(sessions.at(-1)?.open?.map((item) => item.id)).toEqual(["prod"]);
    expect(sessions.at(-1)?.clusterId).toBe("prod");

    await hub.disconnect();
    expect(sessions.at(-1)?.state).toBe("disconnected");
    expect(sessions.at(-1)?.open).toEqual([]);
  });
});

describe("helm install", () => {
  it("builds install arguments with values from a file and refuses bad names", async () => {
    const { installArgs, installCommandLine, parseCharts, parseRepos } = await import("./helm.js");
    expect(installArgs({ release: "redis", namespace: "cache", chart: "bitnami/redis", version: "19.6.1", createNamespace: true, dryRun: true }, "/tmp/v.yaml", "/k", "dev")).toEqual([
      "install", "redis", "bitnami/redis", "--namespace", "cache", "--values", "/tmp/v.yaml", "--version", "19.6.1", "--create-namespace", "--dry-run=server", "--kube-context", "dev", "--kubeconfig", "/k", "--timeout", "5m0s",
    ]);
    expect(installArgs({ release: "redis", namespace: "cache", chart: "bitnami/redis", upgrade: true, createNamespace: true }, "/v", "/k", "dev").slice(0, 3)).toEqual(["upgrade", "redis", "bitnami/redis"]);
    expect(() => installArgs({ release: "Bad_Name", namespace: "x", chart: "a/b" }, "/v", "/k", "dev")).toThrow(/lowercase/);
    expect(installCommandLine({ release: "redis", namespace: "cache", chart: "bitnami/redis" })).toBe("helm install redis bitnami/redis -n cache -f values.yaml");
    expect(parseRepos('[{"name":"bitnami","url":"https://charts.bitnami.com/bitnami"}]')).toEqual([{ name: "bitnami", url: "https://charts.bitnami.com/bitnami" }]);
    expect(parseCharts('[{"name":"bitnami/redis","version":"19.6.1","app_version":"7.2.5","description":"Redis"}]')[0]).toMatchObject({ name: "bitnami/redis", appVersion: "7.2.5" });
    expect(parseRepos("")).toEqual([]);
  });

  it("refuses an install into a read-only namespace and records a real install", async () => {
    const file = twoContexts();
    const backend = Object.assign(new FakeBackend(), {
      helmInstall: async () => ({ title: "Install", command: "helm install", output: "STATUS: deployed" }),
    });
    const audit = memoryAudit();
    const app = createClusterApp({ resolvePath: () => file, backendFor: () => backend, audit });
    await app.connect("prod");
    await app.setGuard("prod", { protected: false, readOnly: false, namespaces: { locked: "readOnly" } });
    await expect(app.helmInstall({ release: "redis", namespace: "locked", chart: "bitnami/redis", values: "" })).rejects.toThrow(/read-only/);
    await app.helmInstall({ release: "redis", namespace: "cache", chart: "bitnami/redis", values: "", dryRun: true });
    expect(await app.listAudit()).toHaveLength(0);
    await app.helmInstall({ release: "redis", namespace: "cache", chart: "bitnami/redis", values: "" });
    expect((await app.listAudit())[0]).toMatchObject({ action: "helm install", target: "release/redis", namespace: "cache" });
  });
});

describe("related lookup for custom kinds", () => {
  it("reads custom objects by their API Kind, not Podgaze's plural.group key", async () => {
    const { createRelatedLookup } = await import("./related.js");
    registerCustomKinds(crdEntries([{ spec: { group: "networking.istio.io", scope: "Namespaced", names: { kind: "VirtualService", plural: "virtualservices" }, versions: [{ name: "v1", served: true, storage: true }] } }]));
    const reads: { apiVersion?: string; kind?: string }[] = [];
    const objects = {
      read: async (spec: { apiVersion?: string; kind?: string }) => {
        reads.push(spec);
        return { metadata: { name: "reviews", namespace: "development" } };
      },
      list: async () => ({ items: [] }),
    };
    const lookup = createRelatedLookup(objects as never);
    await lookup({ kind: "virtualservices.networking.istio.io", namespace: "development", name: "reviews" });
    expect(reads[0]).toMatchObject({ apiVersion: "networking.istio.io/v1", kind: "VirtualService" });
  });
});

describe("related lookup speed", () => {
  it("starts a deployment's lists together and still lists them in the usual order", async () => {
    const { createRelatedLookup } = await import("./related.js");
    const uid = "d1";
    const labels = { app: "api" };
    const started: string[] = [];
    const release: (() => void)[] = [];
    const items: Record<string, unknown[]> = {
      ReplicaSet: [{ metadata: { name: "api-7d9c", namespace: "dev", ownerReferences: [{ uid }] } }],
      Pod: [{ metadata: { name: "api-7d9c-x1", namespace: "dev", labels }, spec: {}, status: { phase: "Running" } }],
      Service: [{ metadata: { name: "api", namespace: "dev" }, spec: { selector: labels } }],
      HorizontalPodAutoscaler: [{ metadata: { name: "api", namespace: "dev" }, spec: { scaleTargetRef: { kind: "Deployment", name: "api" } } }],
    };
    const objects = {
      read: async () => ({ metadata: { name: "api", namespace: "dev", uid }, spec: { selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {} } } }),
      list: (_apiVersion: string, kind: string) => {
        started.push(kind);
        return new Promise((resolve) => release.push(() => resolve({ items: items[kind] ?? [] })));
      },
    };
    const lookup = createRelatedLookup(objects as never);
    const pending = lookup({ kind: "Deployment", namespace: "dev", name: "api" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // All four are in flight before any answers.
    expect(started.sort()).toEqual(["HorizontalPodAutoscaler", "Pod", "ReplicaSet", "Service"]);
    for (const answer of release.reverse()) answer();
    const found = await pending;
    expect(found.map((item) => item.relation)).toEqual(["Replica set", "Pod", "Service", "Autoscaler"]);
  });
});

describe("countObjects", () => {
  it("uses remainingItemCount when the server sends it, and pages through when it does not", async () => {
    const { countObjects } = await import("./kube-backend.js");
    expect(await countObjects(async () => ({ items: [] }))).toBe(0);
    expect(await countObjects(async () => ({ items: [{}] }))).toBe(1);
    expect(await countObjects(async () => ({ items: [{}], metadata: { _continue: "t", remainingItemCount: 41 } }))).toBe(42);
    const calls: (string | undefined)[] = [];
    const total = await countObjects(async (limit, token) => {
      calls.push(token);
      if (limit === 1) return { items: [{}], metadata: { _continue: "first" } };
      return token ? { items: [{}, {}] } : { items: [{}, {}], metadata: { _continue: "page2" } };
    });
    expect(total).toBe(4);
    expect(calls).toEqual([undefined, undefined, "page2"]);
  });
});

describe("secret edits through the session", () => {
  it("refuses read-only namespaces and records key names only", async () => {
    const file = twoContexts();
    const writes: unknown[] = [];
    const backend = Object.assign(new FakeBackend(), {
      writeSecret: async (request: unknown) => {
        writes.push(request);
        return { type: "Opaque", values: [] };
      },
    });
    const audit = memoryAudit();
    const app = createClusterApp({ resolvePath: () => file, backendFor: () => backend, audit });
    await app.connect("prod");
    await app.setGuard("prod", { protected: false, readOnly: false, namespaces: { locked: "readOnly" } });
    const request = { namespace: "locked", name: "api", resourceVersion: "7", set: [{ key: "TOKEN", value: "very-secret", encoding: "text" as const }], remove: ["OLD"] };
    await expect(app.writeSecret(request)).rejects.toThrow(/read-only/);
    await app.writeSecret({ ...request, namespace: "shop" });
    expect(writes).toHaveLength(1);
    const [entry] = await app.listAudit();
    expect(entry).toMatchObject({ action: "edit secret", target: "secret/api", namespace: "shop" });
    expect(entry!.kubectl).toContain("TOKEN, -OLD");
    expect(JSON.stringify(entry)).not.toContain("very-secret");
  });
});
