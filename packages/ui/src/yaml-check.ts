import { YAMLParseError, parse } from "yaml";

// Plain checks with no editor attached, so screens can validate YAML without loading CodeMirror.
export type YamlIssue = { message: string; from: number; to: number };

export function yamlIssue(text: string): YamlIssue | null {
  if (!text.trim()) return { message: "Manifest is empty.", from: 0, to: 0 };
  try {
    const value = parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { message: "Manifest must be a YAML object.", from: 0, to: text.length };
    }
    const manifest = value as { apiVersion?: unknown; kind?: unknown; metadata?: { name?: unknown } };
    if (typeof manifest.apiVersion !== "string" || typeof manifest.kind !== "string" || typeof manifest.metadata?.name !== "string" || manifest.metadata.name === "") {
      return { message: "Manifest needs apiVersion, kind, and metadata.name.", from: 0, to: Math.min(text.length, 1) || 1 };
    }
    return null;
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const [from, to] = error.pos;
      const end = Math.max(to, from + 1);
      return { message: error.message, from, to: Math.min(end, Math.max(text.length, from + 1)) };
    }
    return { message: error instanceof Error ? error.message : "Invalid YAML", from: 0, to: text.length };
  }
}

// A Helm values file: any YAML mapping, or nothing at all.
export function valuesIssue(text: string): YamlIssue | null {
  if (!text.trim()) return null;
  try {
    const value = parse(text);
    if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
      return { message: "Values must be a YAML mapping (key: value).", from: 0, to: text.length };
    }
    return null;
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const [from, to] = error.pos;
      return { message: error.message, from, to: Math.min(Math.max(to, from + 1), Math.max(text.length, from + 1)) };
    }
    return { message: error instanceof Error ? error.message : "Invalid YAML", from: 0, to: text.length };
  }
}
