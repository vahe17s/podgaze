import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type { ArgoApp } from "@podgaze/contracts";
import { buildTimeline, imageChanges } from "./timeline.js";
import { storageClasses, volumeRows } from "./volumes.js";
import { compileMatcher, createRegexSearch, mergeMatches, searchText } from "./log-search.js";

describe("incident timeline", () => {
  it("merges rollouts, crashes, scaling, warnings, and Argo syncs, newest first", () => {
    const argo = {
      name: "checkout", history: [{ id: 1, revision: "a1b2c3d4e5f6", deployedAt: "2026-10-16T09:58:00Z", source: "apps/checkout" }],
      operation: { phase: "Failed", message: "hook failed", startedAt: "", finishedAt: "2026-10-16T10:20:00Z" },
    } as unknown as ArgoApp;
    const timeline = buildTimeline({
      revisions: [
        { name: "ReplicaSet api-1", created: "2026-10-15T08:00:00Z", revision: "1", containers: [{ name: "api", image: "registry.example.com/api:1.4.0" }] },
        { name: "ReplicaSet api-2", created: "2026-10-16T10:00:00Z", revision: "2", containers: [{ name: "api", image: "registry.example.com/api:1.5.0" }], changeCause: "bump" },
      ],
      pods: [{
        metadata: { name: "api-2-x" },
        status: { containerStatuses: [{ name: "api", lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-16T10:05:00Z" } } }] },
      }],
      events: [
        { type: "Normal", reason: "ScalingReplicaSet", message: "Scaled up replica set api-2 to 3", lastTimestamp: "2026-10-16T10:00:05Z", involvedObject: { kind: "Deployment", name: "api" } },
        { type: "Normal", reason: "Pulled", message: "noise", lastTimestamp: "2026-10-16T10:00:06Z", involvedObject: { kind: "Pod", name: "api-2-x" } },
        { type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 4, lastTimestamp: "2026-10-16T10:06:00Z", involvedObject: { kind: "Pod", name: "api-2-x" } },
      ],
      argo: [argo],
    });
    expect(timeline.entries.map((entry) => [entry.category, entry.title])).toEqual([
      ["warning", "Argo CD sync failed"],
      ["crash", "BackOff ×4"],
      ["oom", "api was OOM-killed"],
      ["scale", "ScalingReplicaSet"],
      ["deploy", "Rolled out revision 2"],
      ["sync", "Argo CD synced checkout"],
      ["deploy", "Revision 1"],
    ]);
    expect(timeline.entries.find((entry) => entry.title === "Rolled out revision 2")!.detail).toBe("api 1.4.0 → 1.5.0 · bump");
    expect(timeline.eventsSince).toBe("2026-10-16T10:00:05.000Z");
  });

  it("names only the containers whose image changed", () => {
    expect(imageChanges([{ name: "a", image: "x:1" }, { name: "b", image: "y:1" }], [{ name: "a", image: "x:1" }, { name: "b", image: "y:2" }, { name: "c", image: "z@sha256:abc" }])).toBe("b 1 → 2, c sha256:abc");
  });
});

describe("log search", () => {
  const log = "2026-10-16T10:00:00.000Z GET /health 200\n2026-10-16T10:00:01.000Z ERROR timeout calling payments\n2026-10-16T10:00:02.000Z error: retry 2 of 3 (a.b)\n";

  it("finds literal text case-insensitively and keeps the timestamps", () => {
    const result = searchText(log, compileMatcher("error", false, false), "api-1", "api");
    expect(result.lines).toBe(3);
    expect(result.matches.map((match) => [match.time, match.line, match.ranges])).toEqual([
      ["2026-10-16T10:00:01.000Z", "ERROR timeout calling payments", [[0, 5]]],
      ["2026-10-16T10:00:02.000Z", "error: retry 2 of 3 (a.b)", [[0, 5]]],
    ]);
    expect(searchText(log, compileMatcher("(a.b)", false, true), "p", "c").matches).toHaveLength(1);
    expect(searchText(log, compileMatcher("ERROR", false, true), "p", "c").matches).toHaveLength(1);
  });

  it("runs regular expressions and rejects broken ones", () => {
    expect(searchText(log, compileMatcher("retry \\d of \\d", true, false), "p", "c").matches[0]!.ranges).toEqual([[7, 19]]);
    expect(() => compileMatcher("(unclosed", true, false)).toThrow(/Not a valid regular expression/);
    expect(() => compileMatcher("", false, false)).toThrow();
    expect(() => compileMatcher("(\\d{1,3}\\.){3}\\d{1,3}", true, false)).not.toThrow();
  });

  it("keeps only the newest matches per container and orders kubelet timestamps as times", () => {
    const text = Array.from({ length: 10 }, (_, index) => `2026-10-16T10:00:0${index}Z hit ${index}`).join("\n");
    const result = searchText(text, compileMatcher("hit", false, false), "p", "c", 3);
    expect(result.matches.map((match) => match.line)).toEqual(["hit 7", "hit 8", "hit 9"]);
    expect(result.dropped).toBe(7);
    const merged = mergeMatches([[{ pod: "a", container: "c", time: "2026-10-16T10:00:00.5Z", line: "", ranges: [] }, { pod: "a", container: "c", time: "2026-10-16T10:00:00Z", line: "", ranges: [] }]]);
    expect(merged.matches.map((match) => match.time)).toEqual(["2026-10-16T10:00:00Z", "2026-10-16T10:00:00.5Z"]);
  });

  it("merges pods by time", () => {
    const merged = mergeMatches([[{ pod: "b", container: "c", time: "2026-10-16T10:00:02Z", line: "", ranges: [] }], [{ pod: "a", container: "c", time: "2026-10-16T10:00:01Z", line: "", ranges: [] }]]);
    expect(merged.matches.map((match) => match.pod)).toEqual(["a", "b"]);
    expect(merged.truncated).toBe(false);
  });
});

describe("volumes for storage cost", () => {
  it("reads class, size, and who mounts each claim", () => {
    const classes = storageClasses([
      { metadata: { name: "managed-csi", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } }, provisioner: "disk.csi.azure.com", parameters: { skuname: "StandardSSD_LRS" } },
      { metadata: { name: "managed-csi-premium" }, provisioner: "disk.csi.azure.com", parameters: { skuName: "Premium_LRS" } },
    ]);
    expect(classes.map((item) => item.sku)).toEqual(["StandardSSD_LRS", "Premium_LRS"]);
    const rows = volumeRows([
      { metadata: { name: "data-db-0", namespace: "shop" }, spec: { storageClassName: "managed-csi-premium" }, status: { phase: "Bound", capacity: { storage: "128Gi" } } },
      { metadata: { name: "old", namespace: "shop" }, spec: { resources: { requests: { storage: "10Gi" } } }, status: { phase: "Bound" } },
    ], [{ metadata: { name: "db-0", namespace: "shop" }, spec: { volumes: [{ persistentVolumeClaim: { claimName: "data-db-0" } }, {}] } }], classes);
    expect(rows).toEqual([
      { namespace: "shop", name: "data-db-0", storageClass: "managed-csi-premium", sizeBytes: 128 * 1024 ** 3, phase: "Bound", usedBy: ["db-0"] },
      { namespace: "shop", name: "old", storageClass: "managed-csi", sizeBytes: 10 * 1024 ** 3, phase: "Bound", usedBy: [] },
    ]);
  });
});

describe("regex log search in a worker", () => {
  it("matches like the in-process search", async () => {
    const log = "2026-10-16T10:00:00.000Z GET /health 200\n2026-10-16T10:00:01.000Z ERROR timeout calling payments\n2026-10-16T10:00:02.000Z retry 2 of 3 after timeout\n";
    const search = createRegexSearch("time(out)?", false);
    const fromWorker = await search.search(log, "api-1", "api");
    search.close();
    expect(fromWorker).toEqual(searchText(log, compileMatcher("time(out)?", true, false), "api-1", "api"));
  });

  it("stops a catastrophic pattern instead of freezing", async () => {
    for (const pattern of ["(\\w|\\d)+$", "(.|\\s)*timeout", "(a+)+$"]) {
      const search = createRegexSearch(pattern, true, 300);
      const evil = `${pattern.startsWith("(.") ? " ".repeat(40) : pattern.startsWith("(a") ? "a".repeat(40) : "1".repeat(40)}!`;
      const started = Date.now();
      await expect(search.search(evil, "p", "c")).rejects.toThrow(/took longer than/);
      expect(Date.now() - started).toBeLessThan(3000);
      search.close();
    }
  });
});
