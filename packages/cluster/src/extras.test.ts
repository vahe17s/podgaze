import { describe, expect, it } from "vitest";
import { manualJobName, pickRollbackRevision, rollbackTemplate, shellCommand } from "./commands.js";
import { friendlyAuthError, messageOf } from "./batch.js";
import { lastExit, nodeToRow } from "./project.js";
import { ingressServices, podReferences } from "./related.js";
import { containerPortFor, pickPod } from "./forward-target.js";

describe("related objects", () => {
  it("finds every ConfigMap, Secret, PVC and service account a pod uses", () => {
    const refs = podReferences({
      serviceAccountName: "api",
      imagePullSecrets: [{ name: "registry" }],
      initContainers: [{ envFrom: [{ configMapRef: { name: "boot" } }] }],
      containers: [{
        env: [{ valueFrom: { secretKeyRef: { name: "db" } } }, { valueFrom: { configMapKeyRef: { name: "app" } } }],
        envFrom: [{ secretRef: { name: "db" } }],
      }],
      volumes: [
        { configMap: { name: "app" } },
        { persistentVolumeClaim: { claimName: "data" } },
        { projected: { sources: [{ secret: { name: "token" } }] } },
      ],
    });
    expect(refs).toEqual([
      { kind: "ConfigMap", name: "boot", relation: "Env" },
      { kind: "Secret", name: "db", relation: "Env" },
      { kind: "ConfigMap", name: "app", relation: "Env" },
      { kind: "PersistentVolumeClaim", name: "data", relation: "Volume" },
      { kind: "Secret", name: "token", relation: "Volume" },
      { kind: "Secret", name: "registry", relation: "Image pull" },
      { kind: "ServiceAccount", name: "api", relation: "Service account" },
    ]);
  });

  it("reads the services an ingress routes to", () => {
    expect(ingressServices({
      spec: {
        defaultBackend: { service: { name: "fallback" } },
        rules: [{ http: { paths: [{ backend: { service: { name: "api" } } }, { backend: { service: { name: "api" } } }] } }],
      },
    })).toEqual(["fallback", "api"]);
  });
});

describe("crash diagnosis", () => {
  it("reports why the most-restarted container last stopped", () => {
    expect(lastExit([
      { restartCount: 1, lastState: { terminated: { reason: "Error", exitCode: 1 } } },
      { restartCount: 9, lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } },
    ])).toBe("OOMKilled (137)");
    expect(lastExit([{ restartCount: 0, state: { running: {} } }])).toBe("");
    expect(lastExit([{ restartCount: 0, state: { terminated: { reason: "Completed", exitCode: 0 } } }])).toBe("");
  });

  it("marks a cordoned node", () => {
    const row = nodeToRow({
      metadata: { uid: "n1", name: "n1" },
      spec: { unschedulable: true },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    expect(row?.status).toBe("Ready,SchedulingDisabled");
    expect(row?.unschedulable).toBe(true);
  });
});

describe("rollback and cron helpers", () => {
  it("rolls back to the revision before the current one by default", () => {
    expect(pickRollbackRevision([1, 2, 3], 3, undefined)).toBe(2);
    expect(pickRollbackRevision([1, 4, 7], 7, 1)).toBe(1);
    expect(() => pickRollbackRevision([3], 3, undefined)).toThrow(/no earlier revision/);
    expect(() => pickRollbackRevision([1, 2], 2, 5)).toThrow(/not in the rollout history/);
    expect(() => pickRollbackRevision([1, 2], 2, 2)).toThrow(/already running/);
  });

  it("drops the controller's hash label from the restored template", () => {
    const template = { metadata: { labels: { app: "api", "pod-template-hash": "abc" } }, spec: { containers: [] } };
    expect(rollbackTemplate(template)).toEqual({ metadata: { labels: { app: "api" } }, spec: { containers: [] } });
    expect(template.metadata.labels["pod-template-hash"]).toBe("abc");
  });

  it("keeps manual job names within 63 characters", () => {
    const name = manualJobName("a".repeat(70), 1_700_000_000_000);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/-manual-[a-z0-9]+$/);
  });

  it("prints the kubectl equivalent of the new commands", () => {
    expect(shellCommand({ name: "rollout-undo", kind: "Deployment", resourceName: "api", namespace: "shop", revision: 4 }))
      .toBe("kubectl rollout undo deployment/api -n shop --to-revision=4");
    expect(shellCommand({ name: "cordon", kind: "Node", resourceName: "n1", namespace: null })).toBe("kubectl cordon n1");
    expect(shellCommand({ name: "drain", kind: "Node", resourceName: "n1", namespace: null })).toBe("kubectl drain n1 --ignore-daemonsets --delete-emptydir-data");
    expect(shellCommand({ name: "suspend", kind: "CronJob", resourceName: "nightly", namespace: "ops" }))
      .toBe(`kubectl patch cronjob nightly -n ops -p '{"spec":{"suspend":true}}'`);
  });
});

describe("login errors", () => {
  it("names the missing login helper", () => {
    expect(friendlyAuthError("spawnSync gke-gcloud-auth-plugin ENOENT")).toMatch(/Could not run "gke-gcloud-auth-plugin"/);
    expect(friendlyAuthError("connect ECONNREFUSED")).toBe("connect ECONNREFUSED");
  });
});

describe("forwarding to a Service", () => {
  it("prefers a ready pod and skips terminating ones", () => {
    const pods = [
      { metadata: { name: "old", deletionTimestamp: "now" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
      { metadata: { name: "warming" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "False" }] } },
      { metadata: { name: "ready" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
    ];
    expect(pickPod(pods)?.metadata?.name).toBe("ready");
    expect(pickPod(pods.slice(0, 2))?.metadata?.name).toBe("warming");
    expect(pickPod([{ metadata: { name: "p" }, status: { phase: "Pending" } }])).toBeNull();
  });

  it("follows numbered and named target ports", () => {
    const pod = { spec: { containers: [{ ports: [{ name: "http", containerPort: 8080 }] }] } };
    expect(containerPortFor([{ port: 80, targetPort: 9000 }], 80, pod)).toBe(9000);
    expect(containerPortFor([{ port: 80, targetPort: "http" }], 80, pod)).toBe(8080);
    expect(containerPortFor([{ port: 80 }], 80, pod)).toBe(80);
    expect(() => containerPortFor([{ port: 80, targetPort: "grpc" }], 80, pod)).toThrow(/named grpc/);
  });

  it("turns a 401 into advice and drops the header dump from other HTTP errors", () => {
    const unauthorized = Object.assign(new Error('HTTP-Code: 401\nMessage: Unauthorized\nBody: undefined\nHeaders: {"audit-id":"x"}'), { code: 401 });
    expect(messageOf(unauthorized)).toMatch(/rejected this context's credentials \(401 Unauthorized\)/);
    const gateway = Object.assign(new Error('HTTP-Code: 503\nMessage: Service Unavailable\nBody: undefined\nHeaders: {"date":"now"}'), { code: 503 });
    expect(messageOf(gateway)).toBe("Service Unavailable (HTTP 503)");
    const forbidden = Object.assign(new Error("HTTP-Code: 403"), { code: 403, body: { message: 'pods is forbidden: User "dev" cannot list' } });
    expect(messageOf(forbidden)).toBe('pods is forbidden: User "dev" cannot list');
  });
});
