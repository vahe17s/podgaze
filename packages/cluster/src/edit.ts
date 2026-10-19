// Editing a live object sends only what the user changed, like `kubectl edit`.
// A full replace would wipe fields other controllers own and silently undo concurrent changes.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const serverOwned: string[][] = [
  ["status"],
  ["metadata", "managedFields"],
  ["metadata", "resourceVersion"],
  ["metadata", "generation"],
  ["metadata", "uid"],
  ["metadata", "creationTimestamp"],
  ["metadata", "selfLink"],
];

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function drop(target: JsonObject, path: string[]) {
  let node: Json | undefined = target;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node)) return;
    node = node[key];
  }
  if (isObject(node)) delete node[path[path.length - 1]!];
}

// The parts of a manifest a user can edit; server-owned bookkeeping is removed.
export function editable(manifest: unknown): JsonObject {
  const copy = isObject(manifest) ? clone(manifest) : {};
  for (const path of serverOwned) drop(copy, path);
  return copy;
}

export function withoutManagedFields<T>(manifest: T): T {
  const copy = clone(manifest) as unknown;
  if (isObject(copy)) drop(copy, ["metadata", "managedFields"]);
  return copy as T;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!deepEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

type Identity = { apiVersion?: unknown; kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } };

// An edit must stay on the same object. Renaming in the editor used to create a second object.
export function identityProblem(base: Identity, draft: Identity): string | null {
  if (draft.kind !== base.kind) return `Kind changed from ${String(base.kind)} to ${String(draft.kind)}. Edit cannot turn one object into another.`;
  if (draft.apiVersion !== base.apiVersion) return `apiVersion changed from ${String(base.apiVersion)} to ${String(draft.apiVersion)}. Edit keeps the original apiVersion.`;
  if (draft.metadata?.name !== base.metadata?.name) {
    return `Name changed from ${String(base.metadata?.name)} to ${String(draft.metadata?.name)}. Edit does not create or rename objects.`;
  }
  const draftNamespace = draft.metadata?.namespace ?? base.metadata?.namespace;
  if (draftNamespace !== base.metadata?.namespace) {
    return `Namespace changed from ${String(base.metadata?.namespace)} to ${String(draftNamespace)}. Edit does not move objects.`;
  }
  return null;
}

// RFC 7386 merge patch from base to draft. Lists are replaced whole, removed keys become null.
export function mergePatch(base: JsonObject, draft: JsonObject): JsonObject | null {
  const patch: JsonObject = {};
  for (const key of Object.keys(base)) {
    if (!(key in draft)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(draft)) {
    if (!(key in base)) {
      patch[key] = clone(value);
      continue;
    }
    const before = base[key];
    if (deepEqual(before, value)) continue;
    if (isObject(before) && isObject(value)) {
      const nested = mergePatch(before, value);
      if (nested) patch[key] = nested;
    } else {
      patch[key] = clone(value);
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function patchPaths(patch: JsonObject, prefix: string[] = []): string[][] {
  return Object.entries(patch).flatMap(([key, value]) =>
    isObject(value) && Object.keys(value).length > 0 ? patchPaths(value, [...prefix, key]) : [[...prefix, key]],
  );
}

function valueAt(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

// Fields this patch writes that changed on the server after editing started.
export function conflictPaths(patch: JsonObject, base: JsonObject, live: JsonObject): string[] {
  return patchPaths(patch)
    .filter((path) => !deepEqual(valueAt(base, path), valueAt(live, path)))
    .map((path) => path.join("."));
}
