import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "@podgaze/contracts";
import { createUpdates, friendly } from "./updates.js";

function fakeUpdater() {
  const bus = new EventEmitter();
  return Object.assign(bus, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  });
}

function setup(platform: NodeJS.Platform, appImage?: string) {
  const updater = fakeUpdater();
  const states: UpdateState[] = [];
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "podgaze-upd-")), "updates.json");
  const updates = createUpdates({
    updater, packaged: true, platform, appImage, current: "0.1.1", settingsFile,
    releasePage: (version) => `https://example.com/releases/v${version}`,
    emit: (state) => states.push(state),
    setTimer: () => undefined,
  });
  return { updater, updates, states, settingsFile };
}

describe("updates", () => {
  it("downloads and installs on Windows and AppImage", async () => {
    const { updater, updates } = setup("win32");
    expect(updater.autoDownload).toBe(true);
    updater.emit("update-available", { version: "0.2.0" });
    expect(updates.state()).toMatchObject({ status: "downloading", version: "0.2.0", canInstall: true });
    updater.emit("download-progress", { percent: 41.6 });
    expect(updates.state().progress).toBe(42);
    updater.emit("update-downloaded", { version: "0.2.0" });
    updates.install();
    expect(updater.quitAndInstall).toHaveBeenCalled();
    expect(setup("linux", "/tmp/Podgaze.AppImage").updates.state().canInstall).toBe(true);
  });

  it("keeps a downloaded update ready when a later check fails", async () => {
    const { updater, updates } = setup("win32");
    updater.emit("update-downloaded", { version: "0.3.0" });
    updater.emit("checking-for-update", {});
    updater.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));
    expect(updates.state()).toMatchObject({ status: "ready", version: "0.3.0" });
    await updates.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    updates.install();
    expect(updater.quitAndInstall).toHaveBeenCalled();
  });

  it("only links to the release for a .deb and for macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { updater, updates } = setup(platform);
      expect(updater.autoDownload).toBe(false);
      updater.emit("update-available", { version: "0.2.0" });
      expect(updates.state()).toMatchObject({ status: "available", canInstall: false, releaseUrl: "https://example.com/releases/v0.2.0" });
      updates.install();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    }
  });

  it("remembers turning automatic checks off, and explains common errors", async () => {
    const { updates, settingsFile } = setup("win32");
    expect(updates.setAutomatic(false).automatic).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toEqual({ automatic: false });
    expect(friendly(new Error("HttpError: 404 Not Found"))).toMatch(/private/);
    expect(friendly(new Error("getaddrinfo ENOTFOUND github.com"))).toMatch(/connection/);
  });
});
