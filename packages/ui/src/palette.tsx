import { useEffect, useMemo, useState } from "react";
import { catalog, customKinds, type ClusterSummary, type ResourceKind, type ResourceRef } from "@podgaze/contracts";
import { statusTone } from "./format";

type Action = { id: string; label: string; run: () => void; detail?: string; status?: string };

export type PaletteObject = ResourceRef & { status: string };

const OBJECT_LIMIT = 40;

// Ranks a name match: exact, then prefix, then substring. Lower is better; null means no match.
function rank(name: string, needle: string): number | null {
  const lower = name.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return null;
}

export function CommandPalette({
  clusters,
  namespaces,
  objects = [],
  onOpen,
  onClose,
  onKind,
  onOverview,
  onNamespace,
  onCluster,
  onHome,
  onSettings,
  onBase64,
}: {
  clusters: ClusterSummary[];
  namespaces: string[];
  objects?: PaletteObject[];
  onOpen?: (ref: ResourceRef) => void;
  onClose: () => void;
  onKind: (kind: ResourceKind) => void;
  onOverview: () => void;
  onNamespace: (namespace: string | null) => void;
  onCluster: (id: string) => void;
  onHome?: () => void;
  onSettings?: () => void;
  onBase64?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const actions = useMemo<Action[]>(() => {
    const items: Action[] = [
      ...(onHome ? [{ id: "home", label: "Go home (all clusters)", run: onHome }] : []),
      ...(onSettings ? [{ id: "settings", label: "Open settings", run: onSettings }] : []),
      ...(onBase64 ? [{ id: "base64", label: "Base64 encode / decode", run: onBase64 }] : []),
      { id: "overview", label: "Go to overview", run: onOverview },
      ...catalog.map((item) => ({
        id: item.kind,
        label: `Go to ${item.label.toLowerCase()}`,
        run: () => onKind(item.kind),
      })),
      { id: "tool-map", label: "Go to map (how objects connect)", run: () => onKind("Map") },
      { id: "tool-compare", label: "Compare environments (dev, staging, production)", run: () => onKind("Compare") },
      { id: "tool-images", label: "Go to image versions", run: () => onKind("Images") },
      { id: "tool-certs", label: "Go to certificates (expiry)", run: () => onKind("Certificates") },
      { id: "tool-forwards", label: "Go to port forwards", run: () => onKind("Forwards") },
      { id: "tool-projects", label: "Go to projects", run: () => onKind("Projects") },
      { id: "tool-argo", label: "Go to Argo CD applications", run: () => onKind("Argo") },
      { id: "tool-helm", label: "Go to Helm releases", run: () => onKind("Helm") },
      { id: "tool-activity", label: "Go to activity (change history)", run: () => onKind("Activity") },
      { id: "tool-access", label: "Go to access check (who can)", run: () => onKind("Access") },
      ...customKinds().map((item) => ({
        id: `custom-${item.kind}`,
        label: `Go to ${item.label} (${item.apiGroup})`,
        run: () => onKind(item.kind),
      })),
      { id: "all-ns", label: "Set namespace to all namespaces", run: () => onNamespace(null) },
      ...namespaces.map((namespace) => ({
        id: `ns-${namespace}`,
        label: `Set namespace to ${namespace}`,
        run: () => onNamespace(namespace),
      })),
      ...clusters.filter((cluster) => cluster.usable).map((cluster) => ({
        id: `cluster-${cluster.id}`,
        label: `Connect ${cluster.name}`,
        run: () => onCluster(cluster.id),
      })),
    ];
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    const commands = items.filter((item) => item.label.toLowerCase().includes(needle));
    const found = onOpen
      ? objects
        .map((object) => ({ object, score: rank(object.name, needle) }))
        .filter((item): item is { object: PaletteObject; score: number } => item.score !== null)
        .sort((left, right) => left.score - right.score || left.object.name.localeCompare(right.object.name))
        .slice(0, OBJECT_LIMIT)
        .map(({ object }) => ({
          id: `obj-${object.kind}-${object.namespace ?? ""}-${object.name}`,
          label: object.name,
          detail: `${object.kind}${object.namespace ? ` · ${object.namespace}` : ""}`,
          status: object.status,
          run: () => onOpen({ kind: object.kind, namespace: object.namespace, name: object.name }),
        }))
      : [];
    return [...found, ...commands];
  }, [clusters, namespaces, objects, onCluster, onKind, onNamespace, onOpen, onOverview, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  function choose(action: Action | undefined) {
    if (!action) return;
    action.run();
    onClose();
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Search"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          role="searchbox"
          aria-label="Command"
          placeholder="Find a pod, deployment, node, or any loaded object by name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, Math.max(actions.length - 1, 0)));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Enter") choose(actions[active]);
          }}
        />
        <ul>
          {actions.map((action, index) => (
            <li key={action.id}>
              <button type="button" aria-current={index === active ? "true" : undefined} onClick={() => choose(action)}>
                <span>{action.label}</span>
                {action.detail ? <small className="palette-detail">{action.detail}</small> : null}
                {action.status ? <small className={`status ${statusTone(action.status)}`}>{action.status}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
