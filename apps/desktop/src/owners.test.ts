import { describe, expect, it } from "vitest";
import { createOwners } from "./owners.js";

describe("cluster ownership of forwards, logs, and shells", () => {
  it("hands back only the closed cluster's sessions, once", () => {
    const owners = createOwners();
    owners.remember("forwards", "f1", "dev");
    owners.remember("forwards", "f2", "prod");
    owners.remember("logs", "l1", "dev");
    owners.remember("terminals", "t1", "dev");
    owners.remember("terminals", "local", null);
    owners.forget("logs", "l1");
    expect(owners.takeAll("dev")).toEqual({ logs: [], forwards: ["f1"], terminals: ["t1"] });
    expect(owners.takeAll("dev")).toEqual({ logs: [], forwards: [], terminals: [] });
    expect(owners.takeAll("prod").forwards).toEqual(["f2"]);
  });
});
