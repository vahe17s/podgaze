// The filter box takes a name fragment and label terms together: "api team=shop tier!=cache env in (dev,test)".
export type LabelTerm =
  | { key: string; op: "=" | "!="; value: string }
  | { key: string; op: "in" | "notin"; values: string[] }
  | { key: string; op: "exists" };

export type ParsedFilter = { text: string; labels: LabelTerm[] };

const KEY = "[A-Za-z0-9][A-Za-z0-9._/-]*";
const SET_TERM = new RegExp(`^(${KEY})\\s+(in|notin)\\s+\\(([^)]*)\\)`, "i");
const EQ_TERM = new RegExp(`^(${KEY})\\s*(==|!=|=)\\s*([^\\s,]*)`);

export function parseFilter(input: string): ParsedFilter {
  const labels: LabelTerm[] = [];
  const words: string[] = [];
  let rest = input.trim();
  while (rest.length > 0) {
    const set = SET_TERM.exec(rest);
    if (set) {
      labels.push({ key: set[1]!, op: set[2]!.toLowerCase() as "in" | "notin", values: set[3]!.split(",").map((item) => item.trim()).filter(Boolean) });
      rest = rest.slice(set[0].length).replace(/^[\s,]+/, "");
      continue;
    }
    const eq = EQ_TERM.exec(rest);
    if (eq) {
      const value = eq[3]!;
      labels.push(value === "*" ? { key: eq[1]!, op: "exists" } : { key: eq[1]!, op: eq[2] === "!=" ? "!=" : "=", value });
      rest = rest.slice(eq[0].length).replace(/^[\s,]+/, "");
      continue;
    }
    const word = /^\S+/.exec(rest)![0];
    words.push(word);
    rest = rest.slice(word.length).replace(/^\s+/, "");
  }
  return { text: words.join(" ").toLowerCase(), labels };
}

export function labelsMatch(labels: Record<string, string> | undefined, terms: LabelTerm[]): boolean {
  const values = labels ?? {};
  return terms.every((term) => {
    const has = Object.prototype.hasOwnProperty.call(values, term.key);
    const value = values[term.key];
    if (term.op === "exists") return has;
    if (term.op === "=") return has && value === term.value;
    if (term.op === "!=") return !has || value !== term.value;
    if (term.op === "in") return has && term.values.includes(value!);
    if (term.op === "notin") return !has || !term.values.includes(value!);
    return false;
  });
}

export function matchesFilter(row: { name: string; labels?: Record<string, string> }, filter: ParsedFilter): boolean {
  return (!filter.text || row.name.toLowerCase().includes(filter.text)) && labelsMatch(row.labels, filter.labels);
}

export function labelText(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {}).map(([key, value]) => `${key}=${value}`).join(", ");
}
