import { describe, expect, it } from "vitest";
import { lineDiff } from "./diff";

describe("lineDiff", () => {
  it("is empty when the text matches", () => {
    expect(lineDiff("kind: Pod\n", "kind: Pod\n")).toEqual([]);
  });

  it("marks added and removed lines and keeps nearby context", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n");
    const after = ["a", "b", "C", "d", "e"].join("\n");
    expect(lineDiff(before, after)).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "remove", text: "c" },
      { kind: "add", text: "C" },
      { kind: "same", text: "d" },
      { kind: "same", text: "e" },
    ]);
  });
});
