import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { getSettings } from "./settings";

function readHeight(key: string, fallback: number): number {
  try {
    const saved = Number(localStorage.getItem(`podgaze.panel.${key}`));
    return saved >= 160 && saved <= 3000 ? saved : fallback;
  } catch {
    return fallback;
  }
}

// A bottom panel with a drag handle on its top edge, like the details dock. The height is remembered per panel.
export function ResizablePanel({ storageKey, label, className = "", children }: { storageKey: string; label: string; className?: string; children: ReactNode }) {
  const [height, setHeight] = useState(() => readHeight(storageKey, 380));
  const ref = useRef<HTMLElement>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const start = ref.current?.offsetHeight ?? height;
    const scale = getSettings().zoom || 1;
    // Leave room for the list above: at least 120px of it stays visible.
    const max = Math.max(200, (ref.current?.parentElement?.clientHeight ?? window.innerHeight) - 120);
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    let latest = start;
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(max, Math.max(160, start + (startY - ev.clientY) / scale)));
      setHeight(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      try {
        localStorage.setItem(`podgaze.panel.${storageKey}`, String(latest));
      } catch {
        // Height resets next time.
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  return (
    <section ref={ref} className={`resizable-panel ${className}`} style={{ height }} aria-label={label}>
      <div className="panel-resize" role="separator" aria-orientation="horizontal" aria-label={`Resize ${label}`} title="Drag to resize" onPointerDown={onPointerDown} />
      <div className="panel-body">{children}</div>
    </section>
  );
}
