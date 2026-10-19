import { execFile } from "node:child_process";
import { setHeaderOptions } from "@kubernetes/client-node";
import { ApiextensionsV1Api, AppsV1Api, CustomObjectsApi, AuthorizationV1Api, BatchV1Api, CoreV1Api, KubernetesObjectApi, PatchStrategy, RbacAuthorizationV1Api, Watch, dumpYaml, loadAllYaml, loadYaml, type KubernetesObject } from "@kubernetes/client-node";
import { Metrics } from "@kubernetes/client-node/dist/metrics.js";
import { stringify, parse } from "yaml";
import { apiKindOf, catalogEntry, customKinds, type CatalogEntry, cpuMillicores, entryForApiKind, memoryBytes, resourcePath, type AccessMap, type AccessVerb, type ExecTarget, type ResourceKind, type ResourceRef } from "@podgaze/contracts";
import { messageOf, statusOf, type ClusterBackend, type WatchHandlers } from "./batch.js";
import { conflictPaths, editable, identityProblem, mergePatch, withoutManagedFields, type JsonObject } from "./edit.js";
import { cronCommand, executeCommand, genericCommand, readEvents } from "./kube-commands.js";
import { workloadCommand } from "./workload-commands.js";
import { readManifest, selectorString, type LabelSelector } from "./manifest.js";
import { createRelatedLookup } from "./related.js";
import { crdEntries, type CrdLike } from "./custom-kinds.js";
import http from "node:http";
import https from "node:https";
import { storageClasses, volumeRows, type ClaimLike, type ClassLike, type MountingPod } from "./volumes.js";
import { compileMatcher, createRegexSearch, inBatches, LINES_PER_CONTAINER, MAX_PODS, mergeMatches, searchText } from "./log-search.js";
import { buildTimeline, type RevisionLike, type TimelineEvent, type TimelinePod } from "./timeline.js";
import { caBundleRows, externalSecretRows, type CaBundleHolder, type ExternalSecretLike } from "./certs.js";
import { certificateRows, workloadImages, type CertificateLike, type TlsSecretLike } from "./certs.js";
import { argoApp, disableAutoSyncPatch, hubCharts, NODE_SHELL_COMMAND, nodeShellPod, refreshPatch, rollbackPatch, syncPatch } from "./argo.js";
import { buildMap, parseEqualitySelector, type IstioKinds, type MapInput, type MapObject } from "./map.js";
import { createHelmRunner, helmArgs, helmCommandLine, installArgs, installCommandLine, latestReleases, parseCharts, parseRepos, releaseDetail, type HelmSecretLike } from "./helm.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whoCan, type BindingLike, type RoleLike } from "./rbac.js";
import { decodeSecretData, secretManager, secretPatch } from "./secret.js";
import { deploymentToRow, nodeToRow, objectToRow, podToRow, type DeploymentLike, type NodeLike, type PodLike } from "./project.js";
import { loadKubeConfig } from "./summaries.js";

const PAGE = 500;

type Page<T> = { items?: T[]; metadata?: { resourceVersion?: string; _continue?: string } };

// Lists in pages so a 5,000-pod cluster does not arrive as one huge response.
// Continue tokens keep one consistent snapshot, so the last page's resourceVersion is safe to watch from.
async function allPages<T>(fetch: (token: string | undefined) => Promise<Page<T>>): Promise<{ items: T[]; resourceVersion: string }> {
  const items: T[] = [];
  let token: string | undefined;
  let resourceVersion = "";
  do {
    const page = await fetch(token);
    items.push(...(page.items ?? []));
    resourceVersion = page.metadata?.resourceVersion ?? resourceVersion;
    token = page.metadata?._continue || undefined;
  } while (token);
  return { items, resourceVersion };
}

// What the editor shows. managedFields is server bookkeeping and makes manifests unreadable.
function editorYaml(object: unknown): string {
  return dumpYaml(withoutManagedFields(object as object));
}

function diffYaml(object: unknown): string {
  const copy = parse(dumpYaml(withoutManagedFields(object as object))) as { metadata?: Record<string, unknown> };
  delete copy.metadata?.resourceVersion;
  delete copy.metadata?.generation;
  return stringify(copy);
}

// A ConfigMap release holds Helm's base64 directly; wrap it like Secret data so one decoder reads both.
function configMapRelease(item: { metadata?: HelmSecretLike["metadata"]; data?: Record<string, string> }): HelmSecretLike {
  return {
    metadata: item.metadata,
    type: "helm.sh/release.v1",
    data: item.data?.release ? { release: Buffer.from(item.data.release).toString("base64") } : {},
  };
}

type CountPage = { items?: unknown[]; metadata?: { remainingItemCount?: number; _continue?: string; continue?: string } };

// One tiny request answers "none" or "one" outright, and "how many" when the server reports remainingItemCount.
// Servers that leave it out (list served from the watch cache, some managed control planes) get counted page by page.
export async function countObjects(fetch: (limit: number, token: string | undefined) => Promise<CountPage>): Promise<number> {
  const first = await fetch(1, undefined);
  const firstToken = first.metadata?._continue || first.metadata?.continue;
  if (!firstToken) return first.items?.length ?? 0;
  if (typeof first.metadata?.remainingItemCount === "number") return (first.items?.length ?? 0) + first.metadata.remainingItemCount;
  let total = 0;
  let token: string | undefined;
  do {
    const page = await fetch(PAGE, token);
    total += page.items?.length ?? 0;
    token = page.metadata?._continue || page.metadata?.continue || undefined;
  } while (token);
  return total;
}

function apiGroup(apiVersion: string): string {
  return apiVersion.includes("/") ? apiVersion.split("/")[0]! : "";
}

export function createKubeBackend(filePath: string, contextName: string): ClusterBackend {
  const kc = loadKubeConfig(filePath);
  kc.setCurrentContext(contextName);
  const api = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const auth = kc.makeApiClient(AuthorizationV1Api);
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const watch = new Watch(kc);
  const related = createRelatedLookup(objects);
  const extensions = kc.makeApiClient(ApiextensionsV1Api);
  const rbac = kc.makeApiClient(RbacAuthorizationV1Api);
  const helm = createHelmRunner(execFile);
  const custom = kc.makeApiClient(CustomObjectsApi);

  // Custom resources are listed through the untyped API. The generic object client parses a list's metadata as an
  // object's metadata and drops "continue" and "remainingItemCount", which cut pages and counts short.
  async function customPage(entry: CatalogEntry, namespace: string | null, limit: number, token: string | undefined): Promise<Page<KubernetesObject> & { metadata?: { remainingItemCount?: number } }> {
    const [group, version] = entry.apiVersion.split("/") as [string, string];
    const raw = (entry.namespaced && namespace
      ? await custom.listNamespacedCustomObject({ group, version, namespace, plural: entry.plural, limit, _continue: token })
      : await custom.listClusterCustomObject({ group, version, plural: entry.plural, limit, _continue: token })) as {
      items?: KubernetesObject[];
      metadata?: { resourceVersion?: string; continue?: string; remainingItemCount?: number };
    };
    return {
      items: raw.items ?? [],
      metadata: { resourceVersion: raw.metadata?.resourceVersion, _continue: raw.metadata?.continue, remainingItemCount: raw.metadata?.remainingItemCount },
    };
  }

  const argoEntry: CatalogEntry = {
    kind: "applications.argoproj.io", group: "Custom", label: "Application", namespaced: true, apiVersion: "argoproj.io/v1alpha1",
    plural: "applications", apiKind: "Application", apiGroup: "argoproj.io", columns: [], commands: [],
  };

  async function rawList(entry: CatalogEntry, namespace: string | null): Promise<MapObject[]> {
    const list = await allPages((token) => listPage(entry, namespace, PAGE, token));
    return list.items as MapObject[];
  }

  function listPage(entry: CatalogEntry, namespace: string | null, limit: number, token: string | undefined) {
    if (entry.apiGroup) return customPage(entry, namespace, limit, token);
    return objects.list(
      entry.apiVersion,
      apiKindOf(entry),
      entry.namespaced ? namespace ?? undefined : undefined,
      undefined, undefined, undefined, undefined, undefined,
      limit,
      token,
    ) as Promise<Page<KubernetesObject> & { metadata?: { remainingItemCount?: number } }>;
  }

  async function openWatch(apiPath: string, resourceVersion: string, handlers: WatchHandlers) {
    let stopped = false;
    const controller = await watch.watch(
      apiPath,
      { resourceVersion, allowWatchBookmarks: true },
      (phase, apiObj) => {
        if (!stopped) handlers.onEvent(phase, apiObj);
      },
      (err) => {
        if (stopped || !err) return;
        handlers.onError({ statusCode: statusOf(err), message: messageOf(err) });
      },
    );
    return {
      stop() {
        stopped = true;
        controller.abort();
      },
    };
  }

  function targetFromPod(pod: PodLike, fallbackNamespace: string): ExecTarget | null {
    const name = pod.metadata?.name;
    if (!name) return null;
    const containers = (pod.spec?.containers ?? []).map((container) => container.name ?? "").filter(Boolean);
    return {
      namespace: pod.metadata?.namespace || fallbackNamespace,
      pod: name,
      containers: containers.length > 0 ? containers : ["default"],
    };
  }

  async function podsForSelector(namespace: string, selector: LabelSelector | undefined | null | string): Promise<ExecTarget[]> {
    const query = typeof selector === "string" ? selector : selectorString(selector);
    if (!query) throw new Error("This resource has no pod selector.");
    const list = await api.listNamespacedPod({ namespace, labelSelector: query });
    return (list.items ?? []).map((item) => targetFromPod(item as PodLike, namespace)).filter((item) => item !== null);
  }

  // Helm keeps releases in Secrets by default and in ConfigMaps with HELM_DRIVER=configmap; read both.
  async function helmRecords(namespace: string | null, labelSelector: string): Promise<HelmSecretLike[]> {
    const [secrets, configMaps] = await Promise.all([
      namespace ? api.listNamespacedSecret({ namespace, labelSelector }) : api.listSecretForAllNamespaces({ labelSelector }),
      (namespace ? api.listNamespacedConfigMap({ namespace, labelSelector }) : api.listConfigMapForAllNamespaces({ labelSelector })).catch(() => ({ items: [] })),
    ]);
    return [...(secrets.items ?? []) as HelmSecretLike[], ...(configMaps.items ?? []).map(configMapRelease)];
  }

  async function can(namespace: string | null, verb: string, group: string, resource: string, subresource?: string, name?: string): Promise<boolean | undefined> {
    try {
      const review = await auth.createSelfSubjectAccessReview({
        body: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: { resourceAttributes: { namespace: namespace ?? undefined, verb, group, resource, subresource, name } },
        },
      });
      return Boolean(review.status?.allowed);
    } catch {
      // If the review itself fails we do not know, so the action stays enabled and the API decides.
      return undefined;
    }
  }

  const TIMELINE_PODS = 30;

  type Owned = { metadata?: { name?: string; uid?: string; creationTimestamp?: string | Date; annotations?: Record<string, string>; ownerReferences?: { uid?: string }[] } };
  type Template = { spec?: { containers?: { name?: string; image?: string }[] } };

  return {
    async getTimeline(ref) {
      const namespace = ref.namespace || "default";
      const supported = ["Deployment", "StatefulSet", "DaemonSet", "Pod"];
      if (!supported.includes(ref.kind)) throw new Error("A timeline is kept for Deployments, StatefulSets, DaemonSets, and Pods.");
      const entry = catalogEntry(ref.kind)!;
      const workload = (await objects.read({ apiVersion: entry.apiVersion, kind: apiKindOf(entry), metadata: { name: ref.name, namespace } })) as KubernetesObject & {
        spec?: { selector?: LabelSelector };
        status?: { conditions?: { type?: string; lastUpdateTime?: string | Date }[] };
      };
      const uid = workload.metadata?.uid;
      const ownedBy = (item: Owned) => (item.metadata?.ownerReferences ?? []).some((owner) => owner.uid === uid);
      const selector = ref.kind === "Pod" ? "" : selectorString(workload.spec?.selector);

      const revisions: RevisionLike[] = [];
      if (ref.kind === "Deployment") {
        const sets = await apps.listNamespacedReplicaSet({ namespace, labelSelector: selector || undefined });
        for (const set of (sets.items ?? []) as (Owned & { spec?: { template?: Template } })[]) {
          if (!ownedBy(set)) continue;
          const revision = set.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "?";
          let created = String(set.metadata?.creationTimestamp instanceof Date ? set.metadata.creationTimestamp.toISOString() : set.metadata?.creationTimestamp ?? "");
          let changeCause = set.metadata?.annotations?.["kubernetes.io/change-cause"];
          // A rollback reuses an old ReplicaSet and gives it the newest revision number; its creation time is
          // then days old. For the current revision, the Deployment's Progressing condition says when it rolled out.
          if (revision === workload.metadata?.annotations?.["deployment.kubernetes.io/revision"] && set.metadata?.annotations?.["deployment.kubernetes.io/revision-history"]) {
            const progressed = workload.status?.conditions?.find((condition) => condition.type === "Progressing")?.lastUpdateTime;
            const at = progressed ? new Date(progressed).toISOString() : "";
            if (at && at > created) {
              created = at;
              changeCause = [changeCause, "rolled back to an earlier ReplicaSet"].filter(Boolean).join(" · ");
            }
          }
          revisions.push({ name: `ReplicaSet ${set.metadata?.name ?? ""}`, created, revision, containers: set.spec?.template?.spec?.containers ?? [], changeCause });
        }
      } else if (ref.kind !== "Pod") {
        const history = await apps.listNamespacedControllerRevision({ namespace, labelSelector: selector || undefined });
        for (const item of (history.items ?? []) as (Owned & { revision?: number; data?: { spec?: { template?: Template } } })[]) {
          if (!ownedBy(item)) continue;
          revisions.push({
            name: `ControllerRevision ${item.metadata?.name ?? ""}`,
            created: String(item.metadata?.creationTimestamp instanceof Date ? item.metadata.creationTimestamp.toISOString() : item.metadata?.creationTimestamp ?? ""),
            revision: String(item.revision ?? "?"),
            containers: item.data?.spec?.template?.spec?.containers ?? [],
          });
        }
      }

      const pods = ref.kind === "Pod"
        ? [await api.readNamespacedPod({ name: ref.name, namespace })]
        : selector ? (await api.listNamespacedPod({ namespace, labelSelector: selector })).items ?? [] : [];

      // Events of the workload, its ReplicaSets, its pods, and any autoscaler pointed at it.
      // Pods: the newest few are where recent crashes are; events of long-gone pods have usually expired anyway.
      const newestPods = [...pods]
        .sort((left, right) => String(right.metadata?.creationTimestamp ?? "").localeCompare(String(left.metadata?.creationTimestamp ?? "")))
        .slice(0, TIMELINE_PODS);
      const names = new Set<string>([ref.name, ...revisions.map((revision) => revision.name.split(" ")[1] ?? ""), ...newestPods.map((pod) => pod.metadata?.name ?? "")].filter(Boolean));
      const hpas = ref.kind === "Pod" ? [] : await rawList(catalogEntry("HorizontalPodAutoscaler")!, namespace).catch(() => [] as MapObject[]);
      for (const hpa of hpas as { metadata?: { name?: string }; spec?: { scaleTargetRef?: { kind?: string; name?: string } } }[]) {
        if (hpa.spec?.scaleTargetRef?.kind === apiKindOf(entry) && hpa.spec.scaleTargetRef.name === ref.name && hpa.metadata?.name) names.add(hpa.metadata.name);
      }
      // One small query per object instead of every event in the namespace, which can be tens of thousands.
      const events = (await inBatches([...names], 8, (name) => api.listNamespacedEvent({ namespace, fieldSelector: `involvedObject.name=${name}` })
        .then((list) => (list.items ?? []) as TimelineEvent[], () => [] as TimelineEvent[]))).flat();
      // Name and kind: a Service named like the Deployment has its own, unrelated events.
      const kinds = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ControllerRevision", "Pod", "HorizontalPodAutoscaler"]);
      const mine = events.filter((event) => names.has(event.involvedObject?.name ?? "") && kinds.has(event.involvedObject?.kind ?? ""));

      const argo = await this.listArgoApps!().catch(() => []);
      const tracking = argo.filter((app) => app.resources.some((resource) => resource.kind === apiKindOf(entry) && resource.name === ref.name && (resource.namespace || app.destNamespace) === namespace));

      return buildTimeline({ revisions, pods: pods as TimelinePod[], events: mine, argo: tracking });
    },
    async listVolumes(namespace) {
      const [claims, pods, classes] = await Promise.all([
        namespace ? api.listNamespacedPersistentVolumeClaim({ namespace }) : api.listPersistentVolumeClaimForAllNamespaces({}),
        namespace ? api.listNamespacedPod({ namespace }) : api.listPodForAllNamespaces({}),
        objects.list("storage.k8s.io/v1", "StorageClass").then((list) => (list as { items?: unknown[] }).items ?? [], () => []),
      ]);
      const known = storageClasses(classes as ClassLike[]);
      return { volumes: volumeRows((claims.items ?? []) as ClaimLike[], (pods.items ?? []) as MountingPod[], known), classes: known };
    },
    async searchLogs(request) {
      const matcher = compileMatcher(request.pattern, request.regex, request.caseSensitive);
      // Regexes are matched in a worker with a time limit; plain text is always fast and stays here.
      const regexSearch = request.regex ? createRegexSearch(request.pattern, request.caseSensitive) : null;
      const targets = request.workload
        ? await this.listExecTargets(request.workload)
        : ((await api.listNamespacedPod({ namespace: request.namespace })).items ?? [])
          .filter((pod) => pod.status?.phase === "Running" || pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded")
          .map((pod) => targetFromPod(pod as PodLike, request.namespace))
          .filter((target) => target !== null);
      const problems: string[] = [];
      if (targets.length > MAX_PODS) problems.push(`Searched the first ${MAX_PODS} of ${targets.length} pods. Pick a workload to narrow it.`);
      const jobs = targets.slice(0, MAX_PODS).flatMap((target) => target.containers.map((container) => ({ target, container })));
      let lines = 0;
      let dropped = 0;
      const clipped: string[] = [];
      const found = await inBatches(jobs, 6, async ({ target, container }) => {
        try {
          // tailLines makes kubelet return the newest lines of the window, not the oldest.
          const text = await api.readNamespacedPodLog({
            name: target.pod,
            namespace: target.namespace,
            container,
            timestamps: true,
            sinceSeconds: Math.max(60, Math.min(request.sinceSeconds, 7 * 86400)),
            tailLines: LINES_PER_CONTAINER,
          });
          const result = regexSearch ? await regexSearch.search(String(text), target.pod, container) : searchText(String(text), matcher, target.pod, container);
          lines += result.lines;
          dropped += result.dropped;
          if (result.lines >= LINES_PER_CONTAINER) clipped.push(`${target.pod}/${container}`);
          return result.matches;
        } catch (error) {
          if (regexSearch && /took longer than/.test(messageOf(error))) throw error;
          problems.push(`${target.pod}/${container}: ${messageOf(error)}`);
          return [];
        }
      }).finally(() => regexSearch?.close());
      if (clipped.length > 0) problems.push(`Only the newest ${LINES_PER_CONTAINER.toLocaleString()} lines of the time range were searched in ${clipped.slice(0, 5).join(", ")}${clipped.length > 5 ? ` and ${clipped.length - 5} more` : ""}; older lines were skipped.`);
      const merged = mergeMatches(found);
      return { ...merged, truncated: merged.truncated || dropped > 0, pods: Math.min(targets.length, MAX_PODS), containers: jobs.length, lines, problems };
    },
    async listCertificates(namespace) {
      const fieldSelector = "type=kubernetes.io/tls";
      const secrets = namespace
        ? await api.listNamespacedSecret({ namespace, fieldSelector })
        : await api.listSecretForAllNamespaces({ fieldSelector });
      const entry = customKinds().find((item) => item.apiGroup === "cert-manager.io" && item.apiKind === "Certificate");
      const certificates = entry ? await rawList(entry, entry.namespaced ? namespace : null).catch(() => [] as MapObject[]) : [];
      const clusterList = async (apiVersion: string, kind: string) => {
        try {
          return ((await objects.list(apiVersion, kind)) as { items?: unknown[] }).items ?? [];
        } catch {
          return [];
        }
      };
      const [mutating, validating, apiServices] = await Promise.all([
        clusterList("admissionregistration.k8s.io/v1", "MutatingWebhookConfiguration"),
        clusterList("admissionregistration.k8s.io/v1", "ValidatingWebhookConfiguration"),
        clusterList("apiregistration.k8s.io/v1", "APIService"),
      ]);
      const externalEntry = customKinds().find((item) => item.apiGroup === "external-secrets.io" && item.apiKind === "ExternalSecret");
      const externalSecrets = externalEntry ? await rawList(externalEntry, namespace).catch(() => [] as MapObject[]) : [];
      return [
        ...certificateRows((secrets.items ?? []) as TlsSecretLike[], certificates as CertificateLike[]),
        ...caBundleRows([...mutating, ...validating] as CaBundleHolder[], "Webhook"),
        ...caBundleRows(apiServices as CaBundleHolder[], "APIService"),
        ...externalSecretRows(externalSecrets as ExternalSecretLike[]),
      ].sort((left, right) => (left.notAfter || "9999").localeCompare(right.notAfter || "9999"));
    },
    async listImages() {
      const kinds = ["Deployment", "StatefulSet", "DaemonSet", "CronJob"] as const;
      const lists = await Promise.all(kinds.map(async (kind) => workloadImages(kind, (await rawList(catalogEntry(kind)!, null).catch(() => [] as MapObject[])) as never)));
      return lists.flat();
    },
    async findWorkloads(needle) {
      const query = needle.trim().toLowerCase();
      const kinds = ["Deployment", "StatefulSet", "DaemonSet"] as const;
      const lists = await Promise.all(kinds.map((kind) => this.listResources(kind, null).then((listed) => listed.rows, () => [])));
      return lists.flat().filter((row) => !query || row.name.toLowerCase().includes(query)).slice(0, 200);
    },
    async getMap(scope) {
      const kinds = ["Ingress", "Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod", "Job", "CronJob", "HorizontalPodAutoscaler", "ConfigMap", "Secret", "PersistentVolumeClaim"] as const;
      const namespaces: (string | null)[] = scope.namespaces && scope.namespaces.length > 0 ? scope.namespaces : [null];
      const input: MapInput = {};
      await Promise.all(kinds.map(async (kind) => {
        const entry = catalogEntry(kind)!;
        const lists = await Promise.all(namespaces.map((namespace) => rawList(entry, namespace).catch((error: unknown) => {
          // A kind this account cannot list just leaves its part of the map out.
          if (statusOf(error) === 403) return [] as MapObject[];
          throw error;
        })));
        input[kind] = lists.flat();
      }));
      // Istio routing, when the cluster has Istio's CRDs.
      const istio: IstioKinds = {};
      for (const apiKind of ["Gateway", "VirtualService", "DestinationRule"] as const) {
        const entry = customKinds().find((item) => item.apiGroup === "networking.istio.io" && item.apiKind === apiKind);
        if (!entry) continue;
        istio[apiKind] = entry.kind;
        const lists = await Promise.all(namespaces.map((namespace) => rawList(entry, namespace).catch(() => [] as MapObject[])));
        input[apiKind] = lists.flat();
      }
      return buildMap(input, { labelSelector: parseEqualitySelector(scope.labelSelector), istio });
    },
    async listArgoApps() {
      try {
        const items = await rawList(argoEntry, null);
        return items.map((item) => argoApp(item as Record<string, unknown>)).filter((app) => app !== null)
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        if (statusOf(error) === 404) return [];
        throw error;
      }
    },
    async argoAction(request) {
      const current = await custom.getNamespacedCustomObject({ group: "argoproj.io", version: "v1alpha1", namespace: request.namespace, plural: "applications", name: request.name }) as Record<string, unknown>;
      const app = argoApp(current);
      if (!app) throw new Error("That Application no longer exists.");
      if ((request.action === "sync" || request.action === "rollback") && app.operation?.phase === "Running") throw new Error("A sync is already running for this Application.");
      const patch = request.action === "sync" ? syncPatch(app, Boolean(request.prune))
        : request.action === "rollback" ? rollbackPatch(app, request.revision ?? "")
        : request.action === "disable-autosync" ? disableAutoSyncPatch()
        : refreshPatch(request.action === "hard-refresh");
      const body = { apiVersion: "argoproj.io/v1alpha1", kind: "Application", ...patch, metadata: { ...((patch.metadata as Record<string, unknown> | undefined) ?? {}), name: request.name, namespace: request.namespace } };
      await objects.patch(body as KubernetesObject, undefined, undefined, "podgaze", undefined, PatchStrategy.MergePatch);
      const historyId = app.history.find((entry) => entry.revision === request.revision)?.id;
      const command = request.action === "sync" ? `argocd app sync ${request.name}${request.prune ? " --prune" : ""}`
        : request.action === "rollback" ? `argocd app rollback ${request.name} ${historyId ?? ""}`.trim()
        : request.action === "disable-autosync" ? `argocd app set ${request.name} --sync-policy none`
        : `argocd app get ${request.name} --${request.action === "hard-refresh" ? "hard-refresh" : "refresh"}`;
      const output = request.action === "sync" ? `Sync of ${app.targetRevision} requested. Argo CD picks it up within seconds.`
        : request.action === "rollback" ? `Rollback to ${request.revision?.slice(0, 10)} requested. The app shows OutOfSync until Git matches again.`
        : request.action === "disable-autosync" ? "Auto-sync is off. If this Application is itself managed from Git (app of apps), Git will turn it back on."
        : "Refresh requested. Argo CD compares the app with Git again.";
      return { title: request.action, command, output };
    },
    async hubSearch(term) {
      const url = `https://artifacthub.io/api/v1/packages/search?ts_query_web=${encodeURIComponent(term)}&kind=0&limit=25&sort=relevance`;
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Artifact Hub answered ${response.status}.`);
      return hubCharts(await response.json());
    },
    async startNodeShell(node) {
      const found = await api.readNode({ name: node });
      if (found.metadata?.labels?.["kubernetes.io/os"] === "windows") throw new Error("Node shell works on Linux nodes only.");
      const name = `podgaze-node-shell-${Math.random().toString(36).slice(2, 8)}`;
      await api.createNamespacedPod({ namespace: "kube-system", body: nodeShellPod(node, name) as never });
      const deadline = Date.now() + 90_000;
      try {
        while (Date.now() < deadline) {
          const pod = await api.readNamespacedPod({ name, namespace: "kube-system" });
          if (pod.status?.phase === "Running") return { namespace: "kube-system", pod: name, container: "shell", command: NODE_SHELL_COMMAND };
          const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason;
          if (waiting === "ErrImagePull" || waiting === "ImagePullBackOff") throw new Error("The node could not pull busybox:1.36. Node shell needs that image (or a mirror of it).");
          if (pod.status?.phase === "Failed") throw new Error(`The node shell pod failed: ${pod.status.reason ?? pod.status.message ?? "unknown reason"}.`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("The node shell pod did not start within 90 seconds.");
      } catch (error) {
        await api.deleteNamespacedPod({ name, namespace: "kube-system", gracePeriodSeconds: 0 }).catch(() => undefined);
        throw error;
      }
    },
    async stopNodeShell(namespace, pod) {
      if (!pod.startsWith("podgaze-node-shell-")) throw new Error("Only node shell pods are removed this way.");
      await api.deleteNamespacedPod({ name: pod, namespace, gracePeriodSeconds: 0 }).catch((error: unknown) => {
        if (statusOf(error) !== 404) throw error;
      });
    },
    async listCustomKinds() {
      const list = await extensions.listCustomResourceDefinition();
      return crdEntries((list.items ?? []) as CrdLike[]);
    },
    async countResources(kind, namespace) {
      const entry = catalogEntry(kind);
      if (!entry) throw new Error(`Unknown resource ${kind}.`);
      return countObjects((limit, token) => listPage(entry, namespace, limit, token));
    },
    async createYaml(request) {
      const docs = (loadAllYaml(request.yaml) as (KubernetesObject | null)[]).filter((doc): doc is KubernetesObject => Boolean(doc && doc.kind));
      if (docs.length === 0) throw new Error("There is nothing to create: the YAML has no object with a kind.");
      const created: ResourceRef[] = [];
      for (const [index, doc] of docs.entries()) {
        const entry = entryForApiKind(doc.kind!, doc.apiVersion);
        if (!doc.metadata?.name && !doc.metadata?.generateName) throw new Error(`Document ${index + 1} (${doc.kind}) has no metadata.name.`);
        if (entry?.namespaced && !doc.metadata?.namespace) doc.metadata = { ...doc.metadata, namespace: request.namespace || "default" };
        try {
          const result = await objects.create(doc, undefined, request.dryRun ? "All" : undefined, "podgaze");
          created.push({
            kind: entry?.kind ?? doc.kind!,
            namespace: result.metadata?.namespace ?? null,
            name: result.metadata?.name ?? doc.metadata?.name ?? "",
          });
        } catch (error) {
          const done = created.length > 0 && !request.dryRun ? ` Already created: ${created.map((ref) => `${ref.kind}/${ref.name}`).join(", ")}.` : "";
          throw new Error(`Document ${index + 1} (${doc.kind} ${doc.metadata?.name ?? ""}): ${messageOf(error)}.${done}`);
        }
      }
      const names = created.map((ref) => `${ref.kind}/${ref.name}`).join(", ");
      return {
        created,
        dryRun: Boolean(request.dryRun),
        message: request.dryRun ? `The API server accepts ${names}. Nothing is created yet.` : `Created ${names}.`,
      };
    },
    async listHelmReleases(namespace) {
      return latestReleases(await helmRecords(namespace, "owner=helm"));
    },
    async getHelmRelease(namespace, name) {
      return releaseDetail(await helmRecords(namespace, `owner=helm,name=${name}`));
    },
    async helmAction(request) {
      const command = helmCommandLine(request.action, request.name, request.namespace, request.revision);
      const output = await helm(helmArgs(request.action, request.name, request.namespace, request.revision, filePath, contextName));
      return { title: request.action === "rollback" ? "Rollback" : "Uninstall", command, output: output || "Done." };
    },
    async helmRepos() {
      try {
        return parseRepos(await helm(["repo", "list", "-o", "json"], { timeoutMs: 20_000 }));
      } catch (error) {
        // Helm reports "no repositories to show" as an error.
        if (/no repositories/i.test(messageOf(error))) return [];
        throw error;
      }
    },
    async helmAddRepo(repo) {
      if (!/^[a-z0-9][-a-z0-9_.]*$/i.test(repo.name)) throw new Error("A repository name is letters, digits, dots, dashes, and underscores.");
      if (!/^(https?|oci):\/\//.test(repo.url)) throw new Error("The repository URL must start with https://, http://, or oci://.");
      await helm(["repo", "add", repo.name, repo.url, "--force-update"], { timeoutMs: 60_000 });
      await helm(["repo", "update", repo.name], { timeoutMs: 120_000 });
    },
    async helmSearch(term) {
      return parseCharts(await helm(["search", "repo", term, "-o", "json"], { timeoutMs: 30_000 }));
    },
    async helmChartValues(chart, version) {
      return helm(["show", "values", chart, ...(version ? ["--version", version] : [])], { timeoutMs: 120_000 });
    },
    async helmInstall(request) {
      // Values go through a private temp file: they often hold passwords, and argv is visible to other users.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "podgaze-helm-"));
      const valuesFile = path.join(dir, "values.yaml");
      try {
        fs.writeFileSync(valuesFile, request.values, { mode: 0o600 });
        const output = await helm(installArgs(request, valuesFile, filePath, contextName));
        return { title: request.dryRun ? "Dry run" : request.upgrade ? "Upgrade" : "Install", command: installCommandLine(request), output };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    async whoCan(request) {
      const [clusterRoles, clusterRoleBindings, roles, roleBindings] = await Promise.all([
        rbac.listClusterRole(),
        rbac.listClusterRoleBinding(),
        request.namespace ? rbac.listNamespacedRole({ namespace: request.namespace }) : rbac.listRoleForAllNamespaces(),
        request.namespace ? rbac.listNamespacedRoleBinding({ namespace: request.namespace }) : rbac.listRoleBindingForAllNamespaces(),
      ]);
      return whoCan(request, {
        clusterRoles: (clusterRoles.items ?? []) as RoleLike[],
        clusterRoleBindings: (clusterRoleBindings.items ?? []) as BindingLike[],
        roles: (roles.items ?? []) as RoleLike[],
        roleBindings: (roleBindings.items ?? []) as BindingLike[],
      });
    },
    async myRules(namespace) {
      const review = await auth.createSelfSubjectRulesReview({
        body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectRulesReview", spec: { namespace: namespace || "default" } },
      });
      return (review.status?.resourceRules ?? []).map((rule) => ({
        verbs: rule.verbs ?? [],
        apiGroups: rule.apiGroups ?? [],
        resources: rule.resources ?? [],
        resourceNames: rule.resourceNames ?? [],
      }));
    },
    async listPods(namespace) {
      const list = await allPages((token) => namespace
        ? api.listNamespacedPod({ namespace, limit: PAGE, _continue: token })
        : api.listPodForAllNamespaces({ limit: PAGE, _continue: token }));
      return {
        resourceVersion: list.resourceVersion,
        rows: list.items.map((item) => podToRow(item as PodLike)).filter((row) => row !== null),
      };
    },
    watchPods(namespace, resourceVersion, handlers) {
      const apiPath = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` : "/api/v1/pods";
      return openWatch(apiPath, resourceVersion, handlers);
    },
    async listNodes() {
      const list = await allPages((token) => api.listNode({ limit: PAGE, _continue: token }));
      return {
        resourceVersion: list.resourceVersion,
        rows: list.items.map((item) => nodeToRow(item as NodeLike)).filter((row) => row !== null),
      };
    },
    watchNodes(resourceVersion, handlers) {
      return openWatch("/api/v1/nodes", resourceVersion, handlers);
    },
    async listNamespaces() {
      const list = await api.listNamespace();
      return (list.items ?? []).map((item) => item.metadata?.name).filter((name): name is string => Boolean(name));
    },
    async listDeployments(namespace) {
      const list = await allPages((token) => namespace
        ? apps.listNamespacedDeployment({ namespace, limit: PAGE, _continue: token })
        : apps.listDeploymentForAllNamespaces({ limit: PAGE, _continue: token }));
      return {
        resourceVersion: list.resourceVersion,
        rows: list.items.map((item) => deploymentToRow(item as DeploymentLike)).filter((row) => row !== null),
      };
    },
    watchDeployments(namespace, resourceVersion, handlers) {
      const apiPath = namespace
        ? `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`
        : "/apis/apps/v1/deployments";
      return openWatch(apiPath, resourceVersion, handlers);
    },
    async listResources(kind: ResourceKind, namespace) {
      const entry = catalogEntry(kind);
      if (!entry) throw new Error(`Unknown resource ${kind}.`);
      const list = await allPages((token) => listPage(entry, entry.namespaced ? namespace : null, PAGE, token));
      return {
        resourceVersion: list.resourceVersion,
        rows: list.items.map((item) => objectToRow(kind, item)).filter((row) => row !== null),
      };
    },
    watchResources(kind, namespace, resourceVersion, handlers) {
      const entry = catalogEntry(kind);
      if (!entry) return Promise.reject(new Error(`Unknown resource ${kind}.`));
      return openWatch(resourcePath(entry, entry.namespaced ? namespace : null), resourceVersion, handlers);
    },
    async getYaml(ref: ResourceRef) {
      if (ref.kind === "Pod") {
        const pod = await api.readNamespacedPod({ name: ref.name, namespace: ref.namespace ?? "default" });
        return editorYaml(pod);
      }
      if (ref.kind === "Deployment") {
        const deployment = await apps.readNamespacedDeployment({ name: ref.name, namespace: ref.namespace ?? "default" });
        return editorYaml(deployment);
      }
      if (ref.kind === "Node") {
        const node = await api.readNode({ name: ref.name });
        return editorYaml(node);
      }
      const entry = catalogEntry(ref.kind);
      if (!entry) throw new Error(`Unknown resource ${ref.kind}.`);
      const object = await objects.read({
        apiVersion: entry.apiVersion,
        kind: apiKindOf(entry),
        metadata: { name: ref.name, ...(entry.namespaced ? { namespace: ref.namespace ?? "default" } : {}) },
      });
      return editorYaml(object);
    },
    async readSecret(namespace: string, name: string) {
      const secret = await api.readNamespacedSecret({ name, namespace });
      return {
        type: secret.type || "Opaque",
        values: decodeSecretData(secret.data),
        resourceVersion: secret.metadata?.resourceVersion,
        immutable: Boolean(secret.immutable),
        managedBy: secretManager(secret.metadata),
      };
    },
    async writeSecret(request) {
      const current = await api.readNamespacedSecret({ name: request.name, namespace: request.namespace });
      if (current.immutable) throw new Error("This Secret is immutable. Kubernetes only allows deleting and recreating it.");
      const body = secretPatch(request);
      try {
        // The body goes out as plain JSON, so null survives and removes a key.
        const saved = await api.patchNamespacedSecret(
          { name: request.name, namespace: request.namespace, body, fieldManager: "podgaze" },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        );
        return {
          type: saved.type || "Opaque",
          values: decodeSecretData(saved.data),
          resourceVersion: saved.metadata?.resourceVersion,
          immutable: Boolean(saved.immutable),
          managedBy: secretManager(saved.metadata),
        };
      } catch (error) {
        if (statusOf(error) === 409) throw new Error("Someone changed this Secret after you opened it. Reload the values and make your change again.");
        throw error;
      }
    },
    async readUsage(namespace) {
      try {
        const metrics = new Metrics(kc);
        const [nodes, pods] = await Promise.all([
          metrics.getNodeMetrics(),
          namespace ? metrics.getPodMetrics(namespace) : metrics.getPodMetrics(),
        ]);
        return {
          available: true,
          nodes: (nodes.items ?? []).flatMap((item) => {
            const name = item.metadata?.name;
            if (!name) return [];
            return [{
              name,
              namespace: "",
              cpuMillicores: cpuMillicores(item.usage?.cpu ?? "0"),
              memoryBytes: memoryBytes(item.usage?.memory ?? "0"),
            }];
          }),
          pods: (pods.items ?? []).flatMap((item) => {
            const name = item.metadata?.name;
            if (!name) return [];
            const totals = (item.containers ?? []).reduce(
              (sum, container) => ({
                cpuMillicores: sum.cpuMillicores + cpuMillicores(container.usage?.cpu ?? "0"),
                memoryBytes: sum.memoryBytes + memoryBytes(container.usage?.memory ?? "0"),
              }),
              { cpuMillicores: 0, memoryBytes: 0 },
            );
            return [{ name, namespace: item.metadata?.namespace ?? "", ...totals }];
          }),
        };
      } catch {
        return { available: false, nodes: [], pods: [] };
      }
    },
    async runCommand(request) {
      const extra = await workloadCommand(api, apps, batch, request);
      if (extra) return extra;
      if (request.kind === "CronJob" && (request.name === "trigger" || request.name === "suspend" || request.name === "resume")) {
        return cronCommand(batch, objects, request);
      }
      if (request.kind === "Pod" || request.kind === "Node" || request.kind === "Deployment") {
        return executeCommand(api, apps, request);
      }
      return genericCommand(objects, api, request);
    },
    async getLogs(request) {
      if (request.containers.length === 0) throw new Error("Choose at least one container.");
      const parts: string[] = [];
      for (const container of request.containers) {
        const text = await api.readNamespacedPodLog({
          name: request.pod,
          namespace: request.namespace,
          container,
          timestamps: true,
          tailLines: request.tailLines,
          previous: request.previous,
        });
        parts.push(`# ${request.namespace}/${request.pod}/${container}\n${String(text).trim()}\n`);
      }
      const filename = request.containers.length === 1
        ? `${request.pod}-${request.containers[0]}.log`
        : `${request.pod}.log`;
      return { filename, text: parts.join("\n") };
    },
    async applyYaml(request) {
      const base = readManifest(request.base);
      const draft = readManifest(request.draft);
      const problem = identityProblem(base, draft);
      if (problem) throw new Error(problem);
      const namespace = base.metadata.namespace;
      const header = {
        apiVersion: base.apiVersion,
        kind: base.kind,
        metadata: { name: base.metadata.name, ...(namespace ? { namespace } : {}) },
      };
      const current = await objects.read(header);
      const live = parse(dumpYaml(current)) as JsonObject;
      const patch = mergePatch(editable(base), editable(draft));
      if (!patch) {
        return { applied: false, live: diffYaml(current), yaml: editorYaml(current), message: "No changes to apply.", conflicts: [] };
      }
      const conflicts = conflictPaths(patch, editable(base), editable(live));
      if (conflicts.length > 0 && !request.force && !request.dryRun) {
        return {
          applied: false,
          live: diffYaml(current),
          yaml: editorYaml(current),
          message: "Someone changed these fields after you started editing.",
          conflicts,
        };
      }
      // loadYaml maps API field names onto the client's typed models, so fields like NetworkPolicy `from` survive serialization.
      const body = loadYaml(stringify({ ...patch, apiVersion: base.apiVersion, kind: base.kind, metadata: { ...((patch.metadata as JsonObject | undefined) ?? {}), ...header.metadata } })) as KubernetesObject;
      const result = await objects.patch(body, undefined, request.dryRun ? "All" : undefined, "podgaze", undefined, PatchStrategy.MergePatch);
      if (request.dryRun) {
        return { applied: false, live: diffYaml(current), yaml: diffYaml(result), message: "The API server accepted this change. Nothing is saved yet.", conflicts };
      }
      return { applied: true, live: diffYaml(current), yaml: editorYaml(result), message: "Live manifest updated.", conflicts: [] };
    },
    listRelated(ref) {
      return related(ref);
    },
    async listEvents(ref) {
      const entry = catalogEntry(ref.kind);
      const namespace = entry?.namespaced ? ref.namespace || "default" : null;
      const events = await readEvents(api, namespace, ref.kind, ref.name);
      return events
        .map((event) => ({ time: event.time, type: event.type, reason: event.reason, message: event.message, count: event.count, source: event.source }))
        .sort((left, right) => right.time.localeCompare(left.time))
        .slice(0, 50);
    },
    async listWarnings(namespace) {
      const fieldSelector = "type=Warning";
      const list = namespace
        ? await api.listNamespacedEvent({ namespace, fieldSelector, limit: PAGE })
        : await api.listEventForAllNamespaces({ fieldSelector, limit: PAGE });
      return (list.items ?? []).map((event) => {
        const involved = event.involvedObject;
        const known = involved?.kind ? entryForApiKind(involved.kind, involved.apiVersion) : undefined;
        const when = event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp;
        return {
          time: when ? new Date(when as Date | string).toISOString() : "",
          reason: event.reason ?? "",
          message: event.message ?? "",
          count: event.series?.count ?? event.count ?? 1,
          namespace: event.metadata?.namespace ?? "",
          object: known && involved?.name
            ? { kind: known.kind, namespace: known.namespaced ? involved.namespace ?? event.metadata?.namespace ?? null : null, name: involved.name }
            : null,
          objectLabel: involved?.name ? `${involved.kind ?? "Object"}/${involved.name}` : "",
        };
      })
        .sort((left, right) => right.time.localeCompare(left.time))
        .slice(0, 40);
    },
    async checkAccess(ref) {
      const entry = catalogEntry(ref.kind);
      if (!entry) return {};
      const namespace = entry.namespaced ? ref.namespace || "default" : null;
      const group = apiGroup(entry.apiVersion);
      const checks: [AccessVerb, Promise<boolean | undefined>][] = [
        ["delete", can(namespace, "delete", group, entry.plural, undefined, ref.name)],
        ["patch", can(namespace, "patch", group, entry.plural, undefined, ref.name)],
      ];
      if (ref.kind === "Pod") {
        checks.push(["exec", can(namespace, "create", "", "pods", "exec", ref.name)]);
        checks.push(["portforward", can(namespace, "create", "", "pods", "portforward", ref.name)]);
        checks.push(["logs", can(namespace, "get", "", "pods", "log", ref.name)]);
      } else if (entry.group === "Workloads") {
        checks.push(["exec", can(namespace, "create", "", "pods", "exec")]);
        checks.push(["logs", can(namespace, "get", "", "pods", "log")]);
      } else if (ref.kind === "Service") {
        checks.push(["portforward", can(namespace, "create", "", "pods", "portforward")]);
      }
      const access: AccessMap = {};
      for (const [verb, check] of checks) {
        const allowed = await check;
        if (allowed !== undefined) access[verb] = allowed;
      }
      return access;
    },
    async startDebug(request) {
      const pod = await api.readNamespacedPod({ name: request.pod, namespace: request.namespace });
      const taken = new Set((pod.spec?.ephemeralContainers ?? []).map((item) => item.name));
      let name = "";
      do {
        name = `debugger-${Math.random().toString(36).slice(2, 7)}`;
      } while (taken.has(name));
      const container = {
        name,
        image: request.image || "busybox:1.36",
        // A shell with stdin open waits forever, so the container stays up for exec, the way kubectl debug does it.
        command: ["sh"],
        stdin: true,
        tty: true,
        targetContainerName: request.target || undefined,
      };
      const body = pod.spec?.ephemeralContainers?.length
        ? [{ op: "add", path: "/spec/ephemeralContainers/-", value: container }]
        : [{ op: "add", path: "/spec/ephemeralContainers", value: [container] }];
      await api.patchNamespacedPodEphemeralcontainers({ name: request.pod, namespace: request.namespace, body });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const current = await api.readNamespacedPod({ name: request.pod, namespace: request.namespace });
        const status = (current.status?.ephemeralContainerStatuses ?? []).find((item) => item.name === name);
        if (status?.state?.running) return { container: name };
        const waiting = status?.state?.waiting?.reason;
        if (waiting === "ErrImagePull" || waiting === "ImagePullBackOff" || waiting === "InvalidImageName") {
          throw new Error(`Debug image ${container.image} could not be pulled (${waiting}).`);
        }
        if (status?.state?.terminated) throw new Error(`Debug container stopped: ${status.state.terminated.reason ?? "exited"}.`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("The debug container did not start within 90 seconds.");
    },
    async listExecTargets(ref) {
      const namespace = ref.namespace || "default";
      if (ref.kind === "Pod") {
        const pod = await api.readNamespacedPod({ name: ref.name, namespace });
        const target = targetFromPod(pod as PodLike, namespace);
        return target ? [target] : [];
      }
      if (ref.kind === "Deployment") {
        const deployment = await apps.readNamespacedDeployment({ name: ref.name, namespace });
        return podsForSelector(namespace, deployment.spec?.selector);
      }
      if (ref.kind === "DaemonSet") {
        const set = await apps.readNamespacedDaemonSet({ name: ref.name, namespace });
        return podsForSelector(namespace, set.spec?.selector);
      }
      if (ref.kind === "StatefulSet") {
        const set = await apps.readNamespacedStatefulSet({ name: ref.name, namespace });
        return podsForSelector(namespace, set.spec?.selector);
      }
      if (ref.kind === "ReplicaSet") {
        const set = await apps.readNamespacedReplicaSet({ name: ref.name, namespace });
        return podsForSelector(namespace, set.spec?.selector);
      }
      if (ref.kind === "Job") {
        const job = await batch.readNamespacedJob({ name: ref.name, namespace });
        return podsForSelector(namespace, selectorString(job.spec?.selector) ?? `job-name=${ref.name}`);
      }
      if (ref.kind === "CronJob") {
        const jobs = await batch.listNamespacedJob({ namespace });
        const owned = (jobs.items ?? []).filter((job) =>
          (job.metadata?.ownerReferences ?? []).some((owner) => owner.kind === "CronJob" && owner.name === ref.name),
        );
        const groups = await Promise.all(owned.map((job) => {
          const name = job.metadata?.name;
          if (!name) return Promise.resolve([] as ExecTarget[]);
          return podsForSelector(namespace, selectorString(job.spec?.selector) ?? `job-name=${name}`);
        }));
        return groups.flat();
      }
      throw new Error(`Exec is available for pods and workloads, not ${ref.kind}.`);
    },
  };
}
