import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatAge, statusTone } from "./format";
import { getSettings } from "./settings";

export type TableColumn<T> = {
  key: string;
  header: string;
  width: string;
  cell: (row: T) => string;
  status?: boolean;
  age?: boolean;
  // Hidden until switched on from the column chooser.
  optional?: boolean;
};

type Sort = { key: string; dir: 1 | -1 };

const toneRank = { bad: 0, warn: 1, ok: 2 } as const;

const MIN_COLUMN = 48;
const GAP = 12;
const PAD = 24;

type Widths = Record<string, number>;

function readWidths(tableId: string | undefined): Widths {
  if (!tableId) return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`podgaze.columns.${tableId}`) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= MIN_COLUMN));
  } catch {
    return {};
  }
}

type Shown = Record<string, boolean>;

function readShown(tableId: string | undefined): Shown {
  if (!tableId) return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`podgaze.columns.shown.${tableId}`) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Shown) : {};
  } catch {
    return {};
  }
}

function saveShown(tableId: string | undefined, shown: Shown) {
  if (!tableId) return;
  try {
    localStorage.setItem(`podgaze.columns.shown.${tableId}`, JSON.stringify(shown));
  } catch {
    // Choice lasts until the table closes.
  }
}

function saveWidths(tableId: string | undefined, widths: Widths) {
  if (!tableId) return;
  try {
    if (Object.keys(widths).length === 0) localStorage.removeItem(`podgaze.columns.${tableId}`);
    else localStorage.setItem(`podgaze.columns.${tableId}`, JSON.stringify(widths));
  } catch {
    // Widths last until the table closes.
  }
}

// Dragged columns get fixed pixels; the rest keep their share. The last column always takes what is left.
export function columnTemplate(columns: { key: string; width: string }[], widths: Widths): string {
  return columns.map((column, index) => {
    const fixed = widths[column.key];
    const last = index === columns.length - 1;
    if (fixed) return last ? `minmax(${fixed}px, 1fr)` : `${fixed}px`;
    return `minmax(${MIN_COLUMN}px, ${column.width})`;
  }).join(" ");
}

// Status sorts by severity (failing first), time columns by age, everything else as text with numbers in order.
export function compareCells<T extends { status: string }>(column: TableColumn<T>, left: T, right: T): number {
  if (column.status) {
    const rank = toneRank[statusTone(left.status)] - toneRank[statusTone(right.status)];
    if (rank !== 0) return rank;
  }
  const a = column.cell(left);
  const b = column.cell(right);
  if (column.header === "Age" || column.age) {
    // Youngest first: a later start time means a smaller age.
    return (Date.parse(b) || 0) - (Date.parse(a) || 0);
  }
  if (a === "" && b !== "") return 1;
  if (b === "" && a !== "") return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function ResourceTable<T extends { uid: string; name: string; status: string }>({
  rows,
  columns,
  selectedUid,
  markedUid = null,
  onSelect,
  onContextMenu,
  tableId,
  checked,
  onCheck,
}: {
  // With these, a checkbox column selects rows for bulk actions.
  checked?: Set<string>;
  onCheck?: (uids: string[], on: boolean) => void;
  // Names the stored column widths; each kind keeps its own.
  tableId?: string;
  rows: T[];
  columns: TableColumn<T>[];
  selectedUid: string | null;
  // The row a context menu is open for.
  markedUid?: string | null;
  onSelect: (row: T) => void;
  onContextMenu?: (row: T, x: number, y: number) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [sort, setSort] = useState<Sort | null>(null);
  const [widths, setWidths] = useState<Widths>(() => readWidths(tableId));
  const [shown, setShown] = useState<Shown>(() => readShown(tableId));
  const [chooser, setChooser] = useState(false);
  const lastChecked = useRef<number | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const chooserRef = useRef<HTMLDivElement>(null);
  const selectable = Boolean(checked && onCheck);
  const allColumns = columns;
  columns = allColumns.filter((column) => column.key === "name" || (shown[column.key] ?? !column.optional));

  useEffect(() => {
    setWidths(readWidths(tableId));
    setShown(readShown(tableId));
  }, [tableId]);

  useEffect(() => {
    if (!chooser) return;
    const close = (event: MouseEvent) => {
      if (!chooserRef.current?.contains(event.target as Node)) setChooser(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [chooser]);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((item) => item.key === sort.key) : undefined;
    if (!sort || !column) return rows;
    return [...rows].sort((left, right) => compareCells(column, left, right) * sort.dir);
  }, [rows, columns.map((column) => column.key).join(","), sort]);

  function toggleRow(index: number, range: boolean) {
    if (!onCheck || !checked) return;
    const row = sorted[index];
    if (!row) return;
    const on = !checked.has(row.uid);
    if (range && lastChecked.current !== null) {
      const [from, to] = [Math.min(lastChecked.current, index), Math.max(lastChecked.current, index)];
      onCheck(sorted.slice(from, to + 1).map((item) => item.uid), true);
    } else onCheck([row.uid], on);
    lastChecked.current = index;
  }

  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const element = parentRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = element.clientHeight;
      if (next <= 0) return;
      setHeight((current) => (current > 0 ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 8,
    useFlushSync: false,
  });

  const template = `${selectable ? "22px " : ""}${columnTemplate(columns, widths)} 26px`;
  const allChecked = selectable && sorted.length > 0 && sorted.every((row) => checked!.has(row.uid));
  const someChecked = selectable && !allChecked && sorted.some((row) => checked!.has(row.uid));
  const fixedTotal = columns.every((column) => widths[column.key])
    ? columns.reduce((sum, column) => sum + widths[column.key]!, 0) + GAP * columns.length + PAD + 26 + (selectable ? 22 + GAP : 0)
    : undefined;
  const rowWidth = fixedTotal ? { minWidth: fixedTotal } : {};

  function startResize(event: ReactPointerEvent<HTMLDivElement>, key: string) {
    event.preventDefault();
    event.stopPropagation();
    const head = headRef.current;
    if (!head) return;
    // Only the dragged column gets pixels; the others keep sharing what is left, so the table still fits the window.
    const cell = head.querySelector<HTMLElement>(`[data-col="${key}"]`);
    const frozen: Widths = { ...widths };
    const start = Math.max(MIN_COLUMN, Math.round(cell?.offsetWidth ?? widths[key] ?? 120));
    const startX = event.clientX;
    // Pointer moves are in screen pixels; the interface may be scaled.
    const scale = getSettings().zoom || 1;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    let latest = frozen;
    const move = (ev: PointerEvent) => {
      latest = { ...frozen, [key]: Math.max(MIN_COLUMN, Math.round(start + (ev.clientX - startX) / scale)) };
      setWidths(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      saveWidths(tableId, latest);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function nudge(key: string, delta: number) {
    const cell = headRef.current?.querySelector<HTMLElement>(`[data-col="${key}"]`);
    const next = { ...widths, [key]: Math.max(MIN_COLUMN, Math.round((widths[key] ?? cell?.offsetWidth ?? 120) + delta)) };
    setWidths(next);
    saveWidths(tableId, next);
  }

  function resetWidths() {
    setWidths({});
    saveWidths(tableId, {});
  }
  const virtual = height > 0;
  const items = virtual
    ? virtualizer.getVirtualItems().map((item) => ({ key: sorted[item.index]?.uid ?? String(item.index), start: item.start, row: sorted[item.index] }))
    : sorted.map((row) => ({ key: row.uid, start: 0, row }));

  return (
    <div className="table-scroll" ref={parentRef} role="grid" aria-label="Resources">
      <div className="table-head" ref={headRef} style={{ gridTemplateColumns: template, ...rowWidth }} role="row">
        {selectable ? (
          <span className="th check-cell">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allChecked}
              ref={(element) => {
                if (element) element.indeterminate = someChecked;
              }}
              onChange={() => onCheck!(sorted.map((row) => row.uid), !allChecked)}
            />
          </span>
        ) : null}
        {columns.map((column, index) => {
          const active = sort?.key === column.key ? sort.dir : 0;
          return (
            <div key={column.key} className="th" data-col={column.key}>
            <button
              type="button"
              className="sort-head"
              aria-sort={active === 1 ? "ascending" : active === -1 ? "descending" : "none"}
              title={`Sort by ${column.header}`}
              // Click cycles ascending, descending, then back to the live order.
              onClick={() => setSort(active === 0 ? { key: column.key, dir: 1 } : active === 1 ? { key: column.key, dir: -1 } : null)}
            >
              {column.header}
              <i aria-hidden="true">{active === 1 ? "▲" : active === -1 ? "▼" : ""}</i>
            </button>
            {index < columns.length - 1 ? (
              <div
                className="col-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${column.header} column`}
                title="Drag to resize. Double-click to reset all columns."
                tabIndex={0}
                onPointerDown={(event) => startResize(event, column.key)}
                onDoubleClick={resetWidths}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    nudge(column.key, event.key === "ArrowLeft" ? -16 : 16);
                  }
                }}
              />
            ) : null}
            </div>
          );
        })}
        <div className="th column-chooser" ref={chooserRef}>
          <button type="button" className="chooser-btn" aria-label="Choose columns" aria-expanded={chooser} title="Show or hide columns" onClick={() => setChooser((value) => !value)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
          </button>
          {chooser ? (
            <div className="chooser-pop" role="group" aria-label="Columns">
              <p className="eyebrow">Columns</p>
              {allColumns.map((column) => {
                const visible = column.key === "name" || (shown[column.key] ?? !column.optional);
                return (
                  <label key={column.key} className="check">
                    <input
                      type="checkbox"
                      checked={visible}
                      disabled={column.key === "name"}
                      onChange={() => {
                        const next = { ...shown, [column.key]: !visible };
                        setShown(next);
                        saveShown(tableId, next);
                      }}
                    />
                    {column.header}
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="table-body" role="rowgroup" style={{ height: virtual ? virtualizer.getTotalSize() : undefined }}>
        {items.map((item) => {
          if (!item.row) return null;
          const selected = item.row.uid === selectedUid;
          return (
            <button
              key={item.key}
              type="button"
              role="row"
              aria-selected={selected}
              aria-label={item.row.name}
              className={["table-row", selected ? "selected" : "", item.row.uid === markedUid ? "marked" : ""].filter(Boolean).join(" ")}
              data-virtual={virtual ? "yes" : "no"}
              style={{ gridTemplateColumns: template, ...rowWidth, transform: virtual ? `translateY(${item.start}px)` : undefined }}
              onClick={(event) => {
                if (selectable && (event.ctrlKey || event.metaKey || event.shiftKey)) {
                  event.preventDefault();
                  toggleRow(sorted.indexOf(item.row as T), event.shiftKey);
                  return;
                }
                onSelect(item.row as T);
              }}
              onContextMenu={(event) => {
                if (!onContextMenu) return;
                event.preventDefault();
                onContextMenu(item.row as T, event.clientX, event.clientY);
              }}
            >
              {selectable ? (
                <span
                  className="check-cell"
                  role="checkbox"
                  aria-checked={checked!.has(item.row.uid)}
                  aria-label={`Select ${item.row.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleRow(sorted.indexOf(item.row as T), event.shiftKey);
                  }}
                >
                  <i className={checked!.has(item.row.uid) ? "box on" : "box"} aria-hidden="true" />
                </span>
              ) : null}
              {columns.map((column) => {
                const raw = column.cell(item.row as T);
                const value = column.header === "Age" || column.age ? formatAge(raw, now) : raw;
                if (column.status) {
                  return (
                    <span key={column.key} className={`status ${statusTone((item.row as T).status)}`}>
                      {value}
                    </span>
                  );
                }
                return <span key={column.key}>{value}</span>;
              })}
              <span aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
