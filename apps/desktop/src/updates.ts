import fs from "node:fs";
import type { UpdateState } from "@podgaze/contracts";

// The part of electron-updater this uses, so tests can pass a fake.
export type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "checking-for-update" | "update-available" | "update-not-available" | "download-progress" | "update-downloaded" | "error", listener: (info: any) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
};

export type UpdateOptions = {
  updater: UpdaterLike;
  packaged: boolean;
  platform: NodeJS.Platform;
  // Set by the AppImage runtime; a .deb install has no way to replace itself without root.
  appImage: string | undefined;
  current: string;
  settingsFile: string;
  releasePage: (version: string) => string;
  emit: (state: UpdateState) => void;
  everyMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

export function createUpdates(options: UpdateOptions) {
  // Windows (NSIS) and AppImage install in place; macOS needs a signed app for that, and a .deb needs root.
  const canInstall = options.packaged && (options.platform === "win32" || (options.platform === "linux" && Boolean(options.appImage)));
  let automatic = readAutomatic();
  let state: UpdateState = {
    status: options.packaged ? "idle" : "unsupported",
    current: options.current,
    canInstall,
    automatic,
    message: options.packaged ? undefined : "Updates apply to installed builds, not to development runs.",
  };
  const { updater } = options;
  updater.autoDownload = canInstall;
  updater.autoInstallOnAppQuit = canInstall;

  // Once an update is downloaded, it stays ready to install: a later check (offline, rate limited) must not
  // take the button away.
  const ready = () => state.status === "ready";

  function set(next: Partial<UpdateState>) {
    state = { ...state, ...next, current: options.current, canInstall, automatic };
    options.emit(state);
  }

  function readAutomatic(): boolean {
    try {
      return JSON.parse(fs.readFileSync(options.settingsFile, "utf8")).automatic !== false;
    } catch {
      return true;
    }
  }

  updater.on("checking-for-update", () => {
    if (!ready()) set({ status: "checking", message: undefined });
  });
  updater.on("update-not-available", () => {
    if (!ready()) set({ status: "none", version: undefined, progress: undefined });
  });
  updater.on("update-available", (info: { version?: string }) => !ready() && set({
    status: canInstall ? "downloading" : "available",
    version: info?.version,
    progress: canInstall ? 0 : undefined,
    releaseUrl: info?.version ? options.releasePage(info.version) : undefined,
  }));
  updater.on("download-progress", (info: { percent?: number }) => !ready() && set({ status: "downloading", progress: Math.round(info?.percent ?? 0) }));
  updater.on("update-downloaded", (info: { version?: string }) => set({ status: "ready", version: info?.version ?? state.version, progress: 100 }));
  updater.on("error", (error: Error) => {
    if (!ready()) set({ status: "error", message: friendly(error) });
  });

  async function check(): Promise<UpdateState> {
    if (!options.packaged || ready()) return state;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      if (!ready()) set({ status: "error", message: friendly(error) });
    }
    return state;
  }

  if (options.packaged) {
    const later = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.());
    const every = options.everyMs ?? 6 * 60 * 60 * 1000;
    const tick = () => {
      if (automatic) void check();
      later(tick, every);
    };
    later(tick, 15_000);
  }

  return {
    state: () => state,
    check,
    install() {
      if (state.status === "ready" && canInstall) updater.quitAndInstall();
    },
    setAutomatic(enabled: boolean): UpdateState {
      automatic = enabled;
      try {
        fs.writeFileSync(options.settingsFile, JSON.stringify({ automatic: enabled }));
      } catch {
        // The choice lasts for this run.
      }
      set({});
      return state;
    },
  };
}

// GitHub answers 404 for a private repository's releases and nothing useful offline; say that plainly.
export function friendly(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/404|Not Found/i.test(text)) return "No published release found. If the repository is private, updates need it to be public.";
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|net::/i.test(text)) return "Could not reach GitHub. Check your connection.";
  return text.split("\n")[0]!.slice(0, 200);
}
