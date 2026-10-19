import type { SecretChange, SecretValue, SecretWrite } from "@podgaze/contracts";

export function decodeSecretData(data: Record<string, string> | undefined): SecretValue[] {
  return Object.keys(data ?? {}).sort().map((key) => {
    const encoded = data?.[key] ?? "";
    const bytes = Buffer.from(encoded, "base64");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000")) return { key, value: "", binary: true, encoded };
      return { key, value: text, binary: false, encoded };
    } catch {
      return { key, value: "", binary: true, encoded };
    }
  });
}

const KEY = /^[-._a-zA-Z0-9]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function secretKeyProblem(key: string): string | null {
  if (!key) return "A key cannot be empty.";
  if (key.length > 253) return `Key ${key.slice(0, 20)}… is longer than 253 characters.`;
  if (!KEY.test(key)) return `Key "${key}" may only use letters, digits, "-", "_", and ".".`;
  return null;
}

// Text is stored as UTF-8 bytes in base64, the way kubectl create secret --from-literal does it.
export function encodeSecretValue(change: SecretChange): string {
  if (change.encoding === "text") return Buffer.from(change.value, "utf8").toString("base64");
  const compact = change.value.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) throw new Error(`The value of "${change.key}" is not valid base64.`);
  return compact;
}

// A JSON merge patch: changed keys get new base64, removed keys become null. The resourceVersion makes the
// API server refuse the patch if someone else changed the Secret after it was read.
export function secretPatch(write: SecretWrite): { metadata: { resourceVersion: string }; data: Record<string, string | null> } {
  const data: Record<string, string | null> = {};
  for (const change of write.set) {
    const problem = secretKeyProblem(change.key);
    if (problem) throw new Error(problem);
    data[change.key] = encodeSecretValue(change);
  }
  for (const key of write.remove) {
    if (write.set.some((change) => change.key === key)) continue;
    data[key] = null;
  }
  if (Object.keys(data).length === 0) throw new Error("There are no changes to save.");
  return { metadata: { resourceVersion: write.resourceVersion }, data };
}

type Meta = { labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: { kind?: string }[] };

export function secretManager(metadata: Meta | undefined): string | undefined {
  const owner = metadata?.ownerReferences?.find((item) => item.kind === "ExternalSecret" || item.kind === "SealedSecret");
  if (owner?.kind === "ExternalSecret") return "External Secrets";
  if (owner?.kind === "SealedSecret") return "Sealed Secrets";
  const annotations = metadata?.annotations ?? {};
  const labels = metadata?.labels ?? {};
  if (annotations["argocd.argoproj.io/tracking-id"] || labels["argocd.argoproj.io/instance"]) return "Argo CD";
  if (labels["app.kubernetes.io/managed-by"] === "Helm") return "Helm";
  if (annotations["kubernetes.io/service-account.name"]) return "Kubernetes (service account token)";
  return undefined;
}
