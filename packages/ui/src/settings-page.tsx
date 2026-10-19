import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ClusterClient } from "@podgaze/contracts";
import { saveText } from "./download";
import { updateText, useUpdateState } from "./update-notice";
import { Icon } from "./icons";
import { applyShareFile, buildShareFile, parseShareFile, partLabels, partsIn, type ShareFile, type SharePart } from "./share";
import {
  layoutKeys,
  logTailChoices,
  resetSettings,
  scrollbackChoices,
  updateSettings,
  useSettings,
  zoomSteps,
  type Settings,
} from "./settings";

const sections = ["Appearance", "Workspace", "Logs", "Terminal", "Editor", "Kubernetes", "Sharing", "Shortcuts", "About"] as const;
type Section = (typeof sections)[number];

const shortcuts: [string, string][] = [
  ["Ctrl K", "Command palette: jump to any object, kind, namespace, or cluster"],
  ["Ctrl ,", "Open settings"],
  ["Alt ← / Alt →", "Back and forward through what you opened"],
  ["/", "Focus the filter"],
  ["l", "Logs of the selected object"],
  ["s", "Shell into the selected pod"],
  ["y", "YAML of the selected object"],
  ["d / e", "Describe / events"],
  ["Esc", "Clear the selection, close a dialog"],
  ["Ctrl + / Ctrl − / Ctrl 0", "Bigger, smaller, reset interface size"],
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint ? <span className="setting-hint">{hint}</span> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" role="switch" className="setting-switch" aria-label={label} aria-checked={value} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}

function Segments<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segments" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={String(option.value)} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, +(value - step).toFixed(1)))}>−</button>
      <output aria-live="polite">{value}px</output>
      <button type="button" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(Math.min(max, +(value + step).toFixed(1)))}>+</button>
    </div>
  );
}

function Choice<T extends number>({ label, value, options, format, onChange }: { label: string; value: T; options: T[]; format: (value: T) => string; onChange: (value: T) => void }) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value) as T)}>
      {options.map((option) => <option key={option} value={option}>{format(option)}</option>)}
    </select>
  );
}

function UpdatesRows({ client }: { client: ClusterClient }) {
  const state = useUpdateState(client);
  const [checking, setChecking] = useState(false);
  const supported = state && state.status !== "unsupported";
  return (
    <>
      <Row label="Updates" hint={updateText(state)}>
        {state?.status === "ready" ? (
          <button type="button" className="connect" onClick={() => void client.installUpdate()}>Restart to update</button>
        ) : state?.status === "available" && state.releaseUrl ? (
          <a className="connect update-link" href={state.releaseUrl} target="_blank" rel="noreferrer">Release page</a>
        ) : (
          <button type="button" className="ghost icon-btn" disabled={!supported || checking || state?.status === "checking" || state?.status === "downloading"} onClick={() => {
            setChecking(true);
            void client.checkForUpdates().finally(() => setChecking(false));
          }}>
            <Icon name="refresh" /> Check now
          </button>
        )}
      </Row>
      {supported ? (
        <Row label="Check automatically" hint={state?.canInstall ? "Downloads in the background and asks before restarting." : "Tells you when a new version is out; this install updates from the release page."}>
          <Toggle label="Check automatically" value={state?.automatic ?? true} onChange={(enabled) => void client.setAutomaticUpdates(enabled)} />
        </Row>
      ) : null}
    </>
  );
}

// Export and import a team file: groups, guards, projects, forward sets, saved searches, prices, app settings.
function SharingSection({ client, kubeconfigPath }: { client: ClusterClient; kubeconfigPath: string | null }) {
  const [incoming, setIncoming] = useState<ShareFile | null>(null);
  const [picked, setPicked] = useState<Set<SharePart>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function exportFile() {
    setError(null);
    try {
      const guards = await client.getGuards().catch(() => ({}));
      saveText("podgaze-settings.json", `${JSON.stringify(buildShareFile(kubeconfigPath, guards), null, 2)}\n`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export");
    }
  }

  async function readFile(file: File) {
    setError(null);
    setDone(null);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("Could not read the file"));
        reader.readAsText(file);
      });
      const parsed = parseShareFile(text);
      setIncoming(parsed);
      setPicked(new Set(partsIn(parsed).map((item) => item.part)));
    } catch (reason) {
      setIncoming(null);
      setError(reason instanceof Error ? reason.message : "Could not read the file");
    }
  }

  async function importFile() {
    if (!incoming) return;
    setBusy(true);
    try {
      const currentGuards = await client.getGuards().catch(() => ({}));
      setDone(await applyShareFile(incoming, picked, kubeconfigPath, (clusterId, guard) => client.setGuard(clusterId, guard), currentGuards));
      setIncoming(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Row label="Export" hint="Cluster groups, Protected and Read-only flags, projects, port-forward sets, saved log searches, node prices, and these settings. No kubeconfig, credentials, or Secret values.">
        <button type="button" className="ghost icon-btn" onClick={() => void exportFile()}><Icon name="download" /> Export settings file</button>
      </Row>
      <Row label="Import" hint="Adds what you don't have and merges things with the same name. Nothing of yours is removed, and safety flags can only be tightened.">
        <button type="button" className="ghost icon-btn" onClick={() => fileInput.current?.click()}><Icon name="folder" /> Choose file</button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="Settings file to import"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
            event.target.value = "";
          }}
        />
      </Row>
      {error ? <p className="problem" role="alert">{error}</p> : null}
      {incoming ? (
        <div className="share-preview" role="group" aria-label="What to import">
          <p className="muted">Exported {new Date(incoming.exportedAt).toLocaleString()}. Pick what to bring in:</p>
          {partsIn(incoming).map(({ part, count }) => (
            <label key={part} className="check">
              <input
                type="checkbox"
                checked={picked.has(part)}
                onChange={() => setPicked((current) => {
                  const next = new Set(current);
                  if (next.has(part)) next.delete(part);
                  else next.add(part);
                  return next;
                })}
              />
              {partLabels[part]} <span className="muted">{part === "settings" ? "" : count}</span>
            </label>
          ))}
          <div className="context-actions">
            <button type="button" className="connect" disabled={picked.size === 0 || busy} onClick={() => void importFile()}>{busy ? "Importing" : "Import selected"}</button>
            <button type="button" className="ghost" onClick={() => setIncoming(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {done ? <p className="saved-note" role="status">Imported: {done.join(", ")}.</p> : null}
    </>
  );
}

// Application preferences, one section at a time, in the spirit of Freelens' Preferences.
export function SettingsPage({
  client,
  kubeconfigPath,
  onKubeconfigChanged,
  onClose,
}: {
  client: ClusterClient;
  kubeconfigPath: string | null;
  onKubeconfigChanged: () => void;
  onClose: () => void;
}) {
  const settings = useSettings();
  const [section, setSection] = useState<Section>("Appearance");
  const [layoutCleared, setLayoutCleared] = useState(false);
  const [armReset, setArmReset] = useState(false);
  const set = (patch: Partial<Settings>) => updateSettings(patch);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest?.("select")) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-page" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <p className="eyebrow">Preferences</p>
        {sections.map((name) => (
          <button key={name} type="button" className="nav-item" aria-current={section === name ? "page" : undefined} onClick={() => setSection(name)}>
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <section className="settings-body" aria-label={section}>
        <header className="settings-head">
          <h1>{section}</h1>
          <button type="button" className="ghost icon-btn" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
            <Icon name="x" /> Close
          </button>
        </header>

        {section === "Appearance" ? (
          <>
            <Row label="Theme" hint="Match system follows your OS light or dark setting.">
              <Segments label="Theme" value={settings.theme} onChange={(theme) => set({ theme })} options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "Match system" },
              ]} />
            </Row>
            <Row label="Interface size" hint="Also Ctrl + and Ctrl − anywhere, Ctrl 0 to reset.">
              <Segments label="Interface size" value={settings.zoom} onChange={(zoom) => set({ zoom })} options={zoomSteps.map((step) => ({ value: step, label: `${Math.round(step * 100)}%` }))} />
            </Row>
            <Row label="Reduce motion" hint="Stops the gazing logo and other animations.">
              <Toggle label="Reduce motion" value={settings.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
            </Row>
            <Row label="Start screen" hint="Show the Podgaze screen for a moment at launch.">
              <Toggle label="Start screen" value={settings.showSplash} onChange={(showSplash) => set({ showSplash })} />
            </Row>
          </>
        ) : null}

        {section === "Workspace" ? (
          <>
            <Row label="Open on connect" hint="The first view after connecting to a cluster.">
              <Segments label="Open on connect" value={settings.startView} onChange={(startView) => set({ startView })} options={[
                { value: "Pod", label: "Pods" },
                { value: "Overview", label: "Overview" },
              ]} />
            </Row>
            <Row label="Open details on select" hint="Clicking a row opens the details panel. Off: it opens minimized.">
              <Toggle label="Open details on select" value={settings.autoOpenDetails} onChange={(autoOpenDetails) => set({ autoOpenDetails })} />
            </Row>
            <Row label="Alerts" hint="A desktop notification when a pod starts crash-looping or is OOM-killed, or an Argo CD app turns Degraded, in any open cluster.">
              <Toggle label="Alerts" value={settings.alerts} onChange={(alerts) => set({ alerts })} />
            </Row>
            <Row label="Layout" hint="Panel height, sidebar width, column widths, and the last details tab.">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  try {
                    for (const key of layoutKeys) localStorage.removeItem(key);
                    for (const key of Object.keys(localStorage)) if (key.startsWith("podgaze.columns.")) localStorage.removeItem(key);
                  } catch {
                    // Nothing stored, nothing to clear.
                  }
                  setLayoutCleared(true);
                }}
              >
                {layoutCleared ? "Cleared. Applies on next open" : "Reset layout"}
              </button>
            </Row>
          </>
        ) : null}

        {section === "Logs" ? (
          <>
            <Row label="Lines to load" hint="How far back a followed log starts.">
              <Choice label="Lines to load" value={settings.logTail} options={logTailChoices} format={(value) => `Last ${value.toLocaleString()} lines`} onChange={(logTail) => set({ logTail })} />
            </Row>
            <Row label="Wrap long lines" hint="The default; each log view can still switch it.">
              <Toggle label="Wrap long lines" value={settings.logWrap} onChange={(logWrap) => set({ logWrap })} />
            </Row>
          </>
        ) : null}

        {section === "Terminal" ? (
          <>
            <Row label="Font size" hint="Pod shells and the local shell. Applies to new terminals.">
              <Stepper label="Terminal font size" value={settings.terminalFontSize} min={9} max={24} step={1} onChange={(terminalFontSize) => set({ terminalFontSize })} />
            </Row>
            <Row label="Blinking cursor">
              <Toggle label="Blinking cursor" value={settings.terminalCursorBlink} onChange={(terminalCursorBlink) => set({ terminalCursorBlink })} />
            </Row>
            <Row label="Scrollback" hint="Lines kept above the screen.">
              <Choice label="Scrollback" value={settings.terminalScrollback} options={scrollbackChoices} format={(value) => `${value.toLocaleString()} lines`} onChange={(terminalScrollback) => set({ terminalScrollback })} />
            </Row>
            <pre className="settings-preview" style={{ fontSize: settings.terminalFontSize }}>$ kubectl get pods{"\n"}api-7c9f   1/1   Running   0   3d</pre>
          </>
        ) : null}

        {section === "Editor" ? (
          <>
            <Row label="Font size" hint="The YAML editor and diff.">
              <Stepper label="Editor font size" value={settings.editorFontSize} min={9} max={24} step={0.5} onChange={(editorFontSize) => set({ editorFontSize })} />
            </Row>
            <pre className="settings-preview" style={{ fontSize: settings.editorFontSize }}>spec:{"\n"}  replicas: 3{"\n"}  template:{"\n"}    metadata: {"{"} labels: {"{"} app: api {"}"} {"}"}</pre>
          </>
        ) : null}

        {section === "Kubernetes" ? (
          <>
            <Row label="Kubeconfig" hint={kubeconfigPath ?? "Not found yet"}>
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => void client.pickKubeconfig().then((picked) => {
                  if (picked) onKubeconfigChanged();
                })}
              >
                <Icon name="folder" /> Choose file
              </button>
            </Row>
            <Row label="Safety" hint="Contexts with prod, prd, production, or live in the name start Protected. Switch Protected and Read-only per cluster in the sidebar.">
              <span className="muted">Per cluster</span>
            </Row>
            <Row label="Context details" hint="Rename a context, change its default namespace or server from the panel icon on each cluster card at Home.">
              <span className="muted">On Home</span>
            </Row>
          </>
        ) : null}

        {section === "Sharing" ? <SharingSection client={client} kubeconfigPath={kubeconfigPath} /> : null}

        {section === "Shortcuts" ? (
          <dl className="shortcut-list">
            {shortcuts.map(([keys, what]) => (
              <div key={keys}>
                <dt>
                  {keys.split(" / ").map((combo, index) => (
                    <span key={combo}>{index > 0 ? " / " : null}{combo.split(" ").map((key) => <kbd key={key}>{key}</kbd>)}</span>
                  ))}
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {section === "About" ? (
          <>
            <Row label="Podgaze" hint="A desktop Kubernetes IDE.">
              <span className="mono">v{__PODGAZE_VERSION__}</span>
            </Row>
            <UpdatesRows client={client} />
            <Row label="Settings storage" hint="Saved on this computer only. Nothing here touches your kubeconfig.">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (!armReset) {
                    setArmReset(true);
                    return;
                  }
                  resetSettings();
                  setArmReset(false);
                }}
              >
                {armReset ? "Click again to reset" : "Reset all settings"}
              </button>
            </Row>
          </>
        ) : null}
      </section>
    </div>
  );
}
