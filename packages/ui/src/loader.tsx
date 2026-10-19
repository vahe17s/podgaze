import { Logo } from "./logo";

// Full loading state: the logo searching, with what it is looking for underneath.
export function GazeLoader({ label, detail, size = 64 }: { label: string; detail?: string; size?: number }) {
  return (
    <div className="gaze-loader" role="status" aria-live="polite">
      <Logo size={size} gazing />
      <p className="gaze-label">{label}</p>
      {detail ? <p className="gaze-detail">{detail}</p> : null}
    </div>
  );
}

// One-line version for panels and lists.
export function GazeInline({ label }: { label: string }) {
  return (
    <span className="gaze-inline" role="status" aria-live="polite">
      <Logo size={18} gazing />
      <span>{label}</span>
    </span>
  );
}

export function Splash() {
  return (
    <main className="splash" aria-label="Starting Podgaze">
      <Logo size={104} gazing />
      <h1>Podgaze</h1>
      <p className="splash-tag">Kubernetes, without the terminal hop</p>
      <p className="gaze-detail" role="status">Looking for your clusters…</p>
    </main>
  );
}
