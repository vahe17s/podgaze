import { parseAllDocuments } from "yaml";
import { lineDiff, type DiffRow } from "./diff";

export type ManifestObject = { key: string; label: string; source: string; text: string };
export type ObjectChange = ManifestObject & { rows: DiffRow[] };
export type ManifestDiff = { added: ManifestObject[]; removed: ManifestObject[]; changed: ObjectChange[]; unchanged: number };

// helm upgrade --dry-run prints hooks, then "MANIFEST:", then the rendered objects, then "NOTES:".
export function renderedManifest(output: string): string | null {
  const start = output.search(/^MANIFEST:\s*$/m);
  if (start < 0) return null;
  const body = output.slice(start).replace(/^MANIFEST:\s*\n/, "");
  const end = body.search(/^NOTES:\s*$/m);
  return end >= 0 ? body.slice(0, end) : body;
}

export function manifestObjects(manifest: string): ManifestObject[] {
  const objects: ManifestObject[] = [];
  for (const chunk of manifest.split(/^---\s*$/m)) {
    const source = /^# Source: (.+)$/m.exec(chunk)?.[1]?.trim() ?? "";
    const text = chunk.replace(/^# Source: .+$/gm, "").trim();
    if (!text) continue;
    let kind = "Object";
    let name = "";
    let namespace = "";
    try {
      const doc = parseAllDocuments(text)[0]?.toJS() as { kind?: string; metadata?: { name?: string; namespace?: string } } | null;
      kind = doc?.kind ?? kind;
      name = doc?.metadata?.name ?? "";
      namespace = doc?.metadata?.namespace ?? "";
    } catch {
      // Unparseable text still diffs, keyed by its source file.
    }
    const key = name ? `${kind}/${namespace}/${name}` : `source/${source}/${objects.length}`;
    objects.push({ key, label: name ? `${kind} ${name}` : source || "Unnamed object", source, text });
  }
  return objects;
}

// Object by object: what the upgrade adds, removes, and changes, so the change can be read before it is made.
export function manifestDiff(before: string, after: string): ManifestDiff {
  const old = new Map(manifestObjects(before).map((item) => [item.key, item]));
  const next = manifestObjects(after);
  const added: ManifestObject[] = [];
  const changed: ObjectChange[] = [];
  let unchanged = 0;
  for (const item of next) {
    const previous = old.get(item.key);
    old.delete(item.key);
    if (!previous) {
      added.push(item);
      continue;
    }
    const rows = lineDiff(previous.text, item.text);
    if (rows.length === 0) unchanged += 1;
    else changed.push({ ...item, rows });
  }
  return { added, removed: [...old.values()], changed, unchanged };
}
