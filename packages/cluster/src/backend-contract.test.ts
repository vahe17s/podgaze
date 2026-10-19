import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKubeBackend } from "./kube-backend.js";

// The session calls these optional backend methods for whole features (cost, timeline, log search...). A missing
// one fails only at runtime with "Not connected.", so check the real backend has every one of them.
const FEATURES = [
  "listCustomKinds", "countResources", "createYaml", "listHelmReleases", "getHelmRelease", "helmAction", "helmRepos",
  "helmAddRepo", "helmSearch", "helmChartValues", "helmInstall", "getMap", "listArgoApps", "argoAction", "hubSearch",
  "startNodeShell", "stopNodeShell", "listCertificates", "listImages", "findWorkloads", "whoCan", "myRules",
  "writeSecret", "getTimeline", "searchLogs", "listVolumes",
] as const;

describe("kube backend", () => {
  it("implements every feature the session calls", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "podgaze-contract-"));
    const file = path.join(dir, "config");
    fs.writeFileSync(file, "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster:\n      server: https://127.0.0.1:6443\ncontexts:\n  - name: x\n    context:\n      cluster: c\n      user: u\nusers:\n  - name: u\n    user:\n      token: fake\ncurrent-context: x\n");
    const backend = createKubeBackend(file, "x") as unknown as Record<string, unknown>;
    expect(FEATURES.filter((name) => typeof backend[name] !== "function")).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
