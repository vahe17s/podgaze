// Enough of kubectl's JSONPath for CRD printer columns: ".status.phase", ".spec.items[0].name",
// ".status.conditions[?(@.type=="Ready")].status", and ".a.b[*].c".
export function evaluatePath(value: unknown, path: string): string {
  const results = walk([value], tokens(path.trim().replace(/^\{|\}$/g, "")));
  return results
    .filter((item) => item !== undefined && item !== null)
    // A list of plain values (hosts, gateways) reads better as "a, b" than as JSON.
    .map((item) => (Array.isArray(item) && item.every((part) => typeof part !== "object")
      ? item.join(", ")
      : typeof item === "object" ? JSON.stringify(item) : String(item)))
    .join(", ");
}

type Token = { field: string } | { index: number } | { all: true } | { filter: { key: string; equals: string } };

function tokens(path: string): Token[] {
  const out: Token[] = [];
  let rest = path.startsWith("$") ? path.slice(1) : path;
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      const match = /^[^.[]+/.exec(rest);
      if (match) {
        out.push({ field: match[0] });
        rest = rest.slice(match[0].length);
      }
      continue;
    }
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) break;
      const inner = rest.slice(1, end).trim();
      rest = rest.slice(end + 1);
      if (inner === "*") out.push({ all: true });
      else if (/^-?\d+$/.test(inner)) out.push({ index: Number(inner) });
      else if (/^['"].*['"]$/.test(inner)) out.push({ field: inner.slice(1, -1) });
      else {
        const filter = /^\?\(@\.([\w.-]+)\s*==\s*['"]?([^'"]*)['"]?\)$/.exec(inner);
        if (filter) out.push({ filter: { key: filter[1]!, equals: filter[2]! } });
      }
      continue;
    }
    break;
  }
  return out;
}

function walk(values: unknown[], path: Token[]): unknown[] {
  let current = values;
  for (const token of path) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if ("field" in token) {
        if (typeof value === "object") next.push((value as Record<string, unknown>)[token.field]);
      } else if ("index" in token) {
        if (Array.isArray(value)) next.push(value[token.index < 0 ? value.length + token.index : token.index]);
      } else if ("all" in token) {
        if (Array.isArray(value)) next.push(...value);
        else if (typeof value === "object") next.push(...Object.values(value as object));
      } else if (Array.isArray(value)) {
        for (const item of value) {
          const found = walk([item], token.filter.key.split(".").map((field) => ({ field })))[0];
          if (found !== undefined && String(found) === token.filter.equals) next.push(item);
        }
      }
    }
    current = next;
  }
  return current;
}
