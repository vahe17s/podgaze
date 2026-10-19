import { useEffect, useRef, useState, type ReactNode } from "react";
import { parse as parseYaml } from "yaml";
import { catalogEntry, canExec, cpuMillicores, memoryBytes, mutatingCommands, type AccessMap, type ClusterClient, type CommandName, type CommandResult, type ContextGuard, type DeploymentRow, type NodeRow, type PodRow, type ResourceKind, type ResourceRef, type ResourceRow } from "@podgaze/contracts";
import { ConfigMapValues } from "./configmap-view";
import { FollowLogs, WorkloadLogs } from "./follow";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { formatAge } from "./format";
import { actionLabel, type MenuAction } from "./menu";
import { PortForward } from "./port-forward";
import { RecentEvents, RelatedObjects } from "./related";
import { SecretValues } from "./secret-view";
import { ExecTerminal } from "./lazy";
import { NodeShellPanel } from "./node-shell";
import { PanelSearchBox, PanelSearchContext } from "./panel-search";
import { lineDiff, type DiffRow } from "./diff";
import { TimelineView, timelineKinds } from "./timeline-view";
import { formatCpu, formatMemory, Sparkline, UsageMeters, usageHistoryKey, useUsage, useUsageHistory } from "./usage";
import { WhatsWrong } from "./whats-wrong";
import { YamlEditor } from "./lazy";
import { yamlIssue } from "./yaml-check";

// Actions that wait for a second click, or for the typed name on a protected context.
type Armed = "delete" | "rollout-restart" | "rollout-undo" | "scale" | "drain" | "apply" | "force-delete" | "evict" | "set-image";

const armedLabels: Record<Armed, string> = {
  delete: "Delete",
  "rollout-restart": "Restart",
  "rollout-undo": "Roll back",
  scale: "Scale",
  drain: "Drain",
  apply: "Apply",
  "force-delete": "Force delete",
  evict: "Evict",
  "set-image": "Set image",
};

// Deleting these takes data or a whole namespace with it, so the name is always typed.
const heavyDeletes = new Set<ResourceKind>(["Namespace", "PersistentVolume", "PersistentVolumeClaim", "Node", "StorageClass", "ClusterRole", "ClusterRoleBinding"]);

const accessFor: Partial<Record<CommandName | "apply", "delete" | "patch">> = {
  delete: "delete",
  "rollout-restart": "patch",
  "rollout-undo": "patch",
  scale: "patch",
  cordon: "patch",
  uncordon: "patch",
  drain: "patch",
  suspend: "patch",
  resume: "patch",
  apply: "patch",
  "force-delete": "delete",
  evict: "delete",
  "set-image": "patch",
  "rollout-pause": "patch",
  "rollout-resume": "patch",
};

type Review = { rows: DiffRow[]; conflicts: string[]; note: string };

type Tab = "summary" | "logs" | "commands" | "yaml" | "terminal" | "timeline";

// The last tab picked by hand comes back for the next object. Terminal is never restored:
// opening a shell in a container should always be a deliberate click.
type IconName = Parameters<typeof Icon>[0]["name"];

const commandIcon: Partial<Record<CommandName | Armed, IconName>> = {
  describe: "eye",
  events: "log",
  logs: "log",
  "logs-previous": "log",
  "rollout-status": "check",
  "rollout-history": "log",
  "rollout-restart": "refresh",
  "rollout-undo": "refresh",
  cordon: "stop",
  uncordon: "check",
  drain: "download",
  trigger: "arrow",
  suspend: "stop",
  resume: "arrow",
  delete: "x",
};

function CommandCard({ title, hint, danger = false, children }: { title: string; hint?: string; danger?: boolean; children: ReactNode }) {
  return (
    <section className={danger ? "cmd-card danger-card" : "cmd-card"} aria-label={title}>
      <header>
        <h4>{title}</h4>
        {hint ? <p>{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

const TAB_KEY = "podgaze.tab";

function rememberedTab(kind: ResourceKind): Tab {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    saved = null;
  }
  if (saved === "logs") return canExec(kind) ? "logs" : "summary";
  if (saved === "timeline") return timelineKinds.includes(kind) ? "timeline" : "summary";
  return saved === "yaml" || saved === "commands" ? saved : "summary";
}

export function Inspector({
  client,
  pod,
  node,
  deployment,
  resource,
  podsOnNode,
  epoch,
  pending,
  terminalToken,
  onPendingHandled,
  nodes,
  usageKey,
  guard = { protected: false, readOnly: false },
  onNavigate = () => undefined,
  onPodsOnNode,
}: {
  client: ClusterClient;
  pod: PodRow | null;
  node: NodeRow | null;
  deployment: DeploymentRow | null;
  resource: ResourceRow | null;
  podsOnNode: number;
  epoch: number;
  pending: { id: number; action: MenuAction } | null;
  terminalToken: number;
  onPendingHandled: () => void;
  nodes: NodeRow[];
  usageKey: string;
  guard?: ContextGuard;
  onNavigate?: (ref: ResourceRef) => void;
  onPodsOnNode?: (node: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const [logs, setLogs] = useState({ key: 0, previous: false });
  const [yaml, setYaml] = useState("");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  // The manifest as it was when editing started. Apply sends only what changed from it.
  const baseRef = useRef<string | null>(null);
  const seenTerminal = useRef(0);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [output, setOutput] = useState<CommandResult | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CommandName | "apply" | "debug" | null>(null);
  const [container, setContainer] = useState("");
  const [replicas, setReplicas] = useState("1");
  const [revision, setRevision] = useState("");
  const [armed, setArmed] = useState<Armed | null>(null);
  const [typed, setTyped] = useState("");
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [commandCopied, setCommandCopied] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [access, setAccess] = useState<AccessMap>({});
  const [debugImage, setDebugImage] = useState("busybox:1.36");
  const [debugTarget, setDebugTarget] = useState("");
  const [debugContainer, setDebugContainer] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [forwardFocus, setForwardFocus] = useState(0);
  const [imageContainers, setImageContainers] = useState<{ name: string; image: string }[]>([]);
  const [imageContainer, setImageContainer] = useState("");
  const [imageValue, setImageValue] = useState("");
  const imageRef = useRef<HTMLInputElement>(null);
  const [panelQuery, setPanelQuery] = useState("");

  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  const ref: ResourceRef | null = pod
    ? { kind: "Pod", namespace: pod.namespace, name: pod.name }
    : deployment
      ? { kind: "Deployment", namespace: deployment.namespace, name: deployment.name }
      : node
        ? { kind: "Node", namespace: null, name: node.name }
        : resource
          ? { kind: resource.kind, namespace: resource.namespace || null, name: resource.name }
          : null;
  const refKey = ref ? `${ref.kind}/${ref.namespace ?? ""}/${ref.name}` : "";
  useEffect(() => {
    setPanelQuery("");
  }, [refKey]);

  function blockedReason(action: CommandName | "apply"): string | null {
    const writes = action === "apply" || mutatingCommands.has(action as CommandName);
    if (writes && guard.readOnly) return "This context is read-only.";
    const verb = accessFor[action];
    if (verb && access[verb] === false) return `Your account cannot ${verb} this ${ref?.kind ?? "object"}.`;
    return null;
  }

  function needsName(action: Armed): boolean {
    if (guard.protected) return true;
    return action === "delete" && ref !== null && heavyDeletes.has(ref.kind);
  }

  function arm(action: Armed) {
    setArmed(action);
    setTyped("");
  }

  function pickTab(next: Tab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Only a convenience.
    }
  }

  async function run(name: CommandName) {
    if (!ref) return;
    setBusy(name);
    setCommandError(null);
    setCommandCopied(false);
    setTab("commands");
    try {
      const count = Number(replicas);
      const wanted = revision.trim() === "" ? undefined : Number(revision);
      const result = await client.runCommand({
        name,
        kind: ref.kind,
        resourceName: ref.name,
        namespace: ref.namespace,
        container: name === "set-image" ? undefined : container || pod?.containers[0]?.name || undefined,
        replicas: name === "scale" ? count : undefined,
        ...(name === "set-image" ? { container: imageContainer || undefined, image: imageValue.trim() } : {}),
        ...(name === "rollout-undo" && wanted !== undefined ? { revision: wanted } : {}),
      });
      setOutput(result);
    } catch (error) {
      setOutput(null);
      setCommandError(error instanceof Error ? error.message : "Command failed");
    } finally {
      setBusy(null);
      setArmed(null);
      setTyped("");
    }
  }

  // First click arms; the second click (or the typed name on a protected context) runs.
  function press(action: Armed) {
    if (armed !== action) {
      arm(action);
      return;
    }
    if (needsName(action)) return;
    confirm(action);
  }

  function confirm(action: Armed) {
    if (action === "apply") void applyManifest();
    else void run(action);
  }

  useEffect(() => {
    if (!pendingNow.current) setTab(ref ? rememberedTab(ref.kind) : "summary");
    setYaml("");
    setDraft("");
    dirtyRef.current = false;
    baseRef.current = null;
    setDirty(false);
    setApplyError(null);
    setApplyNote(null);
    setYamlError(null);
    setOutput(null);
    setCommandError(null);
    setArmed(null);
    setTyped("");
    setReview(null);
    setRevision("");
    setDebugContainer(null);
    setDebugError(null);
    setDebugTarget(pod?.containers[0]?.name ?? "");
    setContainer(pod?.containers[0]?.name ?? "");
    const desired = deployment?.ready.split("/")[1];
    if (desired) setReplicas(desired);
  }, [ref?.kind, ref?.name, ref?.namespace]);

  useEffect(() => {
    if (!ref) return;
    let gone = false;
    setAccess({});
    client.checkAccess(ref).then(
      (found) => {
        if (!gone) setAccess(found ?? {});
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [client, ref?.kind, ref?.name, ref?.namespace]);

  useEffect(() => {
    if (!pending || !ref) return;
    const action = pending.action;
    if ((action === "logs" || action === "logs-previous") && canExec(ref.kind)) {
      setLogs((current) => ({ key: current.key + 1, previous: action === "logs-previous" }));
      setTab("logs");
    } else if (action === "yaml" || action === "exec") setTab(action === "yaml" ? "yaml" : "terminal");
    else if (action === "port-forward") {
      setTab("commands");
      setForwardFocus(pending.id);
    }
    else if (action === "node-shell") setTab("terminal");
    else if (action === "set-image") {
      setTab("commands");
      window.setTimeout(() => imageRef.current?.focus(), 50);
    }
    else if (action === "force-delete" || action === "evict") {
      setTab("commands");
      arm(action);
    }
    else if (action === "timeline") setTab("timeline");
    else if (action === "copy-name" || action === "copy-get" || action === "use-namespace" || action === "open-url" || action === "pods-on-node" || action === "search-logs" || action === "namespace-page") {
      // Handled by the menu itself.
    }
    else if (action === "scale" || action === "delete" || action === "drain" || action === "rollout-undo" || action === "rollout-restart") {
      setTab("commands");
      if (action !== "scale" && action !== "rollout-undo") arm(action);
    } else void run(action);
    onPendingHandled();
  }, [pending?.id]);

  // Set image needs the container names, which only the manifest has for most kinds.
  useEffect(() => {
    if (tab !== "commands" || !ref || !(catalogEntry(ref.kind)?.commands ?? []).includes("set-image")) return;
    let gone = false;
    client.getYaml(ref).then((text) => {
      if (gone) return;
      const manifest = parseYaml(text) as { spec?: { template?: { spec?: { containers?: { name?: string; image?: string }[]; initContainers?: { name?: string; image?: string }[] } } } } | null;
      const podSpec = manifest?.spec?.template?.spec;
      const found = [...(podSpec?.containers ?? []), ...(podSpec?.initContainers ?? [])].map((item) => ({ name: item.name ?? "", image: item.image ?? "" })).filter((item) => item.name);
      setImageContainers(found);
      setImageContainer((current) => (found.some((item) => item.name === current) ? current : found[0]?.name ?? ""));
    }, () => setImageContainers([]));
    return () => {
      gone = true;
    };
  }, [client, tab, ref?.kind, ref?.name, ref?.namespace, epoch]);

  useEffect(() => {
    if (tab !== "yaml" || !ref) return;
    let cancelled = false;
    setYamlError(null);
    client.getYaml(ref).then(
      (text) => {
        if (cancelled) return;
        setYaml(text);
        if (!dirtyRef.current) setDraft(text);
      },
      (error: unknown) => {
        if (!cancelled) setYamlError(error instanceof Error ? error.message : "Could not load YAML");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, tab, ref?.kind, ref?.name, ref?.namespace, epoch, retry]);

  useEffect(() => {
    if (terminalToken === seenTerminal.current) return;
    seenTerminal.current = terminalToken;
    if (terminalToken > 0) setTab("terminal");
  }, [terminalToken]);

  // A dry run first: the API server validates the change and shows what it will really store.
  async function reviewManifest() {
    setApplyError(null);
    setApplyNote(null);
    setBusy("apply");
    try {
      const result = await client.applyYaml({ base: baseRef.current ?? yaml, draft, dryRun: true });
      setReview({ rows: lineDiff(result.live, result.yaml), conflicts: result.conflicts, note: result.message });
    } catch (error) {
      setReview(null);
      setApplyError(error instanceof Error ? error.message : "The API server rejected the manifest");
    } finally {
      setBusy(null);
    }
  }

  async function applyManifest() {
    setApplyError(null);
    setApplyNote(null);
    setBusy("apply");
    try {
      const result = await client.applyYaml({ base: baseRef.current ?? yaml, draft, force: (review?.conflicts.length ?? 0) > 0 });
      if (!result.applied && result.conflicts.length > 0) {
        setReview({ rows: lineDiff(result.live, result.yaml), conflicts: result.conflicts, note: result.message });
        return;
      }
      dirtyRef.current = false;
      baseRef.current = null;
      setDirty(false);
      setReview(null);
      setDraft(result.yaml);
      setYaml(result.yaml);
      setApplyNote(result.message);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "Could not apply the manifest");
    } finally {
      setBusy(null);
      setArmed(null);
      setTyped("");
    }
  }

  async function copyYaml() {
    if (!ref) return;
    setCopyNote(null);
    try {
      const text = dirty || draft ? draft : await client.getYaml(ref);
      if (!text.trim()) throw new Error("Manifest is empty");
      await navigator.clipboard.writeText(text);
      setCopyNote("Copied");
    } catch (error) {
      setCopyNote(error instanceof Error ? error.message : "Could not copy");
    }
  }

  async function copyCommand(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCommandCopied(true);
    } catch {
      setCommandCopied(false);
    }
  }

  async function startDebug() {
    if (!pod) return;
    setBusy("debug");
    setDebugError(null);
    try {
      const started = await client.startDebug({ namespace: pod.namespace, pod: pod.name, target: debugTarget, image: debugImage.trim() });
      setDebugContainer(started.container);
    } catch (error) {
      setDebugError(error instanceof Error ? error.message : "Could not start a debug container");
    } finally {
      setBusy(null);
    }
  }

  const usage = useUsage(client, Boolean(ref), usageKey);
  if (!ref) return null;
  const issue = (draft.trim() || dirty) ? yamlIssue(draft) : null;
  const title = pod?.name ?? deployment?.name ?? node?.name ?? resource?.name ?? "";
  const commandNames = catalogEntry(ref.kind)?.commands ?? [];
  // Logs live in their own tab, so the Commands grid keeps only one-shot reads plus delete.
  // Commands with their own card; the Inspect card takes only read-only ones like describe and events.
  const special = new Set<CommandName>(["scale", "delete", "cordon", "uncordon", "drain", "trigger", "suspend", "resume", "logs", "logs-previous", "set-image", "force-delete", "evict", "rerun"]);
  const inspectCommands = commandNames
    .filter((name) => !name.startsWith("rollout") && !special.has(name))
    .map((name) => ({ name, label: actionLabel(name) }));
  const rolloutCommands = commandNames
    .filter((name) => name === "rollout-status" || name === "rollout-history")
    .map((name) => ({ name, label: actionLabel(name) }));
  const canScale = commandNames.includes("scale");
  const canRestart = commandNames.includes("rollout-restart");
  const canUndo = commandNames.includes("rollout-undo");
  const canDelete = commandNames.includes("delete");
  const nodeOps = ref.kind === "Node" && commandNames.includes("drain");
  const canSetImage = commandNames.includes("set-image");
  const canPause = commandNames.includes("rollout-pause");
  const jobOps = ref.kind === "Job";
  const canEvict = commandNames.includes("evict");
  const canForceDelete = commandNames.includes("force-delete");
  const cronOps = ref.kind === "CronJob";
  const suspended = resource?.columns.suspend === "True";
  const reviewChanged = review?.rows.some((row) => row.kind !== "same") ?? false;
  const armedNeedsName = armed ? needsName(armed) : false;

  const forwardBox = pod ? <PortForward client={client} namespace={pod.namespace} name={pod.name} ports={pod.ports} focusToken={forwardFocus} />
    : deployment ? <PortForward client={client} kind="Deployment" namespace={deployment.namespace} name={deployment.name} ports={[]} focusToken={forwardFocus} />
      : resource?.kind === "Service" ? <PortForward client={client} kind="Service" namespace={resource.namespace} name={resource.name} ports={(resource.columns.ports ?? "").split(",").map((item) => item.trim()).filter(Boolean)} focusToken={forwardFocus} />
        : resource?.kind === "StatefulSet" ? <PortForward client={client} kind="StatefulSet" namespace={resource.namespace} name={resource.name} ports={[]} focusToken={forwardFocus} />
          : null;

  function armButton(action: Armed, label: string, extra?: { className?: string }) {
    const reason = blockedReason(action);
    const ready = armed === action && !needsName(action);
    return (
      <button
        type="button"
        className={["icon-btn", armed === action || action === "delete" || action === "drain" ? "danger" : extra?.className].filter(Boolean).join(" ")}
        disabled={busy !== null || reason !== null}
        title={reason ?? undefined}
        onClick={() => press(action)}
      >
        <Icon name={commandIcon[action] ?? "arrow"} />
        {busy === action ? "Running" : ready ? `${label} now` : label}
      </button>
    );
  }

  function runButton(name: CommandName, label = actionLabel(name)) {
    const reason = blockedReason(name);
    return (
      <button key={name} type="button" className="icon-btn" disabled={busy !== null || reason !== null} title={reason ?? undefined} onClick={() => void run(name)}>
        <Icon name={commandIcon[name] ?? "arrow"} />
        {busy === name ? "Running" : label}
      </button>
    );
  }

  const confirmBar = armed && armedNeedsName && armed !== "apply" ? (
    <form
      className="confirm-bar"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed === ref.name) confirm(armed);
      }}
    >
      <label className="field">
        <span>Type <strong>{ref.name}</strong> to {armedLabels[armed].toLowerCase()}</span>
        <input aria-label="Confirm name" autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} />
      </label>
      <button type="submit" className="danger" disabled={typed !== ref.name || busy !== null}>{armedLabels[armed]} now</button>
      <button type="button" onClick={() => setArmed(null)}>Cancel</button>
    </form>
  ) : null;

  return (
    <aside className={tab === "logs" || tab === "terminal" ? "inspector open fill" : "inspector open"} aria-label={title}>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "summary"} onClick={() => pickTab("summary")}>Summary</button>
        {canExec(ref.kind) ? <button type="button" role="tab" aria-selected={tab === "logs"} onClick={() => pickTab("logs")}>Logs</button> : null}
        {canExec(ref.kind) ? <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => pickTab("terminal")}>Terminal</button> : null}
        {ref.kind === "Node" ? <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => pickTab("terminal")}>Node shell</button> : null}
        {timelineKinds.includes(ref.kind) ? <button type="button" role="tab" aria-selected={tab === "timeline"} onClick={() => pickTab("timeline")}>Timeline</button> : null}
        <button type="button" role="tab" aria-selected={tab === "yaml"} onClick={() => pickTab("yaml")}>YAML</button>
        <button type="button" role="tab" aria-selected={tab === "commands"} onClick={() => pickTab("commands")}>Commands</button>
        {tab === "summary" ? (
          <PanelSearchBox
            value={panelQuery}
            onChange={setPanelQuery}
            placeholder={ref.kind === "Secret" || ref.kind === "ConfigMap" ? "Find keys, related, events" : "Find related objects, events"}
          />
        ) : null}
      </div>
      <PanelSearchContext.Provider value={panelQuery}>
      {tab === "logs" && pod ? <FollowLogs key={`${pod.uid}-${logs.key}`} client={client} pod={pod} initialPrevious={logs.previous} /> : null}
      {tab === "logs" && !pod && canExec(ref.kind) ? <WorkloadLogs key={`${ref.kind}/${ref.namespace}/${ref.name}`} client={client} target={ref} /> : null}
      {tab === "summary" && pod ? <WhatsWrong client={client} pod={pod} /> : null}
      {tab === "summary" && pod ? <PodSummary pod={pod} onNavigate={onNavigate} /> : null}
      {tab === "summary" && pod ? <ResourceUsage usage={usage} usageKey={usageKey} name={pod.name} namespace={pod.namespace} pod={pod} capacityNode={nodes.find((item) => item.name === pod.nodeName) ?? null} /> : null}
      {tab === "summary" && node ? <NodeSummary node={node} podsOnNode={podsOnNode} onPodsOnNode={onPodsOnNode} /> : null}
      {tab === "summary" && node ? <ResourceUsage usage={usage} usageKey={usageKey} name={node.name} namespace="" capacityNode={node} /> : null}
      {tab === "summary" && deployment ? <DeploymentSummary deployment={deployment} /> : null}
      {tab === "summary" && resource ? <ResourceSummary row={resource} /> : null}
      {tab === "summary" && resource?.kind === "Secret" ? <SecretValues key={`${resource.namespace}/${resource.name}`} client={client} cluster={usageKey.slice(0, Math.max(0, usageKey.lastIndexOf(":")))} namespace={resource.namespace} name={resource.name} guard={guard} /> : null}
      {tab === "summary" && resource?.kind === "ConfigMap" ? <ConfigMapValues client={client} target={ref} epoch={epoch} /> : null}
      {tab === "summary" && ref.kind !== "Event" ? <RecentEvents client={client} target={ref} epoch={epoch} /> : null}
      {tab === "summary" ? <RelatedObjects client={client} target={ref} onNavigate={onNavigate} /> : null}
      {tab === "timeline" && timelineKinds.includes(ref.kind) ? <TimelineView client={client} target={ref} epoch={epoch} /> : null}
      {tab === "commands" ? (
        <div className="command-panel">
          {guard.readOnly ? <p className="muted">Read-only context: commands that change the cluster are off.</p> : null}
          {pod && pod.containers.length > 1 ? (
            <label className="field">
              Container
              <select aria-label="Container" value={container} onChange={(event) => setContainer(event.target.value)}>
                {pod.containers.map((item) => (
                  <option key={item.name} value={item.name}>{item.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="cmd-layout">
            <div className="cmd-actions">
              {inspectCommands.length > 0 ? (
                <CommandCard title="Inspect" hint="Read-only, safe on any cluster.">
                  <div className="command-grid">{inspectCommands.map((command) => runButton(command.name, command.label))}</div>
                </CommandCard>
              ) : null}
              {forwardBox ? (
                <CommandCard title="Networking" hint={ref.kind === "Pod" ? "Reach a container port from localhost." : "Each connection goes to a ready pod, so restarts do not break it."}>
                  {forwardBox}
                </CommandCard>
              ) : null}
              {rolloutCommands.length > 0 || canRestart || canScale || canUndo ? (
                <CommandCard title={rolloutCommands.length > 0 || canRestart || canUndo ? "Rollout" : "Scale"}>
                  {rolloutCommands.length > 0 || canRestart ? (
                    <div className="command-grid">
                      {rolloutCommands.map((command) => runButton(command.name, command.label))}
                      {canRestart ? armButton("rollout-restart", "Restart") : null}
                      {canPause ? (deployment?.paused ? runButton("rollout-resume", "Resume rollout") : runButton("rollout-pause", "Pause rollout")) : null}
                    </div>
                  ) : null}
                  {deployment?.paused ? <p className="warn-note">Rollout paused: template changes wait until you resume.</p> : null}
                  {canSetImage ? (
                    <form
                      className="cmd-inline set-image"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!imageValue.trim()) return;
                        if (needsName("set-image")) arm("set-image");
                        else void run("set-image");
                      }}
                    >
                      <label>
                        <span>Container</span>
                        <select aria-label="Container to update" value={imageContainer} onChange={(event) => {
                          setImageContainer(event.target.value);
                          setImageValue("");
                        }}>
                          {imageContainers.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                        </select>
                      </label>
                      <label className="grow">
                        <span>New image <span className="muted mono">{imageContainers.find((item) => item.name === imageContainer)?.image ?? ""}</span></span>
                        <input
                          ref={imageRef}
                          aria-label="New image"
                          placeholder={imageContainers.find((item) => item.name === imageContainer)?.image ?? "registry/app:tag"}
                          value={imageValue}
                          onChange={(event) => setImageValue(event.target.value)}
                          spellCheck={false}
                        />
                      </label>
                      <button type="submit" className="icon-btn" disabled={busy !== null || !imageValue.trim() || blockedReason("set-image") !== null} title={blockedReason("set-image") ?? undefined}>
                        <Icon name="refresh" /> Set image
                      </button>
                    </form>
                  ) : null}
                  {canScale ? (
                    <form
                      className="cmd-inline"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (needsName("scale")) arm("scale");
                        else void run("scale");
                      }}
                    >
                      <label>
                        <span>Replicas</span>
                        <input aria-label="Replicas" inputMode="numeric" value={replicas} onChange={(event) => setReplicas(event.target.value)} />
                      </label>
                      <button type="submit" className="icon-btn" disabled={busy !== null || blockedReason("scale") !== null} title={blockedReason("scale") ?? undefined}>
                        <Icon name="sliders" /> Scale
                      </button>
                    </form>
                  ) : null}
                  {canUndo ? (
                    <div className="cmd-inline">
                      <label>
                        <span>Revision</span>
                        <input aria-label="Revision" inputMode="numeric" placeholder="previous" value={revision} onChange={(event) => setRevision(event.target.value)} />
                      </label>
                      {armButton("rollout-undo", "Roll back")}
                    </div>
                  ) : null}
                </CommandCard>
              ) : null}
              {nodeOps ? (
                <CommandCard title="Scheduling" hint="Drain cordons the node, then evicts its pods. DaemonSet and static pods stay; PodDisruptionBudgets are respected.">
                  <div className="command-grid">
                    {node?.unschedulable ? runButton("uncordon") : runButton("cordon")}
                    {armButton("drain", "Drain")}
                  </div>
                </CommandCard>
              ) : null}
              {jobOps ? (
                <CommandCard title="Job" hint="Run again creates a fresh copy of this Job; the original stays as it is.">
                  <div className="command-grid">
                    {runButton("rerun", "Run again")}
                    {suspended ? runButton("resume") : runButton("suspend")}
                  </div>
                </CommandCard>
              ) : null}
              {canEvict ? (
                <CommandCard title="Move" hint="Evict asks Kubernetes to move the pod politely: PodDisruptionBudgets are respected, and the controller starts a replacement.">
                  <div className="command-grid">{armButton("evict", "Evict")}</div>
                </CommandCard>
              ) : null}
              {cronOps ? (
                <CommandCard title="Schedule">
                  <div className="command-grid">
                    {runButton("trigger")}
                    {suspended ? runButton("resume") : runButton("suspend")}
                  </div>
                </CommandCard>
              ) : null}
              {canDelete ? (
                <CommandCard title="Danger zone" hint={guard.protected ? "Protected cluster: you will type the name to confirm." : "Asks once more before it runs."} danger>
                  <div className="command-grid">
                    {armButton("delete", "Delete")}
                    {canForceDelete ? armButton("force-delete", "Force delete") : null}
                  </div>
                  {canForceDelete ? <p className="muted">Force delete skips the grace period. Use it for pods stuck in Terminating; the container may still be running on its node.</p> : null}
                </CommandCard>
              ) : null}
            </div>
            <div className="cmd-result">
              {confirmBar}
              {commandError ? <p className="problem">{commandError}</p> : null}
              {output ? (
                <div className="command-output">
                  <div className="cmd-head">
                    <p className="cmd-line">$ {output.command}</p>
                    <button type="button" className="icon-btn" aria-label="Copy command" onClick={() => void copyCommand(output.command)}>
                      <Icon name="copy" /> {commandCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre>{output.output}</pre>
                </div>
              ) : (
                <div className="cmd-empty">
                  <Icon name="terminal" />
                  <strong>Output shows here</strong>
                  <span>Run Describe, Events, or a rollout command. You also get the kubectl line to copy.</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {tab === "yaml" ? (
        yamlError ? (
          <div className="yaml-error">
            <p className="problem">{yamlError}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button>
          </div>
        ) : (
          <div className="yaml-editor">
            <div className="exec-bar">
              <button
                type="button"
                className={review?.conflicts.length ? "icon-btn danger" : "icon-btn"}
                disabled={!dirty || Boolean(issue) || busy !== null || (review !== null && !reviewChanged) || blockedReason("apply") !== null}
                title={blockedReason("apply") ?? undefined}
                onClick={() => {
                  if (!review) void reviewManifest();
                  else if (needsName("apply")) arm("apply");
                  else void applyManifest();
                }}
              >
                <Icon name="check" /> {busy === "apply" ? "Checking" : review ? (review.conflicts.length ? "Apply anyway" : "Apply changes") : "Apply"}
              </button>
              <button type="button" className="icon-btn" onClick={() => { dirtyRef.current = false; baseRef.current = null; setDirty(false); setReview(null); setRetry((value) => value + 1); }}><Icon name="refresh" /> Reload</button>
              <button type="button" className="icon-btn" aria-label="Copy YAML" onClick={() => void copyYaml()}><Icon name="copy" /> {copyNote === "Copied" ? "Copied" : "Copy YAML"}</button>
              {applyNote ? <span className="muted">{applyNote}</span> : null}
              {copyNote && copyNote !== "Copied" ? <span className="problem">{copyNote}</span> : null}
            </div>
            {applyError ? <p className="problem">{applyError}</p> : null}
            {issue ? <p className="problem yaml-syntax">{issue.message}</p> : null}
            {review?.conflicts.length ? (
              <p className="problem" role="alert">
                Changed on the server since you started editing: {review.conflicts.join(", ")}. Apply anyway overwrites them; Reload starts from the live object.
              </p>
            ) : null}
            {armed === "apply" && armedNeedsName ? (
              <form
                className="confirm-bar"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (typed === ref.name) void applyManifest();
                }}
              >
                <label className="field">
                  <span>Type <strong>{ref.name}</strong> to apply on a protected context</span>
                  <input aria-label="Confirm name" autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} />
                </label>
                <button type="submit" className="danger" disabled={typed !== ref.name || busy !== null}>Apply now</button>
                <button type="button" onClick={() => setArmed(null)}>Cancel</button>
              </form>
            ) : null}
            {review ? (
              <div className="diff" aria-label="Manifest diff">
                {reviewChanged ? (
                  <>
                    <p className="muted diff-note">{review.note}</p>
                    {review.rows.map((row, index) => (
                      <div key={`${row.kind}-${index}`} className={row.kind}>{row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  "}{row.text}</div>
                    ))}
                  </>
                ) : <p className="muted">No changes to apply.</p>}
              </div>
            ) : null}
            {!yaml && !dirty ? <GazeInline label="Loading the live manifest…" /> : null}
            <YamlEditor
              value={draft}
              onChange={(text) => {
                if (!dirtyRef.current) baseRef.current = yaml;
                dirtyRef.current = true;
                setDirty(true);
                setDraft(text);
                setApplyNote(null);
                setReview(null);
                setArmed(null);
              }}
            />
          </div>
        )
      ) : null}
      {tab === "terminal" && node ? <NodeShellPanel client={client} node={node.name} guard={guard} /> : null}
      {tab === "terminal" && ref && canExec(ref.kind) ? (
        <div className="terminal-tab">
          {guard.readOnly ? <p className="muted">Read-only context: exec is off, because a shell can change anything in the container.</p> : null}
          {!guard.readOnly && access.exec === false ? <p className="problem">Your account cannot exec into pods here.</p> : null}
          {pod && !guard.readOnly ? (
            <form
              className="exec-bar debug-bar"
              onSubmit={(event) => {
                event.preventDefault();
                void startDebug();
              }}
            >
              {debugContainer ? (
                <>
                  <span className="muted">Debug container <strong>{debugContainer}</strong> shares the process namespace of {debugTarget || "the pod"}.</span>
                  <button type="button" className="icon-btn" onClick={() => setDebugContainer(null)}>Back to app container</button>
                </>
              ) : (
                <>
                  <span className="muted" title="For images without a shell. Adds an ephemeral container to the running pod.">No shell in the image?</span>
                  <label className="field">
                    Image
                    <input aria-label="Debug image" value={debugImage} onChange={(event) => setDebugImage(event.target.value)} />
                  </label>
                  {pod.containers.length > 1 ? (
                    <label className="field">
                      Target
                      <select aria-label="Debug target" value={debugTarget} onChange={(event) => setDebugTarget(event.target.value)}>
                        {pod.containers.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <button type="submit" className="icon-btn" disabled={busy !== null || debugImage.trim() === ""}>
                    <Icon name="terminal" /> {busy === "debug" ? "Starting…" : "Debug container"}
                  </button>
                </>
              )}
              {debugError ? <span className="problem">{debugError}</span> : null}
            </form>
          ) : null}
          {guard.readOnly ? null : debugContainer && pod ? (
            <ExecTerminal key={debugContainer} client={client} target={ref} containers={[debugContainer]} />
          ) : (
            <ExecTerminal client={client} target={ref} containers={pod ? pod.containers.map((item) => item.name).filter(Boolean) : null} />
          )}
        </div>
      ) : null}
      </PanelSearchContext.Provider>
    </aside>
  );
}

function KeyFact({ value }: { value: string }) {
  const keys = value.split(",").map((item) => item.trim()).filter(Boolean);
  return (
    <div className="fact-wide">
      <dt>Data</dt>
      <dd>
        {keys.length === 0 ? "—" : (
          <div className="key-cloud">
            {keys.map((key) => <span key={key}>{key}</span>)}
          </div>
        )}
      </dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function ResourceUsage({
  usage,
  usageKey,
  name,
  namespace,
  pod,
  capacityNode,
}: {
  usage: ReturnType<typeof useUsage>;
  usageKey: string;
  name: string;
  namespace: string;
  pod?: PodRow;
  capacityNode: NodeRow | null;
}) {
  const cluster = usageKey.split(":")[0] ?? "";
  const history = useUsageHistory(namespace ? usageHistoryKey(cluster, "pod", name, namespace) : usageHistoryKey(cluster, "node", name));
  const sample = usage?.available
    ? (namespace
      ? usage.pods.find((item) => item.name === name && item.namespace === namespace)
      : usage.nodes.find((item) => item.name === name))
    : null;
  if (!sample) return null;
  const nodeCpu = capacityNode ? cpuMillicores(capacityNode.cpu) : 0;
  const nodeMemory = capacityNode ? memoryBytes(capacityNode.memory) : 0;
  // A pod is measured against its limit when it has one: that is where it gets throttled or killed.
  const cpuLimit = pod?.limits.cpuMillicores ?? 0;
  const memoryLimit = pod?.limits.memoryBytes ?? 0;
  return (
    <div className="usage-block">
      <UsageMeters
        sample={sample}
        cpuCapacity={cpuLimit || nodeCpu}
        memoryCapacity={memoryLimit || nodeMemory}
        cpuOf={pod ? (cpuLimit ? "limit" : "node") : undefined}
        memoryOf={pod ? (memoryLimit ? "limit" : "node") : undefined}
      />
      {pod ? (
        <p className="usage-requests">
          <span>CPU request <strong>{pod.requests.cpuMillicores ? formatCpu(pod.requests.cpuMillicores) : "none"}</strong> · limit <strong>{cpuLimit ? formatCpu(cpuLimit) : "none"}</strong></span>
          <span>Memory request <strong>{pod.requests.memoryBytes ? formatMemory(pod.requests.memoryBytes) : "none"}</strong> · limit <strong>{memoryLimit ? formatMemory(memoryLimit) : "none"}</strong></span>
          {pod.requests.cpuMillicores > 0 && sample.cpuMillicores > pod.requests.cpuMillicores * 1.5 ? <span className="status warn">Using {Math.round((sample.cpuMillicores / pod.requests.cpuMillicores) * 100)}% of its CPU request</span> : null}
          {memoryLimit > 0 && sample.memoryBytes > memoryLimit * 0.9 ? <span className="status bad">Near its memory limit: OOMKill risk</span> : null}
        </p>
      ) : null}
      <div className="usage-trends">
        <span><em>CPU, last {Math.max(1, Math.round((history.length * 15) / 60))} min</em><Sparkline values={history.map((point) => point.cpuMillicores)} label="CPU" format={formatCpu} /></span>
        <span><em>Memory</em><Sparkline values={history.map((point) => point.memoryBytes)} label="Memory" format={formatMemory} /></span>
      </div>
    </div>
  );
}

function OwnerFact({ value, namespace, onNavigate }: { value: string; namespace: string; onNavigate: (ref: ResourceRef) => void }) {
  const [kind, ...rest] = value.split("/");
  const name = rest.join("/");
  const entry = kind ? catalogEntry(kind) : undefined;
  return (
    <div>
      <dt>Controlled by</dt>
      <dd>
        {entry && name ? (
          <button type="button" className="link-btn" onClick={() => onNavigate({ kind: entry.kind, namespace: entry.namespaced ? namespace : null, name })}>{value}</button>
        ) : value || "—"}
      </dd>
    </div>
  );
}

function resourceText(value: PodRow["requests"]): string {
  const parts = [value.cpuMillicores ? `${formatCpu(value.cpuMillicores)} CPU` : "", value.memoryBytes ? `${formatMemory(value.memoryBytes)} memory` : ""].filter(Boolean);
  return parts.join(" · ") || "none set";
}

function PodSummary({ pod, onNavigate }: { pod: PodRow; onNavigate: (ref: ResourceRef) => void }) {
  return (
    <div className="summary">
      <dl className="facts">
        <Fact label="Namespace" value={pod.namespace} />
        <Fact label="Status" value={pod.status} />
        <Fact label="Ready" value={pod.ready} />
        <Fact label="Restarts" value={String(pod.restarts)} />
        {pod.lastExit ? <Fact label="Last exit" value={pod.lastExit} /> : null}
        <Fact label="IP" value={pod.ip} />
        <Fact label="Node" value={pod.nodeName || "Unscheduled"} />
        <Fact label="QoS" value={pod.qos} />
        <Fact label="Requests" value={resourceText(pod.requests)} />
        <Fact label="Limits" value={resourceText(pod.limits)} />
        <OwnerFact value={pod.controlledBy} namespace={pod.namespace} onNavigate={onNavigate} />
        <Fact label="Ports" value={pod.ports.join(", ")} />
        <Fact label="Age" value={formatAge(pod.ageStart)} />
      </dl>
      <h3>Containers</h3>
      <ul className="containers">
        {pod.containers.length === 0 ? <li className="muted">No containers</li> : null}
        {pod.containers.map((container) => (
          <li key={container.name || container.image}>
            <div>
              <strong>{container.name || "container"}</strong>
              <span className={container.ready ? "status ok" : "status bad"}>{container.state}</span>
            </div>
            <p>{container.image}</p>
            <p className="muted">{container.restarts} restarts</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeSummary({ node, podsOnNode, onPodsOnNode }: { node: NodeRow; podsOnNode: number; onPodsOnNode?: (node: string) => void }) {
  return (
    <div className="summary">
      <dl className="facts">
        <Fact label="Status" value={node.status} />
        <Fact label="Roles" value={node.roles.join(", ") || "None"} />
        <Fact label="Internal IP" value={node.internalIP} />
        <Fact label="CPU" value={node.cpu} />
        <Fact label="Memory" value={node.memory} />
        <Fact label="Pod capacity" value={node.podCapacity} />
        {onPodsOnNode ? (
          <div>
            <dt>Pods on node</dt>
            <dd><button type="button" className="link-btn" aria-label={`Show ${podsOnNode} pods on ${node.name}`} onClick={() => onPodsOnNode(node.name)}>{podsOnNode} pods →</button></dd>
          </div>
        ) : <Fact label="Pods on node" value={String(podsOnNode)} />}
        <Fact label="Kubelet" value={node.kubeletVersion} />
        <Fact label="OS" value={node.os} />
        <Fact label="Runtime" value={node.runtime} />
        <Fact label="Age" value={formatAge(node.ageStart)} />
      </dl>
    </div>
  );
}

function ResourceSummary({ row }: { row: ResourceRow }) {
  const columns = new Map((catalogEntry(row.kind)?.columns ?? []).map((column) => [column.key, column]));
  return (
    <div className="summary">
      <dl className="facts">
        {row.namespace ? <Fact label="Namespace" value={row.namespace} /> : null}
        <Fact label="Status" value={row.status} />
        {Object.entries(row.columns).filter(([key]) => columns.has(key)).map(([key, value]) => {
          const column = columns.get(key)!;
          if (key === "keys") return <KeyFact key={key} value={value} />;
          return <Fact key={key} label={column.header} value={column.age ? formatAge(value) : value} />;
        })}
        <Fact label="Age" value={formatAge(row.ageStart)} />
      </dl>
    </div>
  );
}

function DeploymentSummary({ deployment }: { deployment: DeploymentRow }) {
  return (
    <div className="summary">
      <dl className="facts">
        <Fact label="Namespace" value={deployment.namespace} />
        <Fact label="Status" value={deployment.status} />
        <Fact label="Ready" value={deployment.ready} />
        <Fact label="Updated" value={deployment.updated} />
        <Fact label="Available" value={deployment.available} />
        <Fact label="Images" value={deployment.images.join(", ")} />
        <Fact label="Age" value={formatAge(deployment.ageStart)} />
      </dl>
    </div>
  );
}
