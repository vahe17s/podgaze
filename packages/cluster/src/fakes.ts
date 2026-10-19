import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApplyRequest, NodeRow, PodRow, ResourceKind, ResourceRow } from "@podgaze/contracts";
import type { ClusterBackend, Listed, WatchHandlers, WatchHandle } from "./batch.js";

// Test doubles shared by the session and hub tests.
export const kubeconfig = `
apiVersion: v1
kind: Config
clusters:
- name: prod
  cluster:
    server: https://prod.example:6443
contexts:
- name: prod
  context:
    cluster: prod
    user: admin
    namespace: default
users:
- name: admin
  user:
    token: secret
`;

export function podRow(uid: string, name = uid): PodRow {
  return {
    uid,
    name,
    namespace: "default",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    nodeName: "node-a",
    ageStart: "2026-01-01T00:00:00.000Z",
    images: ["app:1"],
    ip: "10.0.0.8",
    qos: "Burstable",
    controlledBy: "ReplicaSet/api",
    ports: ["8080/TCP"],
    containers: [{ name: "app", image: "app:1", ready: true, restarts: 0, state: "Running" }],
    lastExit: "",
    labels: { app: "api" },
    requests: { cpuMillicores: 100, memoryBytes: 0 },
    limits: { cpuMillicores: 0, memoryBytes: 0 },
  };
}

export function nodeRow(uid: string): NodeRow {
  return {
    uid,
    name: uid,
    status: "Ready",
    roles: ["worker"],
    kubeletVersion: "v1.32.1",
    ageStart: "2026-01-01T00:00:00.000Z",
    internalIP: "10.0.0.4",
    cpu: "4",
    memory: "8Gi",
    podCapacity: "110",
    os: "Ubuntu",
    runtime: "containerd://1.7.0",
    unschedulable: false,
    labels: {},
  };
}

export class FakeWatch implements WatchHandle {
  stopped = false;
  handlers: WatchHandlers | null = null;
  stop() {
    this.stopped = true;
  }
  emit(phase: string, object: unknown) {
    this.handlers?.onEvent(phase, object);
  }
  fail(statusCode: number | null, message: string) {
    this.handlers?.onError({ statusCode, message });
  }
}

export class FakeBackend implements ClusterBackend {
  podLists: (string | null)[] = [];
  nodeLists = 0;
  podWatches: FakeWatch[] = [];
  nodeWatches: FakeWatch[] = [];
  pods: Listed<PodRow> = { resourceVersion: "1", rows: [podRow("p1", "api")] };
  nodes: Listed<NodeRow> = { resourceVersion: "1", rows: [nodeRow("n1")] };
  namespaces = ["default", "kube-system"];
  podError: unknown = null;
  nodeError: unknown = null;
  podGate: Promise<Listed<PodRow>> | null = null;

  listPods(namespace: string | null) {
    this.podLists.push(namespace);
    if (this.podGate) return this.podGate;
    if (this.podError) return Promise.reject(this.podError);
    return Promise.resolve(this.pods);
  }

  async watchPods(_namespace: string | null, _resourceVersion: string, handlers: WatchHandlers) {
    const watch = new FakeWatch();
    watch.handlers = handlers;
    this.podWatches.push(watch);
    return watch;
  }

  listNodes() {
    this.nodeLists += 1;
    if (this.nodeError) return Promise.reject(this.nodeError);
    return Promise.resolve(this.nodes);
  }

  async watchNodes(_resourceVersion: string, handlers: WatchHandlers) {
    const watch = new FakeWatch();
    watch.handlers = handlers;
    this.nodeWatches.push(watch);
    return watch;
  }

  listNamespaces() {
    return Promise.resolve(this.namespaces);
  }

  listDeployments() {
    return Promise.resolve({ resourceVersion: "1", rows: [] });
  }

  async watchDeployments(_namespace: string | null, _resourceVersion: string, handlers: WatchHandlers) {
    const watch = new FakeWatch();
    watch.handlers = handlers;
    return watch;
  }

  getYaml() {
    return Promise.resolve("kind: Pod\n");
  }

  runCommand() {
    return Promise.resolve({ title: "Describe", command: "kubectl describe pod api", output: "Name: api\n" });
  }

  getLogs() {
    return Promise.resolve({ filename: "api.log", text: "listening\n" });
  }

  applied: ApplyRequest[] = [];

  applyYaml(request: ApplyRequest) {
    this.applied.push(request);
    return Promise.resolve({ applied: !request.dryRun, live: "kind: ConfigMap\n", yaml: "kind: ConfigMap\n", message: "Live manifest updated.", conflicts: [] });
  }

  listRelated() {
    return Promise.resolve([]);
  }

  listEvents() {
    return Promise.resolve([]);
  }

  listWarnings() {
    return Promise.resolve([]);
  }

  checkAccess() {
    return Promise.resolve({});
  }

  startDebug() {
    return Promise.resolve({ container: "debugger-1" });
  }

  listExecTargets() {
    return Promise.resolve([]);
  }

  readSecret() {
    return Promise.resolve({ type: "Opaque", values: [{ key: "password", value: "s3cret", binary: false, encoded: "czNjcmV0" }], resourceVersion: "7" });
  }

  readUsage() {
    return Promise.resolve({
      available: true,
      nodes: [{ name: "n1", namespace: "", cpuMillicores: 500, memoryBytes: 1024 }],
      pods: [{ name: "api", namespace: "default", cpuMillicores: 100, memoryBytes: 512 }],
    });
  }

  listResources(kind: ResourceKind): Promise<Listed<ResourceRow>> {
    if (kind === "Service") {
      return Promise.resolve({
        resourceVersion: "1",
        rows: [
          { uid: "svc-1", kind: "Service", name: "api", namespace: "default", status: "Active", ageStart: "", columns: {}, labels: {} },
          { uid: "svc-2", kind: "Service", name: "web", namespace: "default", status: "Active", ageStart: "", columns: {}, labels: {} },
        ],
      });
    }
    return Promise.resolve({ resourceVersion: "1", rows: [] });
  }

  async watchResources(_kind: unknown, _namespace: string | null, _resourceVersion: string, handlers: WatchHandlers) {
    const watch = new FakeWatch();
    watch.handlers = handlers;
    return watch;
  }
}

export function manualClock() {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  return {
    setTimeout(fn: () => void) {
      const timer = { fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    flush() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) {
        if (!timer.cancelled) timer.fn();
      }
    },
  };
}

export async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

export const files: string[] = [];

export function writeKubeconfig(): string {
  const file = path.join(os.tmpdir(), `podgaze-session-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  fs.writeFileSync(file, kubeconfig);
  files.push(file);
  return file;
}
