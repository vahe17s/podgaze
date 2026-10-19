import { useEffect, useRef, useState } from "react";
import { getSettings } from "./settings";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ClusterClient, ExecTarget, ResourceRef, TerminalEvent, TerminalRequest } from "@podgaze/contracts";
import "@xterm/xterm/css/xterm.css";
import { GazeInline } from "./loader";

function terminalColors() {
  if (document.documentElement.dataset.theme === "light") {
    return { background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#ddf4ff" };
  }
  return { background: "#010409", foreground: "#e6edf3", cursor: "#2f81f7", selectionBackground: "#1c2d4a" };
}

export function TerminalPane({ client, request }: { client: ClusterClient; request: TerminalRequest }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const requestKey = request.mode === "shell" ? "shell" : `${request.namespace}/${request.pod}/${request.container}`;

  useEffect(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || !host) return;
    const term = new Terminal({
      fontFamily: "\"JetBrains Mono\", ui-monospace, monospace",
      fontSize: getSettings().terminalFontSize,
      cursorBlink: getSettings().terminalCursorBlink,
      scrollback: getSettings().terminalScrollback,
      theme: terminalColors(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    let sessionId: string | null = null;
    let closed = false;
    const early: TerminalEvent[] = [];
    const writeEvent = (event: TerminalEvent) => {
      if (event.id !== sessionId) return;
      if (event.type === "data") term.write(event.data);
      if (event.type === "exit") term.write(`\r\n[process exited${event.code === null ? "" : ` ${event.code}`}]\r\n`);
    };
    const stop = client.onTerminal((event) => {
      if (!sessionId) {
        early.push(event);
        return;
      }
      writeEvent(event);
    });
    const input = term.onData((data) => {
      if (sessionId) void client.writeTerminal(sessionId, data);
    });
    let cols = 0;
    let rows = 0;
    let opening = false;
    let fitTimer = 0;
    const publishSize = () => {
      if (!sessionId || term.cols < 2 || term.rows < 2) return;
      if (term.cols === cols && term.rows === rows) return;
      cols = term.cols;
      rows = term.rows;
      void client.resizeTerminal(sessionId, cols, rows);
    };
    const fitNow = () => {
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      if (width < 32 || height < 32) return;
      fit.fit();
      if (!sessionId && !opening) {
        opening = true;
        void client.openTerminal(request).then(
          (session) => {
            if (closed) {
              void client.closeTerminal(session.id);
              return;
            }
            sessionId = session.id;
            for (const event of early) writeEvent(event);
            early.length = 0;
            fit.fit();
            cols = 0;
            rows = 0;
            publishSize();
            term.focus();
          },
          (error: unknown) => {
            term.write(`\r\n${error instanceof Error ? error.message : "Could not open a terminal"}\r\n`);
          },
        );
        return;
      }
      publishSize();
    };
    const scheduleFit = () => {
      window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(fitNow, 120);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => scheduleFit());
    observer?.observe(frame);
    const watchTheme = new MutationObserver(() => {
      term.options.theme = terminalColors();
    });
    watchTheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    fitNow();
    return () => {
      closed = true;
      window.clearTimeout(fitTimer);
      watchTheme.disconnect();
      observer?.disconnect();
      input.dispose();
      stop();
      if (sessionId) void client.closeTerminal(sessionId);
      term.dispose();
    };
  }, [client, requestKey]);

  return (
    <div className="term-host" ref={frameRef}>
      <div className="term-screen" ref={hostRef} />
    </div>
  );
}

export function ExecTerminal({
  client,
  target,
  containers,
}: {
  client: ClusterClient;
  target: ResourceRef;
  containers: string[] | null;
}) {
  const isPod = target.kind === "Pod";
  const [targets, setTargets] = useState<ExecTarget[] | null>(isPod ? [] : null);
  const [error, setError] = useState<string | null>(null);
  const [podName, setPodName] = useState(isPod ? target.name : "");
  const [container, setContainer] = useState(containers?.[0] ?? "");

  useEffect(() => {
    if (isPod) return;
    let cancelled = false;
    setTargets(null);
    setError(null);
    client.listExecTargets(target).then(
      (list) => {
        if (cancelled) return;
        setTargets(list);
        const first = list[0];
        if (first) {
          setPodName(first.pod);
          setContainer(first.containers[0] ?? "");
        }
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not list pods");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, isPod, target.kind, target.name, target.namespace]);

  if (isPod) {
    const names = containers && containers.length > 0 ? containers : ["default"];
    const active = names.includes(container) ? container : names[0];
    return (
      <div className="exec-terminal">
        {names.length > 1 ? (
          <div className="exec-bar">
            <label className="field">
              Container
              <select aria-label="Exec container" value={active} onChange={(event) => setContainer(event.target.value)}>
                {names.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          </div>
        ) : null}
        <TerminalPane client={client} request={{ mode: "exec", namespace: target.namespace || "default", pod: target.name, container: active }} />
      </div>
    );
  }

  const chosen = targets?.find((item) => item.pod === podName) ?? targets?.[0];
  const names = chosen?.containers ?? [];
  const active = names.includes(container) ? container : names[0] ?? "";
  const request: TerminalRequest | null = chosen
    ? { mode: "exec", namespace: chosen.namespace, pod: chosen.pod, container: active || "default" }
    : null;

  if (error) return <p className="problem">{error}</p>;
  if (!targets) return <GazeInline label="Looking for a pod to exec…" />;
  if (!chosen || targets.length === 0 || !request) return <p className="muted">No running pod to exec.</p>;

  return (
    <div className="exec-terminal">
      {targets.length > 1 || names.length > 1 ? (
        <div className="exec-bar">
          {targets.length > 1 ? (
            <label className="field">
              Pod
              <select aria-label="Exec pod" value={chosen.pod} onChange={(event) => {
                const next = targets.find((item) => item.pod === event.target.value);
                setPodName(event.target.value);
                setContainer(next?.containers[0] ?? "");
              }}>
                {targets.map((item) => <option key={item.pod} value={item.pod}>{item.pod}</option>)}
              </select>
            </label>
          ) : null}
          {names.length > 1 ? (
            <label className="field">
              Container
              <select aria-label="Exec container" value={active} onChange={(event) => setContainer(event.target.value)}>
                {names.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      <TerminalPane client={client} request={request} />
    </div>
  );
}
