import { useEffect, useId, useRef, useState } from "react";

export type PickOption = { value: string; label: string; detail?: string };

// A dropdown with a search box, for lists too long to scroll (dozens of contexts or namespaces).
export function SearchSelect({
  label,
  value,
  options,
  placeholder,
  onPick,
}: {
  label: string;
  value: string;
  options: PickOption[];
  placeholder: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((option) => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle))
    : options;

  useEffect(() => {
    // Cleared on close, so reopening starts on the current item rather than the first match of an old search.
    if (!open) {
      setQuery("");
      return;
    }
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  function choose(option: PickOption | undefined) {
    if (!option) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onPick(option.value);
  }

  return (
    <div className="search-select" ref={root}>
      <span className="search-select-label">{label}</span>
      <button
        ref={trigger}
        type="button"
        className="search-select-trigger"
        aria-label={`Choose ${label.toLowerCase()}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{current?.label ?? value}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
      </button>
      {open ? (
        <div className="search-select-pop">
          <input
            ref={(element) => element?.focus({ preventScroll: true })}
            role="searchbox"
            aria-label={`Find ${label.toLowerCase()}`}
            aria-controls={listId}
            placeholder={placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, Math.max(shown.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(shown[active]);
              }
            }}
          />
          <ul id={listId} ref={list} role="listbox" aria-label={label}>
            {shown.length === 0 ? <li className="search-select-empty">No match</li> : null}
            {shown.map((option, index) => (
              <li
                key={option.value}
                role="option"
                data-index={index}
                aria-selected={option.value === value}
                className={index === active ? "active" : undefined}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {option.detail ? <small>{option.detail}</small> : null}
                {option.value === value ? <i aria-hidden="true">✓</i> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
