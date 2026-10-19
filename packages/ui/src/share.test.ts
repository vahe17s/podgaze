import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveGrouping, loadGrouping } from "./groups";
import { applyShareFile, buildShareFile, parseShareFile, partsIn } from "./share";

describe("team settings file", () => {
  beforeEach(() => localStorage.clear());

  it("exports names and preferences, and imports by merging", async () => {
    saveGrouping("/k", { groups: [{ id: "g1", name: "Europe" }], membership: { "eu-dev": "g1" } });
    localStorage.setItem("podgaze.projects", JSON.stringify({ prod: [{ id: "p1", name: "Shop", namespaces: ["shop"], labels: "" }] }));
    const file = buildShareFile("/k", { "eu-main": { protected: true, readOnly: false } }, new Date("2026-10-16T00:00:00Z"));
    expect(JSON.stringify(file)).not.toContain("p1");
    expect(partsIn(file).map((item) => item.part)).toEqual(["settings", "groups", "guards", "projects"]);

    localStorage.clear();
    saveGrouping("/k", { groups: [{ id: "mine", name: "Europe" }, { id: "x", name: "Other" }], membership: { other: "x" } });
    const setGuard = vi.fn(async () => undefined);
    const done = await applyShareFile(parseShareFile(JSON.stringify(file)), new Set(["groups", "guards", "projects"]), "/k", setGuard);
    expect(done).toEqual(["1 cluster groups", "Safety flags tightened for 1 contexts", "Projects: 1 new"]);
    expect(loadGrouping("/k")).toMatchObject({ groups: [{ id: "mine", name: "Europe" }, { id: "x", name: "Other" }], membership: { other: "x", "eu-dev": "mine" } });
    expect(setGuard).toHaveBeenCalledWith("eu-main", { protected: true, readOnly: false });
    expect(JSON.parse(localStorage.getItem("podgaze.projects")!).prod[0]).toMatchObject({ name: "Shop", namespaces: ["shop"] });
  });

  it("never loosens safety, merges same-name items, and drops malformed parts", async () => {
    localStorage.setItem("podgaze.forwardSets", JSON.stringify({ dev: [{ id: "s1", name: "dbs", autoStart: true, forwards: [{ kind: "Service", namespace: "a", name: "pg", remotePort: 5432, localPort: 5432 }] }] }));
    const file = parseShareFile(JSON.stringify({
      podgaze: 1,
      exportedAt: "x",
      guards: { prod: { protected: false, readOnly: false }, staging: { protected: true, readOnly: false, namespaces: { pay: "readOnly", bad: "x" } }, junk: null },
      forwardSets: { dev: [{ name: "dbs", autoStart: false, forwards: [{ kind: "Service", namespace: "a", name: "redis", remotePort: 6379, localPort: 6379 }, { nonsense: true }] }], other: "not a list" },
      projects: { dev: [{ name: "No namespaces" }, { labels: "x" }] },
      logQueries: [{ pattern: "" }, { pattern: "timeout" }, 5],
    }));
    expect(file.guards).toEqual({ prod: { protected: false, readOnly: false }, staging: { protected: true, readOnly: false, namespaces: { pay: "readOnly" } } });
    expect(file.projects).toEqual({ dev: [{ name: "No namespaces", namespaces: [], labels: "" }] });
    expect(file.logQueries).toEqual([{ pattern: "timeout", regex: false, caseSensitive: false }]);
    const setGuard = vi.fn(async () => undefined);
    await applyShareFile(file, new Set(["guards", "forwardSets"]), null, setGuard, {
      prod: { protected: true, readOnly: true },
      staging: { protected: false, readOnly: false, namespaces: { web: "readOnly" } },
    });
    expect(setGuard).toHaveBeenCalledTimes(1);
    expect(setGuard).toHaveBeenCalledWith("staging", { protected: true, readOnly: false, namespaces: { pay: "readOnly", web: "readOnly" } });
    const sets = JSON.parse(localStorage.getItem("podgaze.forwardSets")!);
    expect(sets.dev[0]).toMatchObject({ id: "s1", autoStart: true });
    expect(sets.dev[0].forwards.map((item: { name: string }) => item.name)).toEqual(["pg", "redis"]);
  });

  it("cannot open a read-only cluster, survives prototype keys, and keeps prod protection", async () => {
    const file = parseShareFile(JSON.stringify({
      podgaze: 1,
      exportedAt: "x",
      guards: { prod: { protected: true, readOnly: true, namespaces: { default: "writable", audit: "readOnly" } }, "shop-prod": { protected: false, readOnly: false, namespaces: { tmp: "readOnly" } }, constructor: { protected: true, readOnly: true } },
      projects: { constructor: [{ name: "x", namespaces: ["a"] }], toString: [{ name: "y", namespaces: ["b"] }] },
    }));
    expect(Object.keys(file.guards!)).toEqual(["prod", "shop-prod"]);
    const setGuard = vi.fn(async () => undefined);
    const done = await applyShareFile(file, new Set(["guards", "projects"]), null, setGuard, { prod: { protected: true, readOnly: true } });
    expect(setGuard).toHaveBeenCalledWith("prod", { protected: true, readOnly: true, namespaces: { audit: "readOnly" } });
    // A context the app has no guard for yet keeps the name-based protection.
    expect(setGuard).toHaveBeenCalledWith("shop-prod", { protected: true, readOnly: false, namespaces: { tmp: "readOnly" } });
    expect(done).toContain("Projects: 1 new");
  });

  it("refuses files that are not Podgaze settings", () => {
    expect(() => parseShareFile("{}")).toThrow(/not a Podgaze settings file/);
    expect(() => parseShareFile("nope")).toThrow(/not JSON/);
  });
});
