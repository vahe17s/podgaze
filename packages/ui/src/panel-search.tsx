import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

// The search typed into a details panel, shared with the sections inside it (related objects, events, keys).
export const PanelSearchContext = createContext("");

export function usePanelSearch(): string {
  return useContext(PanelSearchContext).trim().toLowerCase();
}

export function matchesSearch(needle: string, ...texts: (string | null | undefined)[]): boolean {
  return !needle || texts.some((text) => (text ?? "").toLowerCase().includes(needle));
}

export function PanelSearchBox({ value, onChange, placeholder, label = "Search in panel" }: { value: string; onChange: (value: string) => void; placeholder: string; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Ctrl+F inside the panel jumps to its search instead of doing nothing.
    const box = ref.current;
    const panel = box?.closest(".inspector, .resizable-panel");
    if (!panel) return;
    const onKey = (event: Event) => {
      const key = event as KeyboardEvent;
      if ((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === "f") {
        key.preventDefault();
        box?.focus();
        box?.select();
      }
    };
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, []);
  return (
    <label className="panel-search">
      <Icon name="search" />
      <input
        ref={ref}
        role="searchbox"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? <button type="button" className="panel-search-clear" aria-label="Clear search" onClick={() => onChange("")}><Icon name="x" /></button> : null}
    </label>
  );
}

// Text with every match marked, for manifests, values, and notes.
export function Highlighted({ text, needle }: { text: string; needle: string }): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  let index = lower.indexOf(needle);
  while (index >= 0) {
    if (index > at) parts.push(text.slice(at, index));
    parts.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    at = index + needle.length;
    index = lower.indexOf(needle, at);
  }
  parts.push(text.slice(at));
  return parts;
}

export function countMatches(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = text.toLowerCase().indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.toLowerCase().indexOf(needle, index + needle.length);
  }
  return count;
}
