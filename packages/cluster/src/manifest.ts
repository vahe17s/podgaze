import { parse } from "yaml";
import type { KubernetesObject } from "@kubernetes/client-node";

export type LiveManifest = KubernetesObject & {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    resourceVersion?: string;
  };
};

export function readManifest(text: string): LiveManifest {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid YAML");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manifest must be a YAML object.");
  const manifest = value as LiveManifest;
  if (!manifest.apiVersion || !manifest.kind || !manifest.metadata?.name) {
    throw new Error("Manifest needs apiVersion, kind, and metadata.name.");
  }
  return manifest;
}

export type LabelSelector = {
  matchLabels?: Record<string, string> | null;
  matchExpressions?: { key?: string; operator?: string; values?: string[] | null }[] | null;
};

export function matchLabelsSelector(labels: Record<string, string> | undefined | null): string | null {
  return selectorString({ matchLabels: labels });
}

// Builds a label selector query for the API. An empty value is a real label value, so `tier=` is kept.
export function selectorString(selector: LabelSelector | undefined | null): string | null {
  const parts = Object.entries(selector?.matchLabels ?? {})
    .filter((entry) => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`);
  for (const expression of selector?.matchExpressions ?? []) {
    if (!expression.key) continue;
    const values = (expression.values ?? []).join(",");
    if (expression.operator === "In") parts.push(`${expression.key} in (${values})`);
    else if (expression.operator === "NotIn") parts.push(`${expression.key} notin (${values})`);
    else if (expression.operator === "Exists") parts.push(expression.key);
    else if (expression.operator === "DoesNotExist") parts.push(`!${expression.key}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

// Same rules as the API server, for matching pods already in memory. An empty selector matches nothing here.
export function selectorMatches(selector: LabelSelector | undefined | null, labels: Record<string, string> | undefined): boolean {
  const have = labels ?? {};
  const pairs = Object.entries(selector?.matchLabels ?? {});
  const expressions = selector?.matchExpressions ?? [];
  if (pairs.length === 0 && expressions.length === 0) return false;
  for (const [key, value] of pairs) {
    if (have[key] !== value) return false;
  }
  for (const expression of expressions) {
    if (!expression.key) continue;
    const present = Object.prototype.hasOwnProperty.call(have, expression.key);
    const values = expression.values ?? [];
    if (expression.operator === "In" && !(present && values.includes(have[expression.key]!))) return false;
    if (expression.operator === "NotIn" && present && values.includes(have[expression.key]!)) return false;
    if (expression.operator === "Exists" && !present) return false;
    if (expression.operator === "DoesNotExist" && present) return false;
  }
  return true;
}
