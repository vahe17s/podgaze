import { describe, expect, it } from "vitest";
import type { CertInfo, DeploymentRow, PodRow } from "@podgaze/contracts";
import { inScope, needsRenewal, teamHealth } from "./team";

const pod = (name: string, namespace: string, status: string, restarts = 0, labels: Record<string, string> = {}): PodRow => ({
  uid: name, name, namespace, status, ready: "1/1", restarts, nodeName: "n", ageStart: "", images: [], ip: "", qos: "", controlledBy: "", ports: [], containers: [], lastExit: restarts ? "Error (1)" : "", labels,
  requests: { cpuMillicores: 0, memoryBytes: 0 }, limits: { cpuMillicores: 0, memoryBytes: 0 },
});
const deployment = (name: string, ready: string): DeploymentRow => ({ uid: name, name, namespace: "shop", status: "Available", ready, updated: "", available: "", ageStart: "", images: [], labels: {}, paused: false });

describe("team page", () => {
  it("scopes rows by namespaces and the project's labels", () => {
    const rows = [pod("a", "shop", "Running", 0, { team: "pay" }), pod("b", "shop", "Running"), pod("c", "other", "Running", 0, { team: "pay" })];
    expect(inScope(rows, { id: "p", title: "Pay", namespaces: ["shop"], labels: "team=pay" }).map((row) => row.name)).toEqual(["a"]);
    expect(inScope(rows, { id: "n", title: "shop", namespaces: ["shop"], labels: "" })).toHaveLength(2);
  });

  it("says what is wrong first", () => {
    expect(teamHealth([pod("a", "shop", "Running")], [deployment("api", "2/2")]).verdict).toBe("Everything is running");
    const bad = teamHealth([pod("a", "shop", "CrashLoopBackOff", 7), pod("b", "shop", "Running", 2), pod("job", "shop", "Succeeded")], [deployment("api", "0/2"), deployment("web", "1/2")]);
    expect(bad).toMatchObject({ tone: "bad", verdict: "1 deployment down", pods: 2, restarts: 9 });
    expect(bad.failingPods.map((item) => item.name)).toEqual(["a", "b"]);
  });

  it("lists expiring items", () => {
    const now = Date.parse("2026-10-16T00:00:00Z");
    const cert = (name: string, notAfter: string, extra: Partial<CertInfo> = {}): CertInfo => ({ source: "Secret", namespace: "shop", name, secretName: "", certificateName: "", subject: "", dnsNames: [], issuer: "", notAfter, renewalTime: "", ready: "", problem: "", ...extra });
    expect(needsRenewal([cert("far", "2027-01-01T00:00:00Z"), cert("soon", "2026-10-20T00:00:00Z"), cert("sync", "", { source: "ExternalSecret", ready: "False", problem: "x" })], ["shop"], now).map((item) => item.name)).toEqual(["sync", "soon"]);
  });
});
