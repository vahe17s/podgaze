import { describe, expect, it } from "vitest";
import { addGroup, assignCluster, deleteGroup, groupOf, renameGroup } from "./groups";

describe("cluster groups", () => {
  it("adds, renames, assigns, moves, and deletes without losing clusters", () => {
    let { grouping, id: europe } = addGroup({ groups: [], membership: {} }, "Europe", "g1");
    const asia = addGroup(grouping, "Asia", "g2");
    grouping = asia.grouping;
    grouping = assignCluster(grouping, "prod", europe);
    grouping = assignCluster(grouping, "prod", asia.id);
    expect(groupOf(grouping, "prod")?.name).toBe("Asia");
    grouping = renameGroup(grouping, asia.id, "APAC");
    expect(groupOf(grouping, "prod")?.name).toBe("APAC");
    grouping = assignCluster(grouping, "staging", asia.id);
    grouping = deleteGroup(grouping, asia.id);
    expect(grouping.groups.map((group) => group.name)).toEqual(["Europe"]);
    expect(grouping.membership).toEqual({});
    grouping = assignCluster(assignCluster(grouping, "dev", europe), "dev", "");
    expect(groupOf(grouping, "dev")).toBeNull();
  });

  it("keeps hidden clusters hidden when a group is deleted", () => {
    expect(deleteGroup({ groups: [{ id: "g", name: "G" }], membership: { a: "g" }, hidden: ["b"] }, "g")).toEqual({ groups: [], membership: {}, hidden: ["b"] });
  });
});
