import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { catalogEntry, type ClusterClient, type ContextGuard, type CreateResult, type ResourceRef } from "@podgaze/contracts";
import { effectiveGuard } from "./guards";
import { Icon } from "./icons";
import { YamlEditor } from "./lazy";
import { yamlIssue } from "./yaml-check";

type Template = { id: string; label: string; yaml: (namespace: string) => string };

const templates: Template[] = [
  {
    id: "Deployment",
    label: "Deployment",
    yaml: (ns) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
  labels:
    app: my-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              memory: 256Mi
`,
  },
  {
    id: "Service",
    label: "Service",
    yaml: (ns) => `apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: ${ns}
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
`,
  },
  {
    id: "ConfigMap",
    label: "ConfigMap",
    yaml: (ns) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: ${ns}
data:
  LOG_LEVEL: info
`,
  },
  {
    id: "Secret",
    label: "Secret",
    yaml: (ns) => `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: ${ns}
type: Opaque
stringData:
  password: change-me
`,
  },
  {
    id: "Job",
    label: "Job",
    yaml: (ns) => `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: ${ns}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ["sh", "-c", "echo hello"]
`,
  },
  {
    id: "CronJob",
    label: "CronJob",
    yaml: (ns) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cron
  namespace: ${ns}
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:1.36
              command: ["sh", "-c", "date"]
`,
  },
  {
    id: "Ingress",
    label: "Ingress",
    yaml: (ns) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: ${ns}
spec:
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80
`,
  },
  {
    id: "Namespace",
    label: "Namespace",
    yaml: () => `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
  },
  { id: "blank", label: "Blank", yaml: () => "" },
];

// New objects from YAML: pick a template or paste a manifest, check it with a server dry run, then create.
export function CreateDialog({
  client,
  namespace,
  guard,
  suggestedKind,
  initialYaml,
  onCreated,
  onClose,
}: {
  client: ClusterClient;
  namespace: string | null;
  guard: ContextGuard;
  suggestedKind?: string;
  // Opens with this manifest instead of a template, e.g. a fix Podgaze suggests.
  initialYaml?: string;
  onCreated: (refs: ResourceRef[]) => void;
  onClose: () => void;
}) {
  const ns = namespace ?? "default";
  const initial = templates.find((item) => item.id === suggestedKind) ?? templates[0]!;
  const [template, setTemplate] = useState(initial.id);
  const [text, setText] = useState(() => initialYaml ?? initial.yaml(ns));
  const [busy, setBusy] = useState<"check" | "create" | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedText, setCheckedText] = useState<string | null>(null);
  const issue = text.trim() ? yamlIssue(text) : null;
  const readOnly = effectiveGuard(guard, ns).readOnly;
  // On a protected cluster, creating takes a passing dry run of exactly this text first.
  const needsCheck = guard.protected && checkedText !== text;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !(event.target as HTMLElement | null)?.closest?.(".cm-editor")) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(dryRun: boolean) {
    setBusy(dryRun ? "check" : "create");
    setError(null);
    setResult(null);
    try {
      const done = await client.createYaml({ yaml: text, dryRun, namespace: ns });
      setResult(done);
      if (dryRun) setCheckedText(text);
      else onCreated(done.created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The API server refused this manifest");
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="context-panel create-dialog" role="dialog" aria-modal="true" aria-label="Create from YAML" onMouseDown={(event) => event.stopPropagation()}>
        <header className="context-head">
          <div>
            <p className="eyebrow">New object</p>
            <h2>Create from YAML</h2>
            <p className="muted">Objects without a namespace go to <strong>{ns}</strong>. Several documents separated by <code>---</code> are created in order.</p>
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close create" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="create-templates" role="radiogroup" aria-label="Template">
          {templates.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={template === item.id}
              onClick={() => {
                setTemplate(item.id);
                setText(item.yaml(ns));
                setResult(null);
                setError(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="create-editor">
          <YamlEditor value={text} onChange={(next) => {
            setText(next);
            setResult(null);
          }} />
        </div>
        {issue ? <p className="problem" role="alert">{issue.message}</p> : null}
        {error ? <p className="problem" role="alert">{error}</p> : null}
        {result ? <p className="saved-note" role="status">{result.message}</p> : null}
        {readOnly ? <p className="warn-note">This namespace is read-only in Podgaze. You can check the manifest, but not create it.</p> : null}
        <footer className="context-actions">
          <button type="button" className="ghost icon-btn" disabled={busy !== null || !text.trim() || Boolean(issue)} onClick={() => void submit(true)}>
            <Icon name="check" /> {busy === "check" ? "Checking" : "Check (dry run)"}
          </button>
          <button
            type="button"
            className="connect icon-btn"
            disabled={busy !== null || !text.trim() || Boolean(issue) || readOnly || needsCheck}
            title={needsCheck ? "Protected cluster: run a check of this exact YAML first" : undefined}
            onClick={() => void submit(false)}
          >
            <Icon name="plus" /> {busy === "create" ? "Creating" : "Create"}
          </button>
          <span className="muted">
            {needsCheck ? "Protected cluster: check first, then create." : "The check sends the manifest with dryRun, so nothing changes."}
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function canOpenCreated(ref: ResourceRef): boolean {
  return Boolean(catalogEntry(ref.kind));
}
