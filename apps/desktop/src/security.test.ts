import { describe, expect, it } from "vitest";
import { appUrlCheck, fromAppFrame } from "./security.js";

describe("bridge access", () => {
  const packaged = appUrlCheck("file:///opt/Podgaze/resources/app/renderer/", false);
  const dev = appUrlCheck("http://127.0.0.1:5173", true);

  it("accepts only Podgaze's own page", () => {
    expect(packaged("file:///opt/Podgaze/resources/app/renderer/index.html")).toBe(true);
    expect(packaged("file:///home/me/Downloads/evil.html")).toBe(false);
    expect(packaged("https://example.com/")).toBe(false);
    expect(dev("http://127.0.0.1:5173/?preview")).toBe(true);
    expect(dev("http://127.0.0.1:5174/")).toBe(false);
    expect(dev("http://127.0.0.1:5173.evil.com/")).toBe(false);
    expect(dev("not a url")).toBe(false);
  });

  it("refuses frames and pages loaded by navigation", () => {
    expect(fromAppFrame({ senderFrame: { url: "http://127.0.0.1:5173/", parent: null } }, dev)).toBe(true);
    expect(fromAppFrame({ senderFrame: { url: "http://127.0.0.1:5173/", parent: {} } }, dev)).toBe(false);
    expect(fromAppFrame({ senderFrame: { url: "https://attacker.example/" } }, dev)).toBe(false);
    expect(fromAppFrame({ senderFrame: null }, dev)).toBe(false);
    expect(fromAppFrame({}, dev)).toBe(false);
  });
});
