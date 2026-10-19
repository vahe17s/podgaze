import { describe, expect, it } from "vitest";
import { cpuMillicores, memoryBytes } from "@podgaze/contracts";

describe("resource quantities", () => {
  it("reads cpu as millicores", () => {
    expect(cpuMillicores("100m")).toBe(100);
    expect(cpuMillicores("1")).toBe(1000);
    expect(cpuMillicores("500u")).toBe(0.5);
    expect(cpuMillicores("1000000n")).toBe(1);
  });

  it("reads memory as bytes", () => {
    expect(memoryBytes("1Ki")).toBe(1024);
    expect(memoryBytes("2Mi")).toBe(2 * 1024 * 1024);
    expect(memoryBytes("1Gi")).toBe(1024 ** 3);
    expect(memoryBytes("1000")).toBe(1000);
  });
});
