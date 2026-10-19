import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell, type Rectangle } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AuditEntry, ClusterAlert, ClusterClient, ContextGuard, LogEvent, NodeShell, TerminalEvent, UpdateState } from "@podgaze/contracts";
import { createCloud, createPriceLookup, createClusterApp, createClusterHub, createKubeBackend, createRunner, defaultKubeconfigPath, type AuditStore, type GuardStore } from "@podgaze/cluster";
import { registerClusterIpc, type IpcMainLike } from "./ipc.js";
import { appUrlCheck, fromAppFrame } from "./security.js";
import { createOwners } from "./owners.js";
import { createUpdates } from "./updates.js";
import electronUpdater from "electron-updater";
import { createPortForwardHost } from "./forward.js";
import { createLogHost } from "./logs.js";
import { createTerminalHost } from "./terminal.js";

const onWsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
if (onWsl) {
  // WSLg's GPU process exits on startup, then maximize stops painting and drops clicks.
  app.commandLine.appendSwitch("ozone-platform", "x11");
  app.disableHardwareAcceleration();
}

const dir = path.dirname(fileURLToPath(import.meta.url));

// The page Podgaze loads, and the only page allowed to use its bridge. A packaged app never loads a dev server,
// even if PODGAZE_DEV_SERVER is set in the environment.
const devServer = !app.isPackaged && process.env.PODGAZE_DEV_SERVER ? process.env.PODGAZE_DEV_SERVER : null;
const rendererRoot = devServer ? new URL(devServer).origin : pathToFileURL(path.join(dir, "../renderer/")).href;

const isAppUrl = appUrlCheck(rendererRoot, Boolean(devServer));
const fromApp = (event: unknown) => fromAppFrame(event, isAppUrl);

const guardedIpc: IpcMainLike = {
  handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromApp(event)) throw new Error("Refused: this request did not come from the Podgaze window.");
      return listener(event, ...args);
    });
  },
};

// Cloud logins (aws, gke-gcloud-auth-plugin, kubelogin) run from PATH. An app opened from the dock or a
// launcher gets a bare PATH, so add the usual install folders and, when there is no terminal, the login shell's PATH.
function addToPath(dirs: string[]) {
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const item of dirs) {
    if (item && !parts.includes(item) && fs.existsSync(item)) parts.push(item);
  }
  process.env.PATH = parts.join(path.delimiter);
}

function widenPath() {
  if (process.platform === "win32") return;
  const home = os.homedir();
  addToPath(["/usr/local/bin", "/opt/homebrew/bin", "/snap/bin", path.join(home, ".local", "bin"), path.join(home, "google-cloud-sdk", "bin"), path.join(home, ".krew", "bin")]);
  if (process.stdout.isTTY) return;
  const loginShell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const marker = "__PODGAZE_PATH__";
  execFile(loginShell, ["-ilc", `printf '${marker}%s' "$PATH"`], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
    if (error || !stdout.includes(marker)) return;
    addToPath(stdout.slice(stdout.lastIndexOf(marker) + marker.length).trim().split(path.delimiter));
  });
}

widenPath();

function guardFile(): GuardStore {
  const file = path.join(app.getPath("userData"), "guards.json");
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, ContextGuard>;
      } catch {
        return {};
      }
    },
    save(guards) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(guards, null, 2));
    },
  };
}

// One JSON line per change, newest last; the window reads the latest 1000.
function auditFile(): AuditStore {
  const file = path.join(app.getPath("userData"), "activity.jsonl");
  let cache: AuditEntry[] | null = null;
  function read(): AuditEntry[] {
    if (cache) return cache;
    try {
      cache = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-1000).map((line) => JSON.parse(line) as AuditEntry).reverse();
    } catch {
      cache = [];
    }
    return cache;
  }
  return {
    append(entry) {
      cache = [entry, ...read()].slice(0, 1000);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      } catch {
        // History stays in memory for this run.
      }
    },
    list: () => read().slice(),
  };
}

const guards = guardFile();
const audit = auditFile();
const core = createClusterHub({
  cloud: createCloud(createRunner(execFile)),
  prices: createPriceLookup((url) => fetch(url)),
  // get-credentials writes to the first file kubectl reads.
  kubeconfigFile: () => defaultKubeconfigPath().split(path.delimiter)[0]!,
  makeApp: () => createClusterApp({
    backendFor: (filePath, contextName) => createKubeBackend(filePath, contextName),
    guards,
    audit,
  }),
  // Also runs when the oldest tab is dropped at the tab limit, not only when the user closes one.
  beforeTabClose: (clusterId) => stopEverythingOf(clusterId),
});

// A cluster's forwards, followed logs, pod shells, and node-shell pods keep using its credentials until stopped.
async function stopEverythingOf(clusterId: string) {
  const owned = owners.takeAll(clusterId);
  await Promise.all(owned.forwards.map((id) => forwards.close(id)));
  await Promise.all(owned.logs.map((id) => logs.close(id)));
  for (const id of owned.terminals) terminals.close(id);
  for (const [key, entry] of nodeShells) {
    if (entry.cluster !== clusterId) continue;
    nodeShells.delete(key);
    await core.stopNodeShellIn(clusterId, entry.shell.namespace, entry.shell.pod).catch(() => undefined);
  }
}

// Records what an open belongs to: the cluster that was on screen when it started. If that cluster's tab closed
// while it was opening, it is stopped right away instead of running on unowned.
async function owned<T extends { id: string }>(kind: "logs" | "forwards" | "terminals", open: () => Promise<T>, stop: (id: string) => unknown): Promise<T> {
  const cluster = liveKube()?.context;
  const opened = await open();
  if (cluster && !core.isOpen(cluster)) {
    await stop(opened.id);
    throw new Error(`${cluster} was closed while this was opening.`);
  }
  owners.remember(kind, opened.id, cluster);
  return opened;
}

let attached = false;
// Node shell pods started this run, with their cluster: only these may run the node-shell command or be deleted
// by stopNodeShell, and the delete goes to their own cluster even after a tab switch.
const nodeShells = new Map<string, { shell: NodeShell; cluster: string | undefined }>();
let notificationsOn = true;
const alertOpenListeners = new Set<(alert: ClusterAlert) => void>();
let mainWindow: BrowserWindow | null = null;

// A failing pod or degraded Argo CD app in any open cluster, as an OS notification; clicking it opens the object.
core.onAlert((alert) => {
  if (!notificationsOn || !Notification.isSupported()) return;
  const what = alert.kind === "applications.argoproj.io" ? "Argo CD app" : alert.kind;
  const note = new Notification({
    title: `${alert.reason} · ${alert.clusterId}`,
    body: `${what} ${alert.namespace ? `${alert.namespace}/` : ""}${alert.name}${alert.message ? `\n${alert.message}` : ""}`,
    silent: false,
  });
  note.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    for (const listener of alertOpenListeners) listener(alert);
  });
  note.show();
});
const terminalListeners = new Set<(event: TerminalEvent) => void>();
const logListeners = new Set<(event: LogEvent) => void>();
function liveKube() {
  const live = core.activeSession();
  if (!live?.kubeconfigPath || !live.clusterId || live.state === "disconnected") return null;
  return { path: live.kubeconfigPath, context: live.clusterId };
}

const forwards = createPortForwardHost({
  kubeconfig: liveKube,
});

const logs = createLogHost({
  kubeconfig: liveKube,
  emit(event) {
    for (const listener of logListeners) listener(event);
  },
});
const owners = createOwners();

const updateListeners = new Set<(state: UpdateState) => void>();
const updates = createUpdates({
  updater: electronUpdater.autoUpdater,
  packaged: app.isPackaged,
  platform: process.platform,
  appImage: process.env.APPIMAGE,
  current: app.getVersion(),
  settingsFile: path.join(app.getPath("userData"), "updates.json"),
  releasePage: (version) => `https://github.com/vahe17s/podgaze/releases/tag/v${version}`,
  emit: (state) => {
    for (const listener of updateListeners) listener(state);
  },
});

const terminals = createTerminalHost({
  kubeconfig: liveKube,
  emit(event) {
    for (const listener of terminalListeners) listener(event);
  },
});

function createWindow() {
  const win = new BrowserWindow({
    show: !smokeTest,
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0d1117",
    title: "Podgaze",
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  // Shells and log streams belong to the page that opened them: a closed window (macOS keeps the app running)
  // or a reloaded page can never reattach to them, so stop them. Port forwards stay; the page lists them again.
  const dropPageSessions = () => {
    owners.clearKind("logs");
    owners.clearKind("terminals");
    logs.closeAll();
    terminals.closeAll();
  };
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    dropPageSessions();
  });
  let loadedOnce = false;
  win.webContents.on("did-start-loading", () => {
    if (loadedOnce) dropPageSessions();
    loadedOnce = true;
  });
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1);
  });
  // The window only ever shows Podgaze. A dropped link or file must not replace it, since the bridge (terminals,
  // Secrets, kubeconfig edits) is attached to whatever page is loaded.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Port forwards and Ingress hosts open in the system browser; nothing opens inside the app.
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (!attached) {
    attached = true;
    const client: ClusterClient = {
      listClusters: () => core.listClusters(),
      connect: (clusterId) => core.connect(clusterId),
      setNamespace: (namespace) => core.setNamespace(namespace),
      subscribeRows: (listener) => core.subscribeRows(listener),
      getYaml: (ref) => core.getYaml(ref),
      runCommand: (request) => core.runCommand(request),
      setFocus: (kind) => core.setFocus(kind),
      listCounts: () => core.listCounts(),
      getLogs: (request) => core.getLogs(request),
      followLogs: (request) => owned("logs", () => logs.open(request), (id) => logs.close(id)),
      stopFollow: async (id) => {
        owners.forget("logs", id);
        await logs.close(id);
      },
      onLogs(listener) {
        logListeners.add(listener);
        return () => logListeners.delete(listener);
      },
      applyYaml: (request) => core.applyYaml(request),
      listRelated: (ref) => core.listRelated(ref),
      listEvents: (ref) => core.listEvents(ref),
      listWarnings: () => core.listWarnings(),
      checkAccess: (ref) => core.checkAccess(ref),
      getGuards: () => core.getGuards(),
      describeContext: (clusterId) => core.describeContext(clusterId),
      updateContext: (clusterId, edit) => core.updateContext(clusterId, edit),
      removeContext: (clusterId) => core.removeContext(clusterId),
      setGuard: (clusterId, guard) => core.setGuard(clusterId, guard),
      startDebug: (request) => core.startDebug(request),
      listExecTargets: (ref) => core.listExecTargets(ref),
      readSecret: (namespace, name) => core.readSecret(namespace, name),
      writeSecret: (request) => core.writeSecret(request),
      findWorkloads: (clusterId, needle) => core.findWorkloadsIn(clusterId, needle),
      getYamlIn: (clusterId, ref) => core.getYamlIn(clusterId, ref),
      listImagesIn: (clusterId) => core.listImagesIn(clusterId),
      listCertificates: () => core.listCertificates(),
      listVolumes: () => core.listVolumes(),
      updateState: async () => updates.state(),
      checkForUpdates: () => updates.check(),
      installUpdate: async () => updates.install(),
      setAutomaticUpdates: async (enabled) => updates.setAutomatic(enabled),
      onUpdate(listener) {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
      searchLogs: (request) => core.searchLogs(request),
      lookupPrices: (requests) => core.lookupPrices(requests),
      getTimeline: (ref) => core.getTimeline(ref),
      onAlert: (listener) => core.onAlert(listener),
      onAlertOpen(listener) {
        alertOpenListeners.add(listener);
        return () => alertOpenListeners.delete(listener);
      },
      async setNotifications(enabled) {
        notificationsOn = enabled;
      },
      cloudAccounts: (provider) => core.cloudAccounts(provider),
      cloudDefaultRegion: (accountId) => core.cloudDefaultRegion(accountId),
      cloudClusters: (provider, accountId, region) => core.cloudClusters(provider, accountId, region),
      cloudAddCluster: (request) => core.cloudAddCluster(request),
      openPortForward: (request) => owned("forwards", () => forwards.open(request), (id) => forwards.close(id)),
      closePortForward: async (id) => {
        owners.forget("forwards", id);
        await forwards.close(id);
      },
      listPortForwards: async () => forwards.list(),
      readUsage: () => core.readUsage(),
      openTerminal: async (request) => {
        // Exec can change anything inside a container, so a read-only context refuses it like any other write.
        if (request.mode === "exec" && request.command) {
          // A node shell: only a pod Podgaze started this run, with exactly the command it was started for.
          const started = nodeShells.get(`${request.namespace}/${request.pod}`)?.shell;
          if (!started || JSON.stringify(started.command) !== JSON.stringify(request.command) || started.container !== request.container) {
            throw new Error("Custom exec commands are only used for node shells Podgaze started.");
          }
          core.assertWritable(null);
        } else if (request.mode === "exec") {
          core.assertWritable(request.namespace);
          core.record({ action: "exec", target: `pod/${request.pod}`, namespace: request.namespace, kubectl: `kubectl exec -it ${request.pod} -n ${request.namespace} -c ${request.container} -- sh`, ok: true });
        }
        // Pod shells belong to the cluster; the local shell belongs to no cluster and stays open.
        if (request.mode !== "exec") return terminals.open(request);
        return owned("terminals", () => terminals.open(request), (id) => terminals.close(id));
      },
      writeTerminal: async (id, data) => terminals.write(id, data),
      resizeTerminal: async (id, cols, rows) => terminals.resize(id, cols, rows),
      closeTerminal: async (id) => {
        owners.forget("terminals", id);
        terminals.close(id);
      },
      onTerminal(listener) {
        terminalListeners.add(listener);
        return () => terminalListeners.delete(listener);
      },
      onSession: (listener) => core.onSession(listener),
      createYaml: (request) => core.createYaml(request),
      listHelmReleases: () => core.listHelmReleases(),
      getHelmRelease: (namespace, name) => core.getHelmRelease(namespace, name),
      helmAction: (request) => core.helmAction(request),
      helmRepos: () => core.helmRepos(),
      helmAddRepo: (repo) => core.helmAddRepo(repo),
      helmSearch: (term) => core.helmSearch(term),
      helmChartValues: (chart, version) => core.helmChartValues(chart, version),
      helmInstall: (request) => core.helmInstall(request),
      getMap: (scope) => core.getMap(scope),
      listArgoApps: () => core.listArgoApps(),
      argoAction: (request) => core.argoAction(request),
      hubSearch: (term) => core.hubSearch(term),
      startNodeShell: async (node) => {
        const cluster = liveKube()?.context;
        const shell = await core.startNodeShell(node);
        nodeShells.set(`${shell.namespace}/${shell.pod}`, { shell, cluster });
        return shell;
      },
      stopNodeShell: async (namespace, pod) => {
        const entry = nodeShells.get(`${namespace}/${pod}`);
        if (!entry) throw new Error("Only node shells Podgaze started can be stopped this way.");
        nodeShells.delete(`${namespace}/${pod}`);
        // Its own cluster, not whichever is on screen now (the panel unmounts after a tab switch).
        if (entry.cluster) await core.stopNodeShellIn(entry.cluster, namespace, pod);
        else await core.stopNodeShell(namespace, pod);
      },
      listAudit: () => core.listAudit(),
      whoCan: (request) => core.whoCan(request),
      myRules: (namespace) => core.myRules(namespace),
      // The hub runs stopEverythingOf(clusterId) before the tab closes.
      closeCluster: (clusterId) => core.closeCluster(clusterId),
      async disconnect() {
        owners.clear();
        logs.closeAll();
        terminals.closeExec();
        forwards.closeAll();
        await core.disconnect();
      },
      async pickKubeconfig() {
        const options = { title: "Choose kubeconfig", properties: ["openFile" as const] };
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
        const picked = result.filePaths[0];
        if (result.canceled || !picked) return null;
        core.setKubeconfigPath(picked);
        return picked;
      },
    };
    // Events go to whichever window is open now: on macOS the app outlives its window, and the dock reopens a new one.
    registerClusterIpc(guardedIpc, client, {
      send(channel, payload) {
        const target = mainWindow;
        if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send(channel, payload);
      },
    }, () => core.resend());
  }

  if (devServer) {
    void win.loadURL(devServer);
  } else {
    void win.loadFile(path.join(dir, "../renderer/index.html"));
  }
}

const restoreBounds = new WeakMap<BrowserWindow, Rectangle>();

function toggleMaximize(target: BrowserWindow) {
  if (!onWsl) {
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    return;
  }
  const previous = restoreBounds.get(target);
  if (previous || target.isMaximized()) {
    restoreBounds.delete(target);
    if (target.isMaximized()) target.unmaximize();
    if (previous) target.setBounds(previous);
    return;
  }
  const current = target.getBounds();
  restoreBounds.set(target, current);
  target.setBounds(screen.getDisplayMatching(current).workArea);
}

ipcMain.handle("podgaze:window", (event, action: string) => {
  if (!fromApp(event)) return;
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return;
  if (action === "minimize") target.minimize();
  if (action === "maximize") toggleMaximize(target);
  if (action === "close") target.close();
});

// Started from a menu, dock, or file manager, the app does not get the PATH a terminal has, so kubeconfig exec
// plugins (kubelogin, aws, gke-gcloud-auth-plugin) and the az/aws/gcloud CLIs would not be found. Ask the
// user's login shell once, the way terminals do.
async function adoptLoginShellEnvironment(): Promise<void> {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const marker = "__PODGAZE_ENV__";
  const output = await new Promise<string>((resolve) => {
    execFile(shell, ["-ilc", `printf '${marker}%s${marker}%s${marker}' "$PATH" "$KUBECONFIG"`], { timeout: 5000 }, (_error, stdout) => resolve(String(stdout ?? "")));
  });
  const [, shellPath, kubeconfig] = output.split(marker);
  if (shellPath) process.env.PATH = [...new Set([...shellPath.split(":"), ...(process.env.PATH ?? "").split(":")])].filter(Boolean).join(":");
  if (kubeconfig && !process.env.KUBECONFIG) process.env.KUBECONFIG = kubeconfig;
}

// PODGAZE_SMOKE_TEST=1: start hidden, check that the page loads with its bridge and that the kubeconfig can be
// read, print the result, and exit. Used to test installers without anyone at the screen.
const smokeTest = process.env.PODGAZE_SMOKE_TEST === "1";

function runSmokeTest() {
  const fail = (reason: string) => {
    console.log(`PODGAZE_SMOKE_FAIL ${reason}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail("timed out after 45s"), 45_000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return fail("no window");
  win.webContents.once("did-fail-load", (_event, code, description) => fail(`page did not load: ${code} ${description}`));
  win.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        const bridge = await win.webContents.executeJavaScript("typeof window.podgaze === 'object'");
        if (!bridge) return fail("bridge missing in the page");
        const clusters = await core.listClusters();
        // Optional: connect, reload the page, and check it comes back connected (a reloaded or reopened window
        // must get the current session and rows, not the start screen).
        const context = process.env.PODGAZE_SMOKE_CONNECT;
        if (context) {
          await core.connect(context);
          await new Promise<void>((resolve) => {
            win.webContents.once("did-finish-load", () => resolve());
            win.webContents.reload();
          });
          await new Promise((resolve) => setTimeout(resolve, 4000));
          const connected = await win.webContents.executeJavaScript("document.querySelectorAll('.nav-item').length > 5");
          await core.disconnect();
          if (!connected) return fail("the reloaded page did not get the connected session back");
        }
        // The native pty library behind the Windows terminal: loads, and runs a command through a pseudo terminal.
        const ptyCheck = await new Promise<string>((resolve) => {
          try {
            const pty = createRequire(import.meta.url)("@lydell/node-pty") as { spawn: (file: string, args: string[], options: object) => { onData: (fn: (data: string) => void) => void; onExit: (fn: () => void) => void } };
            const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "echo pty-ok"]] : ["/bin/sh", ["-c", "echo pty-ok"]];
            const term = pty.spawn(file, args as string[], { name: "xterm", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
            let seen = "";
            term.onData((data) => (seen += data));
            term.onExit(() => resolve(seen.includes("pty-ok") ? "ok" : `no-output(${JSON.stringify(seen.slice(0, 80))})`));
            setTimeout(() => resolve("timeout"), 10_000);
          } catch (error) {
            resolve(`missing(${error instanceof Error ? error.message.split("\n")[0] : error})`);
          }
        });
        if (ptyCheck !== "ok") return fail(`native pty library: ${ptyCheck}`);
        // Optional: one real update check, to see the updater is wired (status and message are printed).
        let update = "";
        if (process.env.PODGAZE_SMOKE_UPDATE === "1") {
          const checked = await updates.check();
          update = ` update=${checked.status}${checked.message ? ` (${checked.message})` : ""}${checked.version ? ` latest=${checked.version}` : ""}`;
        }
        clearTimeout(timer);
        console.log(`PODGAZE_SMOKE_OK version=${app.getVersion()} clusters=${clusters.length} pty=ok${context ? " reload=ok" : ""}${update}`);
        app.exit(0);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();
  });
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (app.isPackaged) await adoptLoginShellEnvironment();
  createWindow();
  if (smokeTest) runSmokeTest();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
