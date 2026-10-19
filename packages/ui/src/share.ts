import type { ContextGuard } from "@podgaze/contracts";
import { loadGrouping, saveGrouping, type ClusterGrouping } from "./groups";
import { getSettings, sanitize, updateSettings, type Settings } from "./settings";

// One file a team passes around so everyone sees the same groups, guards, projects, and forward sets.
// It holds names and preferences only: no kubeconfig, no credentials, no Secret values.
export type ShareFile = {
  podgaze: 1;
  exportedAt: string;
  settings?: Partial<Settings>;
  groups?: ClusterGrouping;
  guards?: Record<string, ContextGuard>;
  projects?: Record<string, { name: string; namespaces: string[]; labels: string }[]>;
  forwardSets?: Record<string, { name: string; autoStart: boolean; forwards: unknown[] }[]>;
  logQueries?: { pattern: string; regex: boolean; caseSensitive: boolean }[];
  prices?: Record<string, number>;
  costDiscount?: number;
  storagePrices?: Record<string, number>;
};

export const MAX_LOG_QUERIES = 50;

export type SharePart = "settings" | "groups" | "guards" | "projects" | "forwardSets" | "logQueries" | "prices";

export const partLabels: Record<SharePart, string> = {
  settings: "App settings",
  groups: "Cluster groups",
  guards: "Protected and read-only flags",
  projects: "Projects",
  forwardSets: "Port-forward sets",
  logQueries: "Saved log searches",
  prices: "Node and storage prices, discount",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function buildShareFile(kubeconfigPath: string | null, guards: Record<string, ContextGuard>, now = new Date()): ShareFile {
  const projects = read<Record<string, { id?: string; name: string; namespaces: string[]; labels: string }[]>>("podgaze.projects", {});
  const forwardSets = read<Record<string, { id?: string; name: string; autoStart: boolean; forwards: unknown[] }[]>>("podgaze.forwardSets", {});
  const strip = <T extends { id?: string }>(items: T[]) => items.map(({ id: _id, ...rest }) => rest);
  return {
    podgaze: 1,
    exportedAt: now.toISOString(),
    settings: getSettings(),
    groups: loadGrouping(kubeconfigPath),
    guards,
    projects: Object.fromEntries(Object.entries(projects).map(([cluster, items]) => [cluster, strip(items)])),
    forwardSets: Object.fromEntries(Object.entries(forwardSets).map(([cluster, items]) => [cluster, strip(items)])),
    logQueries: read("podgaze.log-queries", []),
    prices: read("podgaze.prices", {}),
    costDiscount: read("podgaze.costDiscount", 0),
    storagePrices: read("podgaze.storagePrices", {}),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// Keys a file must not be able to use as names: they reach into Object.prototype.
const UNSAFE_KEY = new Set(["__proto__", "constructor", "prototype"]);
const safeEntries = (value: Record<string, unknown>) => Object.entries(value).filter(([key]) => !UNSAFE_KEY.has(key));
const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
// The same name-based default the app uses for a context it has no stored guard for.
const looksLikeProd = (context: string) => /(^|[^a-z])(prod|prd|production|live)([^a-z]|$)/i.test(context);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const numbers = (value: unknown): Record<string, number> => (isObject(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0))
  : {});

// A file from someone else: keep only well-formed parts, so a broken or hostile file can neither crash the import
// halfway nor store data that later crashes a page.
export function parseShareFile(text: string): ShareFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This is not a Podgaze settings file (not JSON).");
  }
  if (!isObject(parsed) || parsed.podgaze !== 1) throw new Error("This is not a Podgaze settings file.");
  const file: ShareFile = { podgaze: 1, exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "" };
  if (isObject(parsed.settings)) file.settings = parsed.settings as Partial<Settings>;
  if (isObject(parsed.groups)) {
    const groups = (Array.isArray(parsed.groups.groups) ? parsed.groups.groups : []).filter((group): group is { id: string; name: string } => isObject(group) && typeof group.id === "string" && typeof group.name === "string");
    const membership = isObject(parsed.groups.membership) ? Object.fromEntries(Object.entries(parsed.groups.membership).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    file.groups = { groups: groups.map(({ id, name }) => ({ id, name })), membership };
  }
  if (isObject(parsed.guards)) {
    file.guards = Object.fromEntries(safeEntries(parsed.guards).filter(([, guard]) => isObject(guard)).map(([cluster, guard]) => {
      const raw = guard as Record<string, unknown>;
      const namespaces = isObject(raw.namespaces) ? Object.fromEntries(Object.entries(raw.namespaces).filter((entry): entry is [string, "readOnly" | "writable"] => entry[1] === "readOnly" || entry[1] === "writable")) : undefined;
      return [cluster, { protected: raw.protected === true, readOnly: raw.readOnly === true, ...(namespaces && Object.keys(namespaces).length ? { namespaces } : {}) }];
    }));
  }
  const perCluster = <T>(value: unknown, item: (raw: Record<string, unknown>) => T | null): Record<string, T[]> | undefined => {
    if (!isObject(value)) return undefined;
    return Object.fromEntries(safeEntries(value).map(([cluster, list]) => [cluster, (Array.isArray(list) ? list : []).flatMap((raw) => {
      const kept = isObject(raw) && typeof raw.name === "string" && raw.name ? item(raw) : null;
      return kept ? [kept] : [];
    })]));
  };
  file.projects = perCluster(parsed.projects, (raw) => ({ name: raw.name as string, namespaces: strings(raw.namespaces), labels: typeof raw.labels === "string" ? raw.labels : "" }));
  file.forwardSets = perCluster(parsed.forwardSets, (raw) => ({
    name: raw.name as string,
    autoStart: raw.autoStart === true,
    forwards: (Array.isArray(raw.forwards) ? raw.forwards : []).filter((forward) => isObject(forward) && typeof forward.kind === "string" && typeof forward.namespace === "string" && typeof forward.name === "string" && Number.isInteger(forward.remotePort) && Number.isInteger(forward.localPort)),
  }));
  if (Array.isArray(parsed.logQueries)) {
    file.logQueries = parsed.logQueries.filter((query): query is { pattern: string; regex: boolean; caseSensitive: boolean } => isObject(query) && typeof query.pattern === "string" && query.pattern !== "").map((query) => ({ pattern: query.pattern, regex: query.regex === true, caseSensitive: query.caseSensitive === true }));
  }
  file.prices = numbers(parsed.prices);
  file.storagePrices = numbers(parsed.storagePrices);
  if (typeof parsed.costDiscount === "number" && parsed.costDiscount >= 0 && parsed.costDiscount <= 95) file.costDiscount = parsed.costDiscount;
  return file;
}

export function partsIn(file: ShareFile): { part: SharePart; count: number }[] {
  const count = (value: unknown): number => {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.values(value).reduce<number>((sum, inner) => sum + (Array.isArray(inner) ? inner.length : 1), 0);
    return 0;
  };
  const found: { part: SharePart; count: number }[] = [];
  if (file.settings) found.push({ part: "settings", count: 1 });
  if (file.groups?.groups?.length) found.push({ part: "groups", count: file.groups.groups.length });
  for (const part of ["guards", "projects", "forwardSets", "logQueries"] as const) {
    const amount = count(file[part]);
    if (amount > 0) found.push({ part, count: amount });
  }
  const priced = count(file.prices) + count(file.storagePrices) + (file.costDiscount ? 1 : 0);
  if (priced > 0) found.push({ part: "prices", count: priced });
  return found;
}

const forwardKey = (forward: unknown) => {
  const item = forward as { kind?: string; namespace?: string; name?: string; remotePort?: number };
  return `${item.kind}/${item.namespace}/${item.name}:${item.remotePort}`;
};

// Same name on both sides: keep everything of yours and add what the file has more of.
function mergeNamed<T extends Record<string, unknown> & { id: string; name: string }>(mine: T, theirs: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...mine };
  if (Array.isArray(mine.namespaces) || Array.isArray(theirs.namespaces)) merged.namespaces = [...new Set([...strings(mine.namespaces), ...strings(theirs.namespaces)])];
  if (typeof mine.labels !== "string" || !mine.labels) merged.labels = typeof theirs.labels === "string" ? theirs.labels : mine.labels ?? "";
  if (Array.isArray(mine.forwards) || Array.isArray(theirs.forwards)) {
    const seen = new Set((Array.isArray(mine.forwards) ? mine.forwards : []).map(forwardKey));
    merged.forwards = [...(Array.isArray(mine.forwards) ? mine.forwards : []), ...(Array.isArray(theirs.forwards) ? theirs.forwards : []).filter((forward) => !seen.has(forwardKey(forward)))];
  }
  return merged as T;
}

// Imports merge: what the file adds by name, existing things with the same name are updated, nothing is deleted.
export async function applyShareFile(file: ShareFile, parts: Set<SharePart>, kubeconfigPath: string | null, setGuard: (clusterId: string, guard: ContextGuard) => Promise<void>, currentGuards: Record<string, ContextGuard> = {}): Promise<string[]> {
  const done: string[] = [];
  if (parts.has("settings") && file.settings) {
    updateSettings(sanitize({ ...getSettings(), ...file.settings }));
    done.push("App settings");
  }
  if (parts.has("groups") && file.groups) {
    const current = loadGrouping(kubeconfigPath);
    const idFor = new Map<string, string>();
    const groups = [...current.groups];
    for (const group of file.groups.groups ?? []) {
      const same = groups.find((item) => item.name === group.name);
      if (same) idFor.set(group.id, same.id);
      else {
        const id = crypto.randomUUID();
        groups.push({ id, name: group.name });
        idFor.set(group.id, id);
      }
    }
    const membership = { ...current.membership };
    for (const [cluster, groupId] of Object.entries(file.groups.membership ?? {})) {
      const mapped = idFor.get(groupId);
      if (mapped) membership[cluster] = mapped;
    }
    saveGrouping(kubeconfigPath, { ...current, groups, membership });
    done.push(`${file.groups.groups?.length ?? 0} cluster groups`);
  }
  if (parts.has("guards") && file.guards) {
    // Safety only ever tightens: a file can turn Protected or Read-only on, never off, and a namespace you made
    // read-only stays read-only.
    let tightened = 0;
    for (const [cluster, guard] of Object.entries(file.guards)) {
      const mine = own(currentGuards, cluster) ?? { protected: looksLikeProd(cluster), readOnly: false };
      // Only read-only namespace exceptions come from the file; a "writable" one would open a namespace on a
      // read-only cluster.
      const namespaces: Record<string, "readOnly" | "writable"> = { ...(mine.namespaces ?? {}) };
      for (const [namespace, value] of Object.entries(guard.namespaces ?? {})) if (value === "readOnly") namespaces[namespace] = "readOnly";
      const next: ContextGuard = { protected: mine.protected || guard.protected, readOnly: mine.readOnly || guard.readOnly, ...(Object.keys(namespaces).length ? { namespaces } : {}) };
      if (JSON.stringify(next) === JSON.stringify({ protected: mine.protected, readOnly: mine.readOnly, ...(mine.namespaces && Object.keys(mine.namespaces).length ? { namespaces: mine.namespaces } : {}) })) continue;
      await setGuard(cluster, next);
      tightened += 1;
    }
    done.push(`Safety flags tightened for ${tightened} contexts`);
  }
  for (const [part, key] of [["projects", "podgaze.projects"], ["forwardSets", "podgaze.forwardSets"]] as const) {
    const incoming = file[part];
    if (!parts.has(part) || !incoming) continue;
    const current = read<Record<string, { id: string; name: string }[]>>(key, {});
    let added = 0;
    for (const [cluster, items] of Object.entries(incoming)) {
      const list = [...(own(current, cluster) ?? [])];
      for (const item of items as { name: string }[]) {
        const index = list.findIndex((existing) => existing.name === item.name);
        if (index >= 0) list[index] = mergeNamed(list[index]! as Record<string, unknown> & { id: string; name: string }, item as Record<string, unknown>);
        else {
          list.push({ ...item, id: crypto.randomUUID() });
          added += 1;
        }
      }
      current[cluster] = list;
    }
    write(key, current);
    done.push(`${partLabels[part]}: ${added} new`);
  }
  if (parts.has("logQueries") && file.logQueries) {
    const current = read<{ pattern: string; regex: boolean; caseSensitive: boolean }[]>("podgaze.log-queries", []);
    const merged = [...current];
    let added = 0;
    for (const query of file.logQueries) {
      if (merged.length >= MAX_LOG_QUERIES) break;
      if (!merged.some((item) => item.pattern === query.pattern && item.regex === query.regex && item.caseSensitive === query.caseSensitive)) {
        merged.push(query);
        added += 1;
      }
    }
    write("podgaze.log-queries", merged);
    done.push(`Saved log searches: ${added} new${merged.length >= MAX_LOG_QUERIES ? ` (the list is full at ${MAX_LOG_QUERIES})` : ""}`);
  }
  if (parts.has("prices") && file.prices) {
    write("podgaze.prices", { ...read<Record<string, number>>("podgaze.prices", {}), ...Object.fromEntries(Object.entries(file.prices).filter(([, value]) => typeof value === "number" && value >= 0)) });
    if (typeof file.costDiscount === "number" && file.costDiscount >= 0 && file.costDiscount <= 95) write("podgaze.costDiscount", file.costDiscount);
    if (file.storagePrices) write("podgaze.storagePrices", { ...read<Record<string, number>>("podgaze.storagePrices", {}), ...Object.fromEntries(Object.entries(file.storagePrices).filter(([, value]) => typeof value === "number" && value >= 0)) });
    done.push("Prices and discount");
  }
  window.dispatchEvent(new Event("podgaze:imported"));
  return done;
}
