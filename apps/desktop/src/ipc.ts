import type { UpdateState, VolumeReport, LogSearchResult, LogSearchRequest, PriceQuote, PriceRequest, Timeline, CloudAccount, CloudAddRequest, CloudCluster, CloudProvider, CertInfo, ClusterAlert, ResourceRow, WorkloadImages, SecretWrite, ArgoAction, ArgoApp, HubChart, MapScope, NodeShell, ResourceMap, HelmChart, HelmInstallRequest, HelmRepo, AccessRule, AuditEntry, CreateRequest, CreateResult, HelmActionRequest, HelmRelease, HelmReleaseDetail, WhoCanRequest, WhoCanSubject, ContextDetails, ContextEdit, ContextRemoved,
  ContextSaved, ClusterWarning, AccessMap, ApplyRequest, ApplyResult, ClusterClient, ClusterUsage, CommandRequest, ContextGuard, DebugRequest, ExecTarget, LogBundle, LogEvent, LogFollowRequest, LogRequest, ObjectEvent, PortForwardRequest, RelatedRef, ResourceKind, ResourceRef, RowBatch, SecretReveal, Session, TerminalEvent, TerminalRequest } from "@podgaze/contracts";

export const channels = {
  listClusters: "podgaze:listClusters",
  resend: "podgaze:resend",
  updateState: "podgaze:updateState",
  checkForUpdates: "podgaze:checkForUpdates",
  installUpdate: "podgaze:installUpdate",
  setAutomaticUpdates: "podgaze:setAutomaticUpdates",
  update: "podgaze:update",
  pickKubeconfig: "podgaze:pickKubeconfig",
  connect: "podgaze:connect",
  disconnect: "podgaze:disconnect",
  setNamespace: "podgaze:setNamespace",
  getYaml: "podgaze:getYaml",
  runCommand: "podgaze:runCommand",
  setFocus: "podgaze:setFocus",
  listCounts: "podgaze:listCounts",
  getLogs: "podgaze:getLogs",
  followLogs: "podgaze:followLogs",
  stopFollow: "podgaze:stopFollow",
  logs: "podgaze:logs",
  applyYaml: "podgaze:applyYaml",
  listRelated: "podgaze:listRelated",
  listEvents: "podgaze:listEvents",
  listWarnings: "podgaze:listWarnings",
  checkAccess: "podgaze:checkAccess",
  getGuards: "podgaze:getGuards",
  describeContext: "podgaze:describeContext",
  updateContext: "podgaze:updateContext",
  removeContext: "podgaze:removeContext",
  setGuard: "podgaze:setGuard",
  startDebug: "podgaze:startDebug",
  listExecTargets: "podgaze:listExecTargets",
  readSecret: "podgaze:readSecret",
  writeSecret: "podgaze:writeSecret",
  findWorkloads: "podgaze:findWorkloads",
  getYamlIn: "podgaze:getYamlIn",
  listImagesIn: "podgaze:listImagesIn",
  listCertificates: "podgaze:listCertificates",
  listVolumes: "podgaze:listVolumes",
  searchLogs: "podgaze:searchLogs",
  lookupPrices: "podgaze:lookupPrices",
  getTimeline: "podgaze:getTimeline",
  setNotifications: "podgaze:setNotifications",
  cloudAccounts: "podgaze:cloudAccounts",
  cloudDefaultRegion: "podgaze:cloudDefaultRegion",
  cloudClusters: "podgaze:cloudClusters",
  cloudAddCluster: "podgaze:cloudAddCluster",
  alert: "podgaze:alert",
  alertOpen: "podgaze:alertOpen",
  portForwardOpen: "podgaze:portForwardOpen",
  portForwardClose: "podgaze:portForwardClose",
  portForwardList: "podgaze:portForwardList",
  readUsage: "podgaze:readUsage",
  terminalOpen: "podgaze:terminalOpen",
  terminalWrite: "podgaze:terminalWrite",
  terminalResize: "podgaze:terminalResize",
  terminalClose: "podgaze:terminalClose",
  terminal: "podgaze:terminal",
  createYaml: "podgaze:createYaml",
  listHelmReleases: "podgaze:listHelmReleases",
  getHelmRelease: "podgaze:getHelmRelease",
  helmAction: "podgaze:helmAction",
  helmRepos: "podgaze:helmRepos",
  helmAddRepo: "podgaze:helmAddRepo",
  helmSearch: "podgaze:helmSearch",
  helmChartValues: "podgaze:helmChartValues",
  helmInstall: "podgaze:helmInstall",
  getMap: "podgaze:getMap",
  listArgoApps: "podgaze:listArgoApps",
  argoAction: "podgaze:argoAction",
  hubSearch: "podgaze:hubSearch",
  startNodeShell: "podgaze:startNodeShell",
  stopNodeShell: "podgaze:stopNodeShell",
  listAudit: "podgaze:listAudit",
  whoCan: "podgaze:whoCan",
  myRules: "podgaze:myRules",
  closeCluster: "podgaze:closeCluster",
  session: "podgaze:session",
  rows: "podgaze:rows",
} as const;

export type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
};

export type WebContentsLike = {
  send(channel: string, payload: unknown): void;
};

export function registerClusterIpc(ipc: IpcMainLike, client: ClusterClient, webContents: WebContentsLike, resend: () => void = () => undefined) {
  ipc.handle(channels.resend, () => resend());
  ipc.handle(channels.updateState, () => client.updateState());
  ipc.handle(channels.checkForUpdates, () => client.checkForUpdates());
  ipc.handle(channels.installUpdate, () => client.installUpdate());
  ipc.handle(channels.setAutomaticUpdates, (_event, enabled) => client.setAutomaticUpdates(enabled === true));
  client.onUpdate((state) => webContents.send(channels.update, state));
  ipc.handle(channels.listClusters, () => client.listClusters());
  ipc.handle(channels.pickKubeconfig, () => client.pickKubeconfig());
  ipc.handle(channels.connect, (_event, clusterId) => client.connect(clusterId as string));
  ipc.handle(channels.disconnect, () => client.disconnect());
  ipc.handle(channels.setNamespace, (_event, namespace) => client.setNamespace(namespace as string | null));
  ipc.handle(channels.getYaml, (_event, ref) => client.getYaml(ref as ResourceRef));
  ipc.handle(channels.runCommand, (_event, request) => client.runCommand(request as CommandRequest));
  ipc.handle(channels.setFocus, (_event, kind) => client.setFocus(kind as ResourceKind));
  ipc.handle(channels.listCounts, () => client.listCounts());
  ipc.handle(channels.getLogs, (_event, request) => client.getLogs(request as LogRequest));
  ipc.handle(channels.followLogs, (_event, request) => client.followLogs(request as LogFollowRequest));
  ipc.handle(channels.stopFollow, (_event, id) => client.stopFollow(id as string));
  ipc.handle(channels.applyYaml, (_event, request) => client.applyYaml(request as ApplyRequest));
  ipc.handle(channels.listRelated, (_event, ref) => client.listRelated(ref as ResourceRef));
  ipc.handle(channels.listEvents, (_event, ref) => client.listEvents(ref as ResourceRef));
  ipc.handle(channels.listWarnings, () => client.listWarnings());
  ipc.handle(channels.checkAccess, (_event, ref) => client.checkAccess(ref as ResourceRef));
  ipc.handle(channels.getGuards, () => client.getGuards());
  ipc.handle(channels.describeContext, (_event, clusterId) => client.describeContext(clusterId as string));
  ipc.handle(channels.updateContext, (_event, clusterId, edit) => client.updateContext(clusterId as string, edit as ContextEdit));
  ipc.handle(channels.removeContext, (_event, clusterId) => client.removeContext(clusterId as string));
  ipc.handle(channels.setGuard, (_event, clusterId, guard) => client.setGuard(clusterId as string, guard as ContextGuard));
  ipc.handle(channels.startDebug, (_event, request) => client.startDebug(request as DebugRequest));
  ipc.handle(channels.listExecTargets, (_event, ref) => client.listExecTargets(ref as ResourceRef));
  ipc.handle(channels.readSecret, (_event, namespace, name) => client.readSecret(namespace as string, name as string));
  ipc.handle(channels.writeSecret, (_event, request) => client.writeSecret(request as SecretWrite));
  ipc.handle(channels.findWorkloads, (_event, clusterId, needle) => client.findWorkloads(clusterId as string, needle as string));
  ipc.handle(channels.getYamlIn, (_event, clusterId, ref) => client.getYamlIn(clusterId as string, ref as ResourceRef));
  ipc.handle(channels.listImagesIn, (_event, clusterId) => client.listImagesIn(clusterId as string));
  ipc.handle(channels.listCertificates, () => client.listCertificates());
  ipc.handle(channels.listVolumes, (_event) => client.listVolumes());
  ipc.handle(channels.searchLogs, (_event, request) => client.searchLogs(request as LogSearchRequest));
  ipc.handle(channels.lookupPrices, (_event, requests) => client.lookupPrices(requests as PriceRequest[]));
  ipc.handle(channels.getTimeline, (_event, ref) => client.getTimeline(ref as ResourceRef));
  ipc.handle(channels.setNotifications, (_event, enabled) => client.setNotifications(Boolean(enabled)));
  ipc.handle(channels.cloudAccounts, (_event, provider) => client.cloudAccounts(provider as CloudProvider));
  ipc.handle(channels.cloudDefaultRegion, (_event, accountId) => client.cloudDefaultRegion(accountId as string));
  ipc.handle(channels.cloudClusters, (_event, provider, accountId, region) => client.cloudClusters(provider as CloudProvider, accountId as string, region as string | undefined));
  ipc.handle(channels.cloudAddCluster, (_event, request) => client.cloudAddCluster(request as CloudAddRequest));
  client.onAlert((alert) => webContents.send(channels.alert, alert));
  client.onAlertOpen((alert) => webContents.send(channels.alertOpen, alert));
  ipc.handle(channels.portForwardOpen, (_event, request) => client.openPortForward(request as PortForwardRequest));
  ipc.handle(channels.portForwardClose, (_event, id) => client.closePortForward(id as string));
  ipc.handle(channels.portForwardList, () => client.listPortForwards());
  ipc.handle(channels.readUsage, () => client.readUsage());
  ipc.handle(channels.terminalOpen, (_event, request) => client.openTerminal(request as TerminalRequest));
  ipc.handle(channels.terminalWrite, (_event, id, data) => client.writeTerminal(id as string, data as string));
  ipc.handle(channels.terminalResize, (_event, id, cols, rows) => client.resizeTerminal(id as string, cols as number, rows as number));
  ipc.handle(channels.terminalClose, (_event, id) => client.closeTerminal(id as string));
  ipc.handle(channels.createYaml, (_event, request) => client.createYaml(request as CreateRequest));
  ipc.handle(channels.listHelmReleases, () => client.listHelmReleases());
  ipc.handle(channels.getHelmRelease, (_event, namespace, name) => client.getHelmRelease(namespace as string, name as string));
  ipc.handle(channels.helmAction, (_event, request) => client.helmAction(request as HelmActionRequest));
  ipc.handle(channels.listAudit, () => client.listAudit());
  ipc.handle(channels.helmRepos, () => client.helmRepos());
  ipc.handle(channels.helmAddRepo, (_event, repo) => client.helmAddRepo(repo as HelmRepo));
  ipc.handle(channels.helmSearch, (_event, term) => client.helmSearch(term as string));
  ipc.handle(channels.helmChartValues, (_event, chart, version) => client.helmChartValues(chart as string, version as string | undefined));
  ipc.handle(channels.helmInstall, (_event, request) => client.helmInstall(request as HelmInstallRequest));
  ipc.handle(channels.getMap, (_event, scope) => client.getMap(scope as MapScope));
  ipc.handle(channels.listArgoApps, () => client.listArgoApps());
  ipc.handle(channels.argoAction, (_event, request) => client.argoAction(request as ArgoAction));
  ipc.handle(channels.hubSearch, (_event, term) => client.hubSearch(term as string));
  ipc.handle(channels.startNodeShell, (_event, node) => client.startNodeShell(node as string));
  ipc.handle(channels.stopNodeShell, (_event, namespace, pod) => client.stopNodeShell(namespace as string, pod as string));
  ipc.handle(channels.whoCan, (_event, request) => client.whoCan(request as WhoCanRequest));
  ipc.handle(channels.myRules, (_event, namespace) => client.myRules(namespace as string | null));
  ipc.handle(channels.closeCluster, (_event, clusterId) => client.closeCluster(clusterId as string));
  client.onSession((session) => webContents.send(channels.session, session));
  client.subscribeRows((batch) => webContents.send(channels.rows, batch));
  client.onTerminal((event) => webContents.send(channels.terminal, event));
  client.onLogs((event) => webContents.send(channels.logs, event));
}

export function createPreloadClient(ipc: IpcRendererLike): ClusterClient {
  return {
    listClusters: () => ipc.invoke(channels.listClusters) as Promise<ClusterClient["listClusters"] extends () => Promise<infer T> ? T : never>,
    pickKubeconfig: () => ipc.invoke(channels.pickKubeconfig) as Promise<string | null>,
    connect: (clusterId) => ipc.invoke(channels.connect, clusterId) as Promise<void>,
    disconnect: () => ipc.invoke(channels.disconnect) as Promise<void>,
    setNamespace: (namespace) => ipc.invoke(channels.setNamespace, namespace) as Promise<void>,
    getYaml: (ref) => ipc.invoke(channels.getYaml, ref) as Promise<string>,
    runCommand: (request) => ipc.invoke(channels.runCommand, request) as Promise<Awaited<ReturnType<ClusterClient["runCommand"]>>>,
    setFocus: (kind) => ipc.invoke(channels.setFocus, kind) as Promise<void>,
    listCounts: () => ipc.invoke(channels.listCounts) as Promise<Record<string, number>>,
    getLogs: (request) => ipc.invoke(channels.getLogs, request) as Promise<LogBundle>,
    followLogs: (request) => ipc.invoke(channels.followLogs, request) as Promise<{ id: string }>,
    stopFollow: (id) => ipc.invoke(channels.stopFollow, id) as Promise<void>,
    onLogs(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as LogEvent);
      ipc.on(channels.logs, wrapped);
      return () => ipc.removeListener(channels.logs, wrapped);
    },
    applyYaml: (request) => ipc.invoke(channels.applyYaml, request) as Promise<ApplyResult>,
    listRelated: (ref) => ipc.invoke(channels.listRelated, ref) as Promise<RelatedRef[]>,
    listEvents: (ref) => ipc.invoke(channels.listEvents, ref) as Promise<ObjectEvent[]>,
    listWarnings: () => ipc.invoke(channels.listWarnings) as Promise<ClusterWarning[]>,
    checkAccess: (ref) => ipc.invoke(channels.checkAccess, ref) as Promise<AccessMap>,
    getGuards: () => ipc.invoke(channels.getGuards) as Promise<Record<string, ContextGuard>>,
    describeContext: (clusterId) => ipc.invoke(channels.describeContext, clusterId) as Promise<ContextDetails>,
    updateContext: (clusterId, edit) => ipc.invoke(channels.updateContext, clusterId, edit) as Promise<ContextSaved>,
    removeContext: (clusterId) => ipc.invoke(channels.removeContext, clusterId) as Promise<ContextRemoved>,
    setGuard: (clusterId, guard) => ipc.invoke(channels.setGuard, clusterId, guard) as Promise<void>,
    startDebug: (request) => ipc.invoke(channels.startDebug, request) as Promise<{ container: string }>,
    listExecTargets: (ref) => ipc.invoke(channels.listExecTargets, ref) as Promise<ExecTarget[]>,
    readSecret: (namespace, name) => ipc.invoke(channels.readSecret, namespace, name) as Promise<SecretReveal>,
    writeSecret: (request) => ipc.invoke(channels.writeSecret, request) as Promise<SecretReveal>,
    findWorkloads: (clusterId, needle) => ipc.invoke(channels.findWorkloads, clusterId, needle) as Promise<ResourceRow[]>,
    getYamlIn: (clusterId, ref) => ipc.invoke(channels.getYamlIn, clusterId, ref) as Promise<string>,
    listImagesIn: (clusterId) => ipc.invoke(channels.listImagesIn, clusterId) as Promise<WorkloadImages[]>,
    listCertificates: () => ipc.invoke(channels.listCertificates) as Promise<CertInfo[]>,
    listVolumes: () => ipc.invoke(channels.listVolumes) as Promise<VolumeReport>,
    searchLogs: (request) => ipc.invoke(channels.searchLogs, request) as Promise<LogSearchResult>,
    lookupPrices: (requests) => ipc.invoke(channels.lookupPrices, requests) as Promise<PriceQuote[]>,
    getTimeline: (ref) => ipc.invoke(channels.getTimeline, ref) as Promise<Timeline>,
    setNotifications: (enabled) => ipc.invoke(channels.setNotifications, enabled) as Promise<void>,
    cloudAccounts: (provider) => ipc.invoke(channels.cloudAccounts, provider) as Promise<CloudAccount[]>,
    cloudDefaultRegion: (accountId) => ipc.invoke(channels.cloudDefaultRegion, accountId) as Promise<string>,
    cloudClusters: (provider, accountId, region) => ipc.invoke(channels.cloudClusters, provider, accountId, region) as Promise<CloudCluster[]>,
    cloudAddCluster: (request) => ipc.invoke(channels.cloudAddCluster, request) as Promise<{ context: string; message: string }>,
    onAlert(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as ClusterAlert);
      ipc.on(channels.alert, wrapped);
      return () => ipc.removeListener(channels.alert, wrapped);
    },
    onAlertOpen(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as ClusterAlert);
      ipc.on(channels.alertOpen, wrapped);
      return () => ipc.removeListener(channels.alertOpen, wrapped);
    },
    openPortForward: (request) => ipc.invoke(channels.portForwardOpen, request) as Promise<Awaited<ReturnType<ClusterClient["openPortForward"]>>>,
    closePortForward: (id) => ipc.invoke(channels.portForwardClose, id) as Promise<void>,
    listPortForwards: () => ipc.invoke(channels.portForwardList) as Promise<Awaited<ReturnType<ClusterClient["listPortForwards"]>>>,
    readUsage: () => ipc.invoke(channels.readUsage) as Promise<ClusterUsage>,
    openTerminal: (request) => ipc.invoke(channels.terminalOpen, request) as Promise<{ id: string }>,
    writeTerminal: (id, data) => ipc.invoke(channels.terminalWrite, id, data) as Promise<void>,
    resizeTerminal: (id, cols, rows) => ipc.invoke(channels.terminalResize, id, cols, rows) as Promise<void>,
    closeTerminal: (id) => ipc.invoke(channels.terminalClose, id) as Promise<void>,
    onTerminal(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as TerminalEvent);
      ipc.on(channels.terminal, wrapped);
      return () => ipc.removeListener(channels.terminal, wrapped);
    },
    createYaml: (request) => ipc.invoke(channels.createYaml, request) as Promise<CreateResult>,
    listHelmReleases: () => ipc.invoke(channels.listHelmReleases) as Promise<HelmRelease[]>,
    getHelmRelease: (namespace, name) => ipc.invoke(channels.getHelmRelease, namespace, name) as Promise<HelmReleaseDetail>,
    helmAction: (request) => ipc.invoke(channels.helmAction, request) as Promise<Awaited<ReturnType<ClusterClient["helmAction"]>>>,
    listAudit: () => ipc.invoke(channels.listAudit) as Promise<AuditEntry[]>,
    helmRepos: () => ipc.invoke(channels.helmRepos) as Promise<HelmRepo[]>,
    helmAddRepo: (repo) => ipc.invoke(channels.helmAddRepo, repo) as Promise<void>,
    helmSearch: (term) => ipc.invoke(channels.helmSearch, term) as Promise<HelmChart[]>,
    helmChartValues: (chart, version) => ipc.invoke(channels.helmChartValues, chart, version) as Promise<string>,
    helmInstall: (request) => ipc.invoke(channels.helmInstall, request) as Promise<Awaited<ReturnType<ClusterClient["helmInstall"]>>>,
    getMap: (scope) => ipc.invoke(channels.getMap, scope) as Promise<ResourceMap>,
    listArgoApps: () => ipc.invoke(channels.listArgoApps) as Promise<ArgoApp[]>,
    argoAction: (request) => ipc.invoke(channels.argoAction, request) as Promise<Awaited<ReturnType<ClusterClient["argoAction"]>>>,
    hubSearch: (term) => ipc.invoke(channels.hubSearch, term) as Promise<HubChart[]>,
    startNodeShell: (node) => ipc.invoke(channels.startNodeShell, node) as Promise<NodeShell>,
    stopNodeShell: (namespace, pod) => ipc.invoke(channels.stopNodeShell, namespace, pod) as Promise<void>,
    whoCan: (request) => ipc.invoke(channels.whoCan, request) as Promise<WhoCanSubject[]>,
    myRules: (namespace) => ipc.invoke(channels.myRules, namespace) as Promise<AccessRule[]>,
    closeCluster: (clusterId) => ipc.invoke(channels.closeCluster, clusterId) as Promise<void>,
    updateState: () => ipc.invoke(channels.updateState) as Promise<UpdateState>,
    checkForUpdates: () => ipc.invoke(channels.checkForUpdates) as Promise<UpdateState>,
    installUpdate: () => ipc.invoke(channels.installUpdate) as Promise<void>,
    setAutomaticUpdates: (enabled) => ipc.invoke(channels.setAutomaticUpdates, enabled) as Promise<UpdateState>,
    onUpdate(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as UpdateState);
      ipc.on(channels.update, wrapped);
      return () => ipc.removeListener(channels.update, wrapped);
    },
    onSession(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as Session);
      ipc.on(channels.session, wrapped);
      // A page that just loaded, a reload or a window reopened from the dock, has missed earlier updates: ask for
      // the current session and rows now that someone is listening.
      void ipc.invoke(channels.resend).catch(() => undefined);
      return () => ipc.removeListener(channels.session, wrapped);
    },
    subscribeRows(listener) {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as RowBatch);
      ipc.on(channels.rows, wrapped);
      return () => ipc.removeListener(channels.rows, wrapped);
    },
  };
}
