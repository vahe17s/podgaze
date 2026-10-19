import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { canExec, catalogEntry, type CommandName, type ResourceKind } from "@podgaze/contracts";
import { canForward } from "./port-forward";

// Everything the row menu can do: kubectl-style commands, panels to open, and small UI helpers.
export type MenuAction =
  | CommandName
  | "yaml"
  | "exec"
  | "port-forward"
  | "node-shell"
  | "pods-on-node"
  | "use-namespace"
  | "open-url"
  | "copy-name"
  | "copy-get"
  | "timeline"
  | "search-logs"
  | "namespace-page";

const labels: Record<MenuAction, string> = {
  describe: "Describe",
  logs: "Logs",
  "logs-previous": "Previous logs",
  events: "Events",
  "rollout-status": "Rollout status",
  "rollout-history": "Rollout history",
  "rollout-restart": "Restart",
  "rollout-undo": "Roll back…",
  "rollout-pause": "Pause rollout",
  "rollout-resume": "Resume rollout",
  scale: "Scale…",
  "set-image": "Set image…",
  cordon: "Cordon",
  uncordon: "Uncordon",
  drain: "Drain…",
  trigger: "Run now",
  rerun: "Run again",
  suspend: "Suspend",
  resume: "Resume",
  evict: "Evict…",
  "force-delete": "Force delete…",
  delete: "Delete…",
  yaml: "Edit YAML",
  exec: "Shell",
  "port-forward": "Port forward…",
  "node-shell": "Node shell",
  "pods-on-node": "Pods on this node",
  "use-namespace": "Switch to this namespace",
  "open-url": "Open in browser",
  "copy-name": "Copy name",
  "copy-get": "Copy kubectl command",
  timeline: "Timeline",
  "search-logs": "Search logs…",
  "namespace-page": "Open namespace page",
};

const hints: Partial<Record<MenuAction, string>> = { logs: "L", exec: "S", yaml: "Y", describe: "D", events: "E" };

const danger = new Set<MenuAction>(["delete", "force-delete", "drain", "evict"]);

export function actionLabel(action: MenuAction): string {
  return labels[action].replace(/…$/, "");
}

// The state that decides between opposite actions: Pause or Resume, Cordon or Uncordon, Suspend or Resume.
export type MenuContext = {
  paused?: boolean;
  suspended?: boolean;
  unschedulable?: boolean;
  url?: string | null;
};

export type MenuSection = { title: string; actions: MenuAction[] };

// The menu for one object, built from what its kind supports and what state it is in. The order follows how
// people use it: look, then act, then copy, then destroy.
export function menuFor(kind: ResourceKind, context: MenuContext = {}): MenuSection[] {
  const commands = new Set<CommandName>(catalogEntry(kind)?.commands ?? []);
  const has = (name: CommandName) => commands.has(name);
  const inspect: MenuAction[] = [];
  if (canExec(kind)) inspect.push("logs");
  if (kind === "Pod" && has("logs-previous")) inspect.push("logs-previous");
  if (canExec(kind)) inspect.push("exec");
  if (canForward(kind)) inspect.push("port-forward");
  if (kind === "Node") inspect.push("node-shell", "pods-on-node");
  if (["Deployment", "StatefulSet", "DaemonSet", "Pod"].includes(kind)) inspect.push("timeline");
  if (["Deployment", "StatefulSet", "DaemonSet"].includes(kind)) inspect.push("search-logs");
  if (has("describe")) inspect.push("describe");
  if (has("events")) inspect.push("events");
  inspect.push("yaml");

  const act: MenuAction[] = [];
  if (kind !== "Pod") {
    if (has("rollout-restart")) act.push("rollout-restart");
    if (has("scale")) act.push("scale");
    if (has("set-image")) act.push("set-image");
    if (has("rollout-pause")) act.push(context.paused ? "rollout-resume" : "rollout-pause");
    if (has("rollout-status")) act.push("rollout-status");
    if (has("rollout-history")) act.push("rollout-history");
    if (has("rollout-undo")) act.push("rollout-undo");
  }
  if (has("trigger")) act.push("trigger");
  if (has("rerun")) act.push("rerun");
  if (has("suspend")) act.push(context.suspended ? "resume" : "suspend");
  if (kind === "Node") act.push(context.unschedulable ? "uncordon" : "cordon");
  if (kind === "Pod" && has("rollout-restart")) act.push("rollout-restart");
  if (kind === "Pod" && has("evict")) act.push("evict");
  if (kind === "Namespace") act.push("namespace-page", "use-namespace");
  if (kind === "Ingress" && context.url) act.push("open-url");

  const destroy: MenuAction[] = [];
  if (has("drain")) destroy.push("drain");
  if (has("delete")) destroy.push("delete");
  if (has("force-delete")) destroy.push("force-delete");

  const sections: MenuSection[] = [
    { title: "Inspect", actions: inspect },
    { title: "Actions", actions: act },
    { title: "Copy", actions: ["copy-name", "copy-get"] },
    { title: "Danger", actions: destroy },
  ];
  return sections.filter((section) => section.actions.length > 0);
}

export function RowMenu({
  x,
  y,
  title,
  sections,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  title?: string;
  sections: MenuSection[];
  onPick: (action: MenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  const flat = sections.flatMap((section) => section.actions);
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    setPlace({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y, sections]);

  useEffect(() => {
    function onPointer(event: MouseEvent) {
      // A row that opens a menu cancels its right-click. In a browser that same event reaches here
      // after this listener is added, and a right-click on another row moves the menu there.
      if (event.type === "contextmenu" && event.defaultPrevented) return;
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        onPick(flat[active]!);
      }
    }
    window.addEventListener("click", onPointer);
    window.addEventListener("contextmenu", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onPointer);
      window.removeEventListener("contextmenu", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, onPick, active, flat.length]);

  let index = -1;
  return (
    <div ref={ref} className="row-menu" role="menu" aria-label={title ? `Actions for ${title}` : "Actions"} style={{ left: place.left, top: place.top }}>
      {title ? <p className="row-menu-title" title={title}>{title}</p> : null}
      {sections.map((section) => (
        <div key={section.title} className="row-menu-section" role="group" aria-label={section.title}>
          {section.actions.map((action) => {
            index += 1;
            const at = index;
            return (
              <button
                key={action}
                type="button"
                role="menuitem"
                aria-keyshortcuts={hints[action]?.toLowerCase()}
                className={[danger.has(action) ? "danger" : "", at === active ? "active" : ""].filter(Boolean).join(" ") || undefined}
                onMouseEnter={() => setActive(at)}
                onClick={(event) => {
                  event.stopPropagation();
                  onPick(action);
                }}
              >
                <span>{labels[action]}</span>
                {hints[action] ? <kbd aria-hidden="true">{hints[action]}</kbd> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
