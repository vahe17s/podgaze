import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { ClusterClient, MapScope, ResourceMap, ResourceRef } from "@podgaze/contracts";
import { statusTone } from "./format";
import { Icon } from "./icons";
import { GazeLoader } from "./loader";
import { edgePath, layoutMap, NODE_H, NODE_W } from "./map-layout";

const kindTone: Record<string, string> = {
  Ingress: "#a371f7",
  "gateways.networking.istio.io": "#a371f7",
  "virtualservices.networking.istio.io": "#bc8cff",
  "destinationrules.networking.istio.io": "#bc8cff",
  Service: "#2f81f7",
  HorizontalPodAutoscaler: "#2f81f7",
  Deployment: "#3fb950",
  StatefulSet: "#3fb950",
  DaemonSet: "#3fb950",
  CronJob: "#3fb950",
  ReplicaSet: "#56d364",
  Job: "#56d364",
  Pod: "#d29922",
  ConfigMap: "#8b949e",
  Secret: "#8b949e",
  PersistentVolumeClaim: "#db61a2",
};

const shortKind: Record<string, string> = {
  "gateways.networking.istio.io": "Istio Gateway",
  "virtualservices.networking.istio.io": "VirtualService",
  "destinationrules.networking.istio.io": "DestinationRule",
  HorizontalPodAutoscaler: "HPA",
  PersistentVolumeClaim: "PVC",
  ConfigMap: "ConfigMap",
};

const configKinds = new Set(["ConfigMap", "Secret", "PersistentVolumeClaim"]);

type View = { scale: number; x: number; y: number };


// How a namespace's objects connect: traffic from Ingress to Pods, ownership, and the config each app reads.
export function MapView({ client, scope, refreshKey, onNavigate, compact = false }: {
  client: ClusterClient;
  scope: MapScope;
  refreshKey: string;
  onNavigate: (ref: ResourceRef) => void;
  compact?: boolean;
}) {
  const [map, setMap] = useState<ResourceMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showPods, setShowPods] = useState(true);
  const [showConfig, setShowConfig] = useState(true);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 24, y: 24 });
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean; pointer: number } | null>(null);
  // Set for one tick after a drag ends, so letting go over an object does not also open it.
  const justDragged = useRef(false);
  const fitted = useRef(false);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let gone = false;
    setError(null);
    client.getMap(scope).then(
      (found) => {
        if (!gone) setMap(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not build the map");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, scopeKey, refreshKey, reload]);

  useEffect(() => {
    fitted.current = false;
  }, [scopeKey, showPods, showConfig]);


  const layout = useMemo(() => {
    if (!map) return null;
    const nodes = map.nodes.filter((node) => (showPods || (node.kind !== "Pod" && node.kind !== "ReplicaSet")) && (showConfig || !configKinds.has(node.kind)));
    const ids = new Set(nodes.map((node) => node.id));
    return layoutMap(nodes, map.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)));
  }, [map, showPods, showConfig]);

  function fit() {
    const box = frame.current;
    if (!box || !layout || layout.width === 0) return;
    const left = Math.min(...layout.groups.map((group) => group.x));
    const right = Math.max(...layout.groups.map((group) => group.x + group.width));
    const width = right - left;
    const scale = Math.min(1.2, Math.max(0.15, Math.min((box.clientWidth - 48) / width, (box.clientHeight - 48) / Math.max(layout.height, 1))));
    setView({ scale, x: 24 - left * scale, y: 24 });
  }

  useEffect(() => {
    if (!layout || fitted.current) return;
    fitted.current = true;
    fit();
  }, [layout]);

  const byId = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout]);
  const needle = query.trim().toLowerCase();
  const matches = (id: string) => !needle || (byId.get(id)?.name.toLowerCase().includes(needle) ?? false);
  const linked = useMemo(() => {
    if (!hover || !layout) return null;
    const set = new Set([hover]);
    for (const edge of layout.edges) {
      if (edge.from === hover) set.add(edge.to);
      if (edge.to === hover) set.add(edge.from);
    }
    return set;
  }, [hover, layout]);

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.min(2.5, Math.max(0.1, view.scale * factor));
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    setView({ scale, x: px - ((px - view.x) / view.scale) * scale, y: py - ((py - view.y) / view.scale) * scale });
  }

  // The pointer is captured only once a drag really starts. Capturing on press would send the click to the
  // canvas instead of the object under the cursor, and objects could not be opened.
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false, pointer: event.pointerId };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      start.moved = true;
      event.currentTarget.setPointerCapture?.(start.pointer);
    }
    if (start.moved) setView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    drag.current = null;
    if (!start?.moved) return;
    if (event.currentTarget.hasPointerCapture?.(start.pointer)) event.currentTarget.releasePointerCapture(start.pointer);
    justDragged.current = true;
    window.setTimeout(() => {
      justDragged.current = false;
    }, 0);
  }

  function open(node: { kind: string; namespace: string | null; name: string }) {
    if (justDragged.current) return;
    onNavigate({ kind: node.kind, namespace: node.namespace, name: node.name });
  }

  if (error) return <p className="empty-state" role="alert">{error}</p>;
  if (!map || !layout) return <GazeLoader label="Drawing the map" detail="Reading workloads, services, and what connects them" />;

  return (
    <div className={compact ? "map-view compact" : "map-view"}>
      <div className="map-toolbar">
        <input role="searchbox" aria-label="Find on map" placeholder="Find on map" value={query} onChange={(event) => setQuery(event.target.value)} />
        <label className="check"><input type="checkbox" checked={showPods} onChange={(event) => setShowPods(event.target.checked)} /> Pods</label>
        <label className="check"><input type="checkbox" checked={showConfig} onChange={(event) => setShowConfig(event.target.checked)} /> Config and storage</label>
        <span className="muted">{layout.groups.length} app{layout.groups.length === 1 ? "" : "s"} · {layout.nodes.length} objects{map.truncated ? " (cut at 2,500)" : ""}</span>
        <span className="head-spacer" />
        <button type="button" className="icon-btn ghost" onClick={fit} title="Fit to window"><Icon name="grid" /> Fit</button>
        <button type="button" className="icon-btn ghost" aria-label="Reload map" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" /></button>
      </div>
      {layout.nodes.length === 0 ? (
        <p className="empty-state">Nothing to draw{scope.namespaces?.length ? ` in ${scope.namespaces.join(", ")}` : ""}.</p>
      ) : (
        <div
          className="map-canvas"
          ref={frame}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
          }}
          role="group"
          aria-roledescription="map"
          aria-label="Resource map"
        >
          <svg width="100%" height="100%">
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {layout.groups.map((group) => (
                <g key={group.group}>
                  <rect className="map-group" x={group.x} y={group.y} width={group.width} height={group.height} rx={10} />
                  <text className="map-group-label" x={group.x + 12} y={group.y + 15}>{group.label}</text>
                </g>
              ))}
              {layout.edges.map((edge) => {
                const from = byId.get(edge.from);
                const to = byId.get(edge.to);
                if (!from || !to) return null;
                const active = linked ? linked.has(edge.from) && linked.has(edge.to) && (edge.from === hover || edge.to === hover) : false;
                const dim = (linked && !active) || (needle && !matches(edge.from) && !matches(edge.to));
                return (
                  <path key={`${edge.from}>${edge.to}`} d={edgePath(from, to)} className={`map-edge${active ? " active" : ""}${dim ? " dim" : ""}${configKinds.has(to.kind) ? " config" : ""}`}>
                    <title>{`${from.name} ${edge.relation} ${to.name}`}</title>
                  </path>
                );
              })}
              {layout.nodes.map((node) => {
                const dim = (linked && !linked.has(node.id)) || (needle && !matches(node.id));
                const tone = node.status ? statusTone(node.status) : "ok";
                return (
                  <g
                    key={node.id}
                    className={`map-node${dim ? " dim" : ""}${hover === node.id ? " hover" : ""}`}
                    transform={`translate(${node.x} ${node.y})`}
                    onPointerEnter={() => setHover(node.id)}
                    onPointerLeave={() => setHover((current) => (current === node.id ? null : current))}
                    onClick={() => open(node)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        open(node);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`${node.kind} ${node.name}`}
                  >
                    <title>{`${node.kind} ${node.name}${node.namespace ? ` · ${node.namespace}` : ""}${node.status ? ` · ${node.status}` : ""}`}</title>
                    <rect width={NODE_W} height={NODE_H} rx={8} className="map-box" />
                    <rect width={4} height={NODE_H - 12} x={6} y={6} rx={2} fill={kindTone[node.kind] ?? "#8b949e"} />
                    <text x={18} y={15} className="map-kind">{shortKind[node.kind] ?? node.kind}</text>
                    <text x={18} y={30} className="map-name">{node.name.length > 26 ? `${node.name.slice(0, 25)}…` : node.name}</text>
                    {/* Config has no health; a Secret's "status" is its type. */}
                    {node.status && !configKinds.has(node.kind) ? <circle cx={NODE_W - 12} cy={12} r={4} className={`map-dot ${tone}`} /> : null}
                  </g>
                );
              })}
            </g>
          </svg>
          <p className="map-hint">Scroll to zoom · drag to move · click an object to open it</p>
        </div>
      )}
    </div>
  );
}
