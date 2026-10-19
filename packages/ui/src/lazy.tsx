import { lazy, Suspense, type ComponentProps } from "react";

// CodeMirror and xterm are most of the app's code. They load the first time an editor or terminal is opened,
// so the window starts without parsing them.
const LazyYamlEditor = lazy(() => import("./yaml-editor").then((module) => ({ default: module.YamlEditor })));
const LazyTerminalPane = lazy(() => import("./terminal").then((module) => ({ default: module.TerminalPane })));
const LazyExecTerminal = lazy(() => import("./terminal").then((module) => ({ default: module.ExecTerminal })));

function Loading({ label }: { label: string }) {
  return <div className="lazy-loading" role="status" aria-label={label} />;
}

export function YamlEditor(props: ComponentProps<typeof LazyYamlEditor>) {
  return (
    <Suspense fallback={<Loading label="Loading the editor" />}>
      <LazyYamlEditor {...props} />
    </Suspense>
  );
}

export function TerminalPane(props: ComponentProps<typeof LazyTerminalPane>) {
  return (
    <Suspense fallback={<Loading label="Loading the terminal" />}>
      <LazyTerminalPane {...props} />
    </Suspense>
  );
}

export function ExecTerminal(props: ComponentProps<typeof LazyExecTerminal>) {
  return (
    <Suspense fallback={<Loading label="Loading the terminal" />}>
      <LazyExecTerminal {...props} />
    </Suspense>
  );
}
