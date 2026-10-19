import { useEffect, useRef } from "react";

type WindowControls = {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
};

declare global {
  interface Window {
    podgazeWindow?: WindowControls;
  }
}

export function Titlebar() {
  const controls = typeof window === "undefined" ? undefined : window.podgazeWindow;
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let timer = 0;
    const onResize = () => {
      bar.style.setProperty("-webkit-app-region", "no-drag");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => bar.style.removeProperty("-webkit-app-region"), 180);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  if (!controls) return null;
  return (
    <header className="titlebar" ref={barRef} onDoubleClick={() => void controls.maximize()}>
      <span className="titlebar-title">Podgaze</span>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => void controls.minimize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
        </button>
        <button type="button" aria-label="Maximize" onClick={() => void controls.maximize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" /></svg>
        </button>
        <button type="button" className="window-close" aria-label="Close" onClick={() => void controls.close()}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>
    </header>
  );
}
