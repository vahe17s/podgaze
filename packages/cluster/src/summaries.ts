import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import type { ClusterSummary } from "@podgaze/contracts";

export function defaultKubeconfigPath(): string {
  if (process.env.KUBECONFIG && process.env.KUBECONFIG.length > 0) return process.env.KUBECONFIG;
  return path.join(os.homedir(), ".kube", "config");
}

export function loadKubeConfig(filePath: string): KubeConfig {
  const kc = new KubeConfig();
  const files = filePath.split(path.delimiter).filter((file) => file.length > 0);
  if (files.length === 0) throw new Error(`No kubeconfig at ${filePath}`);
  kc.loadFromFile(files[0]);
  for (const file of files.slice(1)) {
    const extra = new KubeConfig();
    extra.loadFromFile(file);
    kc.mergeConfig(extra);
  }
  return kc;
}

export function summariesFromKubeConfig(kc: KubeConfig): ClusterSummary[] {
  return kc.getContexts().map((ctx) => {
    const cluster = ctx.cluster ? kc.getCluster(ctx.cluster) : null;
    const user = ctx.user ? kc.getUser(ctx.user) : null;
    const server = cluster?.server ?? "";
    let problem: string | null = null;
    if (!ctx.cluster || !ctx.user || !cluster || !user) {
      problem = "This context has no cluster or user.";
    } else if (!server) {
      problem = "This context has no API server.";
    }
    return {
      id: ctx.name,
      name: ctx.name,
      server,
      namespace: ctx.namespace ?? null,
      usable: problem === null,
      problem,
      certExpires: user ? certificateExpiry(user.certData, user.certFile) : null,
    };
  });
}

// When a client certificate stops working. Only the public certificate is read, never the key.
export function certificateExpiry(certData: string | undefined, certFile: string | undefined): string | null {
  try {
    const pem = certData ? Buffer.from(certData, "base64") : certFile ? fs.readFileSync(certFile) : null;
    if (!pem) return null;
    const until = Date.parse(new X509Certificate(pem).validTo);
    return Number.isNaN(until) ? null : new Date(until).toISOString();
  } catch {
    return null;
  }
}

export function readKubeconfigSummaries(filePath: string): { summaries: ClusterSummary[]; error: string | null } {
  try {
    return { summaries: summariesFromKubeConfig(loadKubeConfig(filePath)), error: null };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return { summaries: [], error: `No kubeconfig at ${filePath}` };
    const message = error instanceof Error ? error.message : "Could not read kubeconfig";
    return { summaries: [], error: message };
  }
}

export function kubeconfigExists(filePath: string): boolean {
  return filePath.split(path.delimiter).filter(Boolean).every((file) => fs.existsSync(file));
}
