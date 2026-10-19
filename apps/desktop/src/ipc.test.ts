import { describe, expect, it, vi } from "vitest";
import type { ClusterClient, CommandRequest, ResourceRef, RowBatch, Session } from "@podgaze/contracts";
import { createPreloadClient, registerClusterIpc, type IpcMainLike, type IpcRendererLike, type WebContentsLike } from "./ipc.js";

function linked() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
  const webContents: WebContentsLike = {
    send(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
  const ipcRenderer: IpcRendererLike = {
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return Promise.resolve(handler({}, ...args));
    },
    on(channel, listener) {
      const group = listeners.get(channel) ?? new Set();
      group.add(listener);
      listeners.set(channel, group);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
  return { ipcMain, ipcRenderer, webContents };
}

describe("desktop bridge", () => {
  it("forwards every client method and pushes session and row events", async () => {
    const session: Session = {
      state: "connected",
      clusterId: "prod",
      namespace: null,
      kubeconfigPath: "/tmp/config",
      problem: null,
      namespaces: ["default"],
      guard: { protected: true, readOnly: false },
      forbidden: {},
    };
    const batch: RowBatch = { pods: { reset: true, upsert: [], delete: [] } };
    const ref: ResourceRef = { kind: "Pod", namespace: "default", name: "api" };
    let emitSession: (value: Session) => void = () => undefined;
    let emitRows: (value: RowBatch) => void = () => undefined;
    const core: ClusterClient = {
      listClusters: vi.fn(async () => []),
      pickKubeconfig: vi.fn(async () => "/tmp/config"),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      setNamespace: vi.fn(async () => undefined),
      getYaml: vi.fn(async () => "kind: Pod\n"),
      runCommand: vi.fn(async () => ({ title: "Describe", command: "kubectl describe pod api", output: "Name: api\n" })),
      setFocus: vi.fn(async () => undefined),
      listCounts: vi.fn(async () => ({ Service: 2 })),
      getLogs: vi.fn(async () => ({ filename: "api.log", text: "listening\n" })),
      followLogs: vi.fn(async () => ({ id: "log-1" })),
      stopFollow: vi.fn(async () => undefined),
      onLogs() {
        return () => undefined;
      },
      applyYaml: vi.fn(async () => ({ applied: true, live: "kind: Pod\n", yaml: "kind: Pod\n", message: "Live manifest updated.", conflicts: [] })),
      listRelated: vi.fn(async () => [{ kind: "Node" as const, namespace: null, name: "n1", relation: "Node" }]),
      listEvents: vi.fn(async () => []),
      listWarnings: vi.fn(async () => []),
      checkAccess: vi.fn(async () => ({ delete: false })),
      getGuards: vi.fn(async () => ({ prod: { protected: true, readOnly: true } })),
      describeContext: vi.fn(async () => ({ id: "prod", file: "/tmp/config", current: true, cluster: "c", user: "u", server: "https://x", namespace: null, auth: "Bearer token", certExpires: null, skipTLSVerify: false, ca: "Embedded", sharedWith: [], yaml: "" })),
      updateContext: vi.fn(async () => ({ name: "prod-eu", file: "/tmp/config", backup: "/tmp/config.bak" })),
      removeContext: vi.fn(async () => ({ file: "/tmp/config", backup: "/tmp/config.bak", removed: ["context prod"] })),
      setGuard: vi.fn(async () => undefined),
      startDebug: vi.fn(async () => ({ container: "debugger-1" })),
      listExecTargets: vi.fn(async () => []),
      readSecret: vi.fn(async () => ({ type: "Opaque", values: [] })),
      openPortForward: vi.fn(async () => ({ id: "pf", namespace: "default", kind: "Pod" as const, pod: "api", remotePort: 8080, localPort: 18080 })),
      closePortForward: vi.fn(async () => undefined),
      listPortForwards: vi.fn(async () => []),
      readUsage: vi.fn(async () => ({ available: false, nodes: [], pods: [] })),
      createYaml: vi.fn(async () => ({ created: [], dryRun: true, message: "ok" })),
      listHelmReleases: vi.fn(async () => []),
      getHelmRelease: vi.fn(async () => { throw new Error("none"); }),
      helmAction: vi.fn(async () => ({ title: "Rollback", command: "helm rollback api", output: "" })),
      listAudit: vi.fn(async () => []),
      whoCan: vi.fn(async () => []),
      myRules: vi.fn(async () => []),
      closeCluster: vi.fn(async () => undefined),
      helmRepos: vi.fn(async () => []),
      helmAddRepo: vi.fn(async () => undefined),
      helmSearch: vi.fn(async () => []),
      helmChartValues: vi.fn(async () => ""),
      helmInstall: vi.fn(async () => ({ title: "Install", command: "helm install", output: "" })),
      getMap: vi.fn(async () => ({ nodes: [], edges: [], truncated: false })),
      listArgoApps: vi.fn(async () => []),
      argoAction: vi.fn(async () => ({ title: "Sync", command: "argocd app sync api", output: "" })),
      hubSearch: vi.fn(async () => []),
      startNodeShell: vi.fn(async () => ({ namespace: "kube-system", pod: "podgaze-node-shell-a", container: "shell", command: ["nsenter"] })),
      stopNodeShell: vi.fn(async () => undefined),
      writeSecret: vi.fn(async () => ({ type: "Opaque", values: [] })),
      findWorkloads: vi.fn(async () => []),
      getYamlIn: vi.fn(async () => "kind: Deployment\n"),
      listImagesIn: vi.fn(async () => []),
      listCertificates: vi.fn(async () => []),
      listVolumes: vi.fn(async () => ({ volumes: [], classes: [] })),
      updateState: vi.fn(async () => ({ status: "idle" as const, current: "0.1.1", canInstall: false, automatic: true })),
      checkForUpdates: vi.fn(async () => ({ status: "none" as const, current: "0.1.1", canInstall: false, automatic: true })),
      installUpdate: vi.fn(async () => undefined),
      setAutomaticUpdates: vi.fn(async (enabled: boolean) => ({ status: "idle" as const, current: "0.1.1", canInstall: false, automatic: enabled })),
      onUpdate: () => () => undefined,
      searchLogs: vi.fn(async () => ({ matches: [], pods: 0, containers: 0, lines: 0, truncated: false, problems: [] })),
      lookupPrices: vi.fn(async () => ([])),
      getTimeline: vi.fn(async () => ({ entries: [], eventsSince: null })),
      onAlert: () => () => undefined,
      onAlertOpen: () => () => undefined,
      setNotifications: vi.fn(async () => undefined),
      cloudAccounts: vi.fn(async () => []),
      cloudDefaultRegion: vi.fn(async () => ""),
      cloudClusters: vi.fn(async () => []),
      cloudAddCluster: vi.fn(async () => ({ context: "aks", message: "ok" })),
      openTerminal: vi.fn(async () => ({ id: "term" })),
      writeTerminal: vi.fn(async () => undefined),
      resizeTerminal: vi.fn(async () => undefined),
      closeTerminal: vi.fn(async () => undefined),
      onTerminal() {
        return () => undefined;
      },
      onSession(listener) {
        emitSession = listener;
        return () => undefined;
      },
      subscribeRows(listener) {
        emitRows = listener;
        return () => undefined;
      },
    };
    const { ipcMain, ipcRenderer, webContents } = linked();
    registerClusterIpc(ipcMain, core, webContents);
    const api = createPreloadClient(ipcRenderer);

    await expect(api.listClusters()).resolves.toEqual([]);
    await expect(api.pickKubeconfig()).resolves.toBe("/tmp/config");
    await api.connect("prod");
    await api.disconnect();
    await api.setNamespace("kube-system");
    const request: CommandRequest = { name: "describe", kind: "Pod", resourceName: "api", namespace: "default" };
    await expect(api.getYaml(ref)).resolves.toBe("kind: Pod\n");
    await expect(api.runCommand(request)).resolves.toMatchObject({ command: "kubectl describe pod api" });
    await api.setFocus("Service");
    await expect(api.listCounts()).resolves.toEqual({ Service: 2 });
    await expect(api.readSecret("default", "db")).resolves.toEqual({ type: "Opaque", values: [] });
    await expect(api.openPortForward({ namespace: "default", pod: "api", remotePort: 8080 })).resolves.toMatchObject({ localPort: 18080 });
    await expect(api.readUsage()).resolves.toEqual({ available: false, nodes: [], pods: [] });
    await expect(api.createYaml({ yaml: "kind: ConfigMap", dryRun: true })).resolves.toMatchObject({ dryRun: true });
    await api.closeCluster("staging");
    expect(core.closeCluster).toHaveBeenCalledWith("staging");
    await api.whoCan({ verb: "get", resource: "pods", group: "", namespace: null });
    expect(core.whoCan).toHaveBeenCalled();
    await api.closePortForward("pf");
    await expect(api.getLogs({ namespace: "default", pod: "api", containers: ["api"] })).resolves.toMatchObject({ filename: "api.log" });
    await expect(api.followLogs({ namespace: "default", pod: "api", container: "api" })).resolves.toEqual({ id: "log-1" });
    await api.stopFollow("log-1");
    await api.openTerminal({ mode: "shell" });
    await api.writeTerminal("term", "ls\n");
    await api.closeTerminal("term");
    await expect(api.applyYaml({ base: "a", draft: "b", dryRun: true })).resolves.toMatchObject({ applied: true });
    await expect(api.listRelated(ref)).resolves.toEqual([{ kind: "Node", namespace: null, name: "n1", relation: "Node" }]);
    await expect(api.listEvents(ref)).resolves.toEqual([]);
    await expect(api.listWarnings()).resolves.toEqual([]);
    await expect(api.checkAccess(ref)).resolves.toEqual({ delete: false });
    await expect(api.getGuards()).resolves.toEqual({ prod: { protected: true, readOnly: true } });
    await api.setGuard("prod", { protected: false, readOnly: false });
    await expect(api.describeContext("prod")).resolves.toMatchObject({ auth: "Bearer token" });
    await expect(api.updateContext("prod", { name: "prod-eu" })).resolves.toMatchObject({ name: "prod-eu" });
    expect(core.updateContext).toHaveBeenCalledWith("prod", { name: "prod-eu" });
    await expect(api.startDebug({ namespace: "default", pod: "api", target: "api", image: "busybox" })).resolves.toEqual({ container: "debugger-1" });

    expect(core.connect).toHaveBeenCalledWith("prod");
    expect(core.disconnect).toHaveBeenCalled();
    expect(core.setNamespace).toHaveBeenCalledWith("kube-system");
    expect(core.getYaml).toHaveBeenCalledWith(ref);
    expect(core.runCommand).toHaveBeenCalledWith(request);
    expect(core.setFocus).toHaveBeenCalledWith("Service");
    expect(core.listCounts).toHaveBeenCalled();
    expect(core.readSecret).toHaveBeenCalledWith("default", "db");
    expect(core.openPortForward).toHaveBeenCalledWith({ namespace: "default", pod: "api", remotePort: 8080 });
    expect(core.closePortForward).toHaveBeenCalledWith("pf");
    expect(core.openTerminal).toHaveBeenCalledWith({ mode: "shell" });
    expect(core.writeTerminal).toHaveBeenCalledWith("term", "ls\n");
    expect(core.closeTerminal).toHaveBeenCalledWith("term");
    expect(core.followLogs).toHaveBeenCalledWith({ namespace: "default", pod: "api", container: "api" });
    expect(core.stopFollow).toHaveBeenCalledWith("log-1");
    expect(core.applyYaml).toHaveBeenCalledWith({ base: "a", draft: "b", dryRun: true });
    expect(core.setGuard).toHaveBeenCalledWith("prod", { protected: false, readOnly: false });

    const seenSessions: Session[] = [];
    const seenRows: RowBatch[] = [];
    const stopSession = api.onSession((value) => seenSessions.push(value));
    const stopRows = api.subscribeRows((value) => seenRows.push(value));
    emitSession(session);
    emitRows(batch);
    stopSession();
    stopRows();
    emitSession(session);
    emitRows(batch);
    expect(seenSessions).toEqual([session]);
    expect(seenRows).toEqual([batch]);
  });
});
