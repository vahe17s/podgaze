import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ClusterClient, MapNode, ResourceMap, ResourceRef } from "@podgaze/contracts";
import { statusTone } from "./format";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { MapView } from "./map-view";

export type Project = { id: string; name: string; namespaces: string[]; labels: string };

const KEY = "podgaze.projects";
const listeners = new Set<() => void>();

function readAll(): Record<string, Project[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Project[]>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Project[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Projects last until the window closes.
  }
  for (const listener of listeners) listener();
}

export function useProjects(clusterId: string | null) {
  const [projects, setProjects] = useState<Project[]>(() => (clusterId ? readAll()[clusterId] ?? [] : []));
  useEffect(() => {
    const refresh = () => setProjects(clusterId ? readAll()[clusterId] ?? [] : []);
    refresh();
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [clusterId]);
  function save(project: Project) {
    if (!clusterId) return;
    const all = readAll();
    const list = all[clusterId] ?? [];
    writeAll({ ...all, [clusterId]: list.some((item) => item.id === project.id) ? list.map((item) => (item.id === project.id ? project : item)) : [...list, project] });
  }
  function remove(id: string) {
    if (!clusterId) return;
    const all = readAll();
    writeAll({ ...all, [clusterId]: (all[clusterId] ?? []).filter((item) => item.id !== id) });
  }
  return { projects, save, remove };
}

const workloadKinds = new Set(["Deployment", "StatefulSet", "DaemonSet", "CronJob"]);

function summarize(map: ResourceMap) {
  const workloads = map.nodes.filter((node) => workloadKinds.has(node.kind));
  const pods = map.nodes.filter((node) => node.kind === "Pod");
  const failing = map.nodes.filter((node) => node.status && statusTone(node.status) === "bad" && !["Secret", "ConfigMap"].includes(node.kind));
  return {
    workloads: workloads.length,
    healthyWorkloads: workloads.filter((node) => statusTone(node.status) === "ok").length,
    pods: pods.length,
    runningPods: pods.filter((node) => statusTone(node.status) === "ok").length,
    services: map.nodes.filter((node) => node.kind === "Service").length,
    ingresses: map.nodes.filter((node) => node.kind === "Ingress").length,
    failing,
  };
}

// An app view over several namespaces and labels: its health at a glance, what is failing, and its map.
export function ProjectsView({ client, clusterId, namespaces, refreshKey, onNavigate }: {
  client: ClusterClient;
  clusterId: string | null;
  namespaces: string[];
  refreshKey: string;
  onNavigate: (ref: ResourceRef) => void;
}) {
  const { projects, save, remove } = useProjects(clusterId);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const current = projects.find((item) => item.id === open);

  return (
    <div className="projects-view">
      {current ? (
        <ProjectDetail
          client={client}
          project={current}
          refreshKey={refreshKey}
          onBack={() => setOpen(null)}
          onEdit={() => setEditing(current)}
          onNavigate={onNavigate}
        />
      ) : (
        <>
          <div className="helm-toolbar">
            <button type="button" className="connect icon-btn" onClick={() => setEditing({ id: `p${Date.now().toString(36)}`, name: "", namespaces: [], labels: "" })}>
              <Icon name="plus" /> New project
            </button>
            <span className="muted">A project is a set of namespaces, optionally narrowed by labels, seen as one app. Saved on this computer, per cluster.</span>
          </div>
          {projects.length === 0 ? (
            <div className="empty-state">
              <p>No projects yet.</p>
              <p className="muted">Group the namespaces and labels of one app, for example payments-api, payments-worker, and payments-db, and see their health and map together.</p>
            </div>
          ) : (
            <ul className="project-cards">
              {projects.map((project) => (
                <ProjectCard key={project.id} client={client} project={project} refreshKey={refreshKey} onOpen={() => setOpen(project.id)} />
              ))}
            </ul>
          )}
        </>
      )}
      {editing ? (
        <ProjectEditor
          project={editing}
          namespaces={namespaces}
          onCancel={() => setEditing(null)}
          onDelete={projects.some((item) => item.id === editing.id) ? () => {
            remove(editing.id);
            setEditing(null);
            setOpen(null);
          } : undefined}
          onSave={(project) => {
            save(project);
            setEditing(null);
            setOpen(project.id);
          }}
        />
      ) : null}
    </div>
  );
}

function useProjectMap(client: ClusterClient, project: Project, refreshKey: string) {
  const [map, setMap] = useState<ResourceMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    setError(null);
    client.getMap({ namespaces: project.namespaces.length > 0 ? project.namespaces : null, labelSelector: project.labels || undefined }).then(
      (found) => {
        if (!gone) setMap(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read the project");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, project.namespaces.join(","), project.labels, refreshKey]);
  return { map, error };
}

function ProjectCard({ client, project, refreshKey, onOpen }: { client: ClusterClient; project: Project; refreshKey: string; onOpen: () => void }) {
  const { map, error } = useProjectMap(client, project, refreshKey);
  const summary = map ? summarize(map) : null;
  const tone = !summary ? "muted" : summary.failing.length > 0 ? "bad" : summary.healthyWorkloads < summary.workloads ? "warn" : "ok";
  return (
    <li>
      <button type="button" className={`project-card ${tone}`} onClick={onOpen} aria-label={`Open project ${project.name}`}>
        <span className="project-name">{project.name}</span>
        <span className="project-scope mono">{project.namespaces.join(", ") || "all namespaces"}{project.labels ? ` · ${project.labels}` : ""}</span>
        {error ? <span className="problem">{error}</span> : null}
        {!summary && !error ? <GazeInline label="Checking health…" /> : null}
        {summary ? (
          <span className="project-stats">
            <span><strong>{summary.healthyWorkloads}/{summary.workloads}</strong> workloads healthy</span>
            <span><strong>{summary.runningPods}/{summary.pods}</strong> pods running</span>
            <span><strong>{summary.services}</strong> services · <strong>{summary.ingresses}</strong> ingresses</span>
            {summary.failing.length > 0 ? <span className="status bad">{summary.failing.length} failing</span> : <span className="status ok">All good</span>}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ProjectDetail({ client, project, refreshKey, onBack, onEdit, onNavigate }: {
  client: ClusterClient;
  project: Project;
  refreshKey: string;
  onBack: () => void;
  onEdit: () => void;
  onNavigate: (ref: ResourceRef) => void;
}) {
  const { map, error } = useProjectMap(client, project, refreshKey);
  const summary = map ? summarize(map) : null;
  return (
    <div className="project-detail">
      <header className="project-head">
        <button type="button" className="ghost icon-btn" onClick={onBack}>‹ All projects</button>
        <div>
          <h2>{project.name}</h2>
          <p className="muted mono">{project.namespaces.join(", ") || "all namespaces"}{project.labels ? ` · ${project.labels}` : ""}</p>
        </div>
        <button type="button" className="ghost icon-btn" onClick={onEdit}><Icon name="sliders" /> Edit</button>
      </header>
      {error ? <p className="problem">{error}</p> : null}
      {summary ? (
        <div className="project-summary">
          <div className="stat"><span>Workloads</span><strong>{summary.healthyWorkloads}/{summary.workloads}</strong><small>healthy</small></div>
          <div className="stat"><span>Pods</span><strong>{summary.runningPods}/{summary.pods}</strong><small>running</small></div>
          <div className="stat"><span>Services</span><strong>{summary.services}</strong><small>{summary.ingresses} ingresses</small></div>
          <div className={summary.failing.length ? "stat bad" : "stat"}><span>Failing</span><strong>{summary.failing.length}</strong><small>{summary.failing.length ? "need attention" : "nothing"}</small></div>
        </div>
      ) : null}
      {summary && summary.failing.length > 0 ? (
        <ul className="project-failing">
          {summary.failing.slice(0, 12).map((node: MapNode) => (
            <li key={node.id}>
              <button type="button" className="related-link" onClick={() => onNavigate({ kind: node.kind, namespace: node.namespace, name: node.name })}>
                <span className="related-kind">{node.kind}</span>
                <span className="related-name">{node.name}</span>
                <span className="status bad">{node.status}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <MapView
        client={client}
        scope={{ namespaces: project.namespaces.length > 0 ? project.namespaces : null, labelSelector: project.labels || undefined }}
        refreshKey={refreshKey}
        onNavigate={onNavigate}
        compact
      />
    </div>
  );
}

function ProjectEditor({ project, namespaces, onSave, onCancel, onDelete }: {
  project: Project;
  namespaces: string[];
  onSave: (project: Project) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [chosen, setChosen] = useState<string[]>(project.namespaces);
  const [labels, setLabels] = useState(project.labels);
  const [query, setQuery] = useState("");
  const [armDelete, setArmDelete] = useState(false);
  const labelProblem = labels.trim() && labels.split(",").some((part) => !/^\s*[\w./-]+\s*=\s*[\w.-]*\s*$/.test(part)) ? "Use key=value pairs separated by commas." : null;
  const needle = query.trim().toLowerCase();
  const shown = namespaces.filter((namespace) => !needle || namespace.includes(needle));

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section className="context-panel" role="dialog" aria-modal="true" aria-label="Project" onMouseDown={(event) => event.stopPropagation()}>
        <header className="context-head">
          <div>
            <p className="eyebrow">Project</p>
            <h2>{project.name ? `Edit ${project.name}` : "New project"}</h2>
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close project editor" onClick={onCancel}><Icon name="x" /></button>
        </header>
        <form
          className="context-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || labelProblem) return;
            onSave({ ...project, name: name.trim(), namespaces: chosen, labels: labels.trim() });
          }}
        >
          <label className="field">
            Name
            <input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <div className="field">
            <span>Namespaces <span className="muted">({chosen.length ? chosen.length : "none: all namespaces"})</span></span>
            <input role="searchbox" aria-label="Find namespace for project" placeholder="Filter namespaces" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="project-ns-list">
              {shown.map((namespace) => (
                <label key={namespace} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(namespace)}
                    onChange={(event) => setChosen((current) => (event.target.checked ? [...current, namespace] : current.filter((item) => item !== namespace)))}
                  />
                  {namespace}
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            Labels <span className="muted">(optional, e.g. app.kubernetes.io/part-of=payments)</span>
            <input aria-label="Project labels" value={labels} onChange={(event) => setLabels(event.target.value)} spellCheck={false} />
          </label>
          {labelProblem ? <p className="problem">{labelProblem}</p> : null}
          <div className="context-actions">
            <button type="submit" className="connect" disabled={!name.trim() || Boolean(labelProblem)}>Save project</button>
            <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
            {onDelete ? (
              <button type="button" className="danger" onClick={() => (armDelete ? onDelete() : setArmDelete(true))}>{armDelete ? "Click again to delete" : "Delete project"}</button>
            ) : null}
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
