export type DiffRow = { kind: "same" | "add" | "remove"; text: string };

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  if (a.length === b.length && a.every((line, index) => line === b[index])) return [];
  if (a.length * b.length > 250_000) return fallback(a, b);
  const next = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      next[i]![j] = a[i] === b[j] ? next[i + 1]![j + 1]! + 1 : Math.max(next[i + 1]![j]!, next[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (next[i + 1]![j]! >= next[i]![j + 1]!) {
      rows.push({ kind: "remove", text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) rows.push({ kind: "remove", text: a[i++]! });
  while (j < b.length) rows.push({ kind: "add", text: b[j++]! });
  return compact(rows);
}

function fallback(before: string[], after: string[]): DiffRow[] {
  const kept = new Set(after);
  const rows: DiffRow[] = [];
  for (const line of before) {
    if (!kept.has(line)) rows.push({ kind: "remove", text: line });
  }
  const had = new Set(before);
  for (const line of after) {
    if (!had.has(line)) rows.push({ kind: "add", text: line });
  }
  return rows;
}

function compact(rows: DiffRow[]): DiffRow[] {
  const keep = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.kind === "same") return;
    for (let i = Math.max(0, index - 2); i <= Math.min(rows.length - 1, index + 2); i += 1) keep[i] = true;
  });
  const out: DiffRow[] = [];
  let skipping = false;
  rows.forEach((row, index) => {
    if (keep[index]) {
      skipping = false;
      out.push(row);
    } else if (!skipping) {
      skipping = true;
      out.push({ kind: "same", text: "…" });
    }
  });
  return out;
}
