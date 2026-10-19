import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplyRequest, NodeRow, PodRow, ResourceKind, ResourceRow, RowBatch, Session } from "@podgaze/contracts";
import { createClusterApp, defaultGuard } from "./session.js";
import { FakeBackend, files, manualClock, nodeRow, podRow, settle, writeKubeconfig } from "./fakes.js";
import type { ClusterBackend, Listed, WatchHandlers, WatchHandle } from "./batch.js";


afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

async function start() {
  const file = writeKubeconfig();
  const backend = new FakeBackend();
  const clock = manualClock();
  const batches: RowBatch[] = [];
  const sessions: Session[] = [];
  const app = createClusterApp({
    resolvePath: () => file,
    backendFor: () => backend,
    clock,
    batchMs: 50,
  });
  app.subscribeRows((batch) => batches.push(batch));
  app.onSession((session) => sessions.push(session));
  return { app, backend, clock, batches, sessions };
}

describe("createClusterApp", () => {
  it("stops connecting when the first request fails, instead of trying every other one", async () => {
    const { app, backend, sessions } = await start();
    let podLists = 0;
    backend.listNamespaces = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: 500 }));
    const listPods = backend.listPods.bind(backend);
    backend.listPods = (namespace) => {
      podLists += 1;
      return listPods(namespace);
    };
    await app.connect("prod");
    expect(sessions.at(-1)).toMatchObject({ state: "disconnected" });
    expect(sessions.at(-1)?.problem).toContain("ECONNREFUSED");
    expect(podLists).toBe(0);
  });

  it("goes on when the account may only not list namespaces", async () => {
    const { app, backend, sessions } = await start();
    backend.listNamespaces = () => Promise.reject(Object.assign(new Error("forbidden"), { code: 403 }));
    await app.connect("prod");
    expect(sessions.at(-1)).toMatchObject({ state: "connected" });
  });

  it("counts kinds that are not already watched", async () => {
    const { app, clock } = await start();
    await app.connect("prod");
    clock.flush();
    const counts = await app.listCounts();
    expect(counts.Service).toBe(2);
    expect(counts.ConfigMap).toBe(0);
    expect(counts.Pod).toBeUndefined();
  });

  it("folds several watch events into one 50ms batch", async () => {
    const { app, backend, clock, batches } = await start();
    await app.connect("prod");
    clock.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.pods?.reset).toBe(true);

    backend.podWatches[0]?.emit("ADDED", {
      metadata: { uid: "p2", name: "worker", namespace: "default" },
      spec: { containers: [{ image: "worker:1" }] },
      status: { phase: "Pending" },
    });
    backend.podWatches[0]?.emit("MODIFIED", {
      metadata: { uid: "p2", name: "worker", namespace: "default" },
      spec: { containers: [{ image: "worker:1" }] },
      status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
    });
    backend.podWatches[0]?.emit("DELETED", { metadata: { uid: "p1" } });
    expect(batches).toHaveLength(1);
    clock.flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]?.pods?.upsert).toEqual([
      expect.objectContaining({ uid: "p2", status: "Running" }),
    ]);
    expect(batches[1]?.pods?.delete).toEqual(["p1"]);
  });

  it("restarts only the pod watch when the namespace changes", async () => {
    const { app, backend, clock } = await start();
    await app.connect("prod");
    clock.flush();
    const nodeWatch = backend.nodeWatches[0];
    await app.setNamespace("kube-system");
    expect(backend.podLists.at(-1)).toBe("kube-system");
    expect(backend.podWatches).toHaveLength(2);
    expect(backend.podWatches[0]?.stopped).toBe(true);
    expect(nodeWatch?.stopped).toBe(false);
    expect(backend.nodeWatches).toHaveLength(1);
  });

  it("sends a reset batch after a 410 and leaves the node watch running", async () => {
    const { app, backend, clock, batches } = await start();
    await app.connect("prod");
    clock.flush();
    backend.pods = { resourceVersion: "2", rows: [podRow("p9", "fresh")] };
    backend.podWatches[0]?.fail(410, "expired");
    await settle();
    clock.flush();
    await settle();
    clock.flush();
    const resets = batches.filter((batch) => batch.pods?.reset);
    expect(resets.length).toBeGreaterThan(1);
    expect(resets.at(-1)?.pods?.upsert.map((row) => row.uid)).toEqual(["p9"]);
    expect(backend.nodeWatches).toHaveLength(1);
    expect(backend.nodeWatches[0]?.stopped).toBe(false);
  });

  it("aborts watches on disconnect and ignores a connect that finishes later", async () => {
    const { app, backend, clock, batches } = await start();
    let release: ((value: Listed<PodRow>) => void) | undefined;
    backend.podGate = new Promise((resolve) => {
      release = resolve;
    });
    const connecting = app.connect("prod");
    await settle();
    expect(backend.podLists).toHaveLength(1);
    await app.disconnect();
    release?.({ resourceVersion: "9", rows: [podRow("late")] });
    await connecting;
    clock.flush();
    expect(batches).toEqual([]);
    expect(backend.podWatches.every((watch) => watch.stopped)).toBe(true);
  });

  it("stays connected when the API returns 403", async () => {
    const { app, backend, sessions } = await start();
    backend.podError = Object.assign(new Error("pods is forbidden"), { code: 403 });
    await app.connect("prod");
    expect(sessions.at(-1)?.state).toBe("connected");
    // One forbidden kind is reported against that kind, not as a banner over the whole app.
    expect(sessions.at(-1)?.problem).toBeNull();
    expect(sessions.at(-1)?.forbidden.Pod).toMatch(/cannot list resources/);
    expect(sessions.at(-1)?.forbidden.Pod).toMatch(/https:\/\/prod\.example:6443/);
  });

  it("starts production-looking contexts protected", () => {
    expect(defaultGuard("prod")).toEqual({ protected: true, readOnly: false });
    expect(defaultGuard("eks-prd-eu")).toEqual({ protected: true, readOnly: false });
    expect(defaultGuard("product-dev")).toEqual({ protected: false, readOnly: false });
    expect(defaultGuard("staging")).toEqual({ protected: false, readOnly: false });
  });

  it("refuses writes on a read-only context but still reads", async () => {
    const { app, backend } = await start();
    await app.connect("prod");
    await app.setGuard("prod", { protected: true, readOnly: true });
    await expect(app.runCommand({ name: "delete", kind: "Pod", resourceName: "api", namespace: "default" })).rejects.toThrow(/read-only/);
    await expect(app.runCommand({ name: "scale", kind: "Deployment", resourceName: "api", namespace: "default", replicas: 0 })).rejects.toThrow(/read-only/);
    await expect(app.applyYaml({ base: "a", draft: "b" })).rejects.toThrow(/read-only/);
    await expect(app.startDebug({ namespace: "default", pod: "api", target: "app", image: "busybox" })).rejects.toThrow(/read-only/);
    await expect(app.runCommand({ name: "describe", kind: "Pod", resourceName: "api", namespace: "default" })).resolves.toBeTruthy();
    await app.applyYaml({ base: "a", draft: "b", dryRun: true });
    expect(backend.applied).toEqual([{ base: "a", draft: "b", dryRun: true }]);
    await app.setGuard("prod", { protected: true, readOnly: false });
    await expect(app.runCommand({ name: "delete", kind: "Pod", resourceName: "api", namespace: "default" })).resolves.toBeTruthy();
  });
});
