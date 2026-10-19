import { useSyncExternalStore } from "react";

export type ThemeChoice = "dark" | "light" | "system";
export type StartView = "Overview" | "Pod";

export type Settings = {
  theme: ThemeChoice;
  zoom: number;
  reduceMotion: boolean;
  showSplash: boolean;
  startView: StartView;
  autoOpenDetails: boolean;
  logTail: number;
  logWrap: boolean;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  editorFontSize: number;
  alerts: boolean;
};

export const zoomSteps = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
export const logTailChoices = [100, 200, 500, 1000, 5000];
export const scrollbackChoices = [1000, 5000, 10000, 50000];

export const defaultSettings: Settings = {
  theme: "dark",
  zoom: 1,
  reduceMotion: false,
  showSplash: true,
  startView: "Pod",
  autoOpenDetails: true,
  logTail: 200,
  logWrap: true,
  terminalFontSize: 13,
  terminalCursorBlink: true,
  terminalScrollback: 5000,
  editorFontSize: 12.5,
  alerts: true,
};

const KEY = "podgaze.settings";

function clamp(value: unknown, low: number, high: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

function oneOf<T>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// Hand-edited or older storage must never put the app in a state the settings page cannot show.
export function sanitize(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const d = defaultSettings;
  return {
    theme: oneOf(raw.theme, ["dark", "light", "system"] as const, d.theme),
    zoom: oneOf(raw.zoom, zoomSteps, d.zoom),
    reduceMotion: bool(raw.reduceMotion, d.reduceMotion),
    showSplash: bool(raw.showSplash, d.showSplash),
    startView: oneOf(raw.startView, ["Overview", "Pod"] as const, d.startView),
    autoOpenDetails: bool(raw.autoOpenDetails, d.autoOpenDetails),
    logTail: oneOf(raw.logTail, logTailChoices, d.logTail),
    logWrap: bool(raw.logWrap, d.logWrap),
    terminalFontSize: clamp(raw.terminalFontSize, 9, 24, d.terminalFontSize),
    terminalCursorBlink: bool(raw.terminalCursorBlink, d.terminalCursorBlink),
    terminalScrollback: oneOf(raw.terminalScrollback, scrollbackChoices, d.terminalScrollback),
    editorFontSize: clamp(raw.editorFontSize, 9, 24, d.editorFontSize),
    alerts: bool(raw.alerts, d.alerts),
  };
}

function load(): Settings {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed as Record<string, unknown>;
    // Earlier builds kept theme and zoom under their own keys.
    if (saved.theme === undefined) saved.theme = localStorage.getItem("podgaze.theme") ?? undefined;
    if (saved.zoom === undefined && localStorage.getItem("podgaze.zoom")) saved.zoom = Number(localStorage.getItem("podgaze.zoom"));
  } catch {
    // Private windows and blocked storage just start from the defaults.
  }
  return sanitize(saved);
}

let current = load();
const listeners = new Set<() => void>();

function publish(next: Settings) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Still applies for this run.
  }
  for (const listener of listeners) listener();
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  publish(sanitize({ ...current, ...patch }));
}

export function resetSettings() {
  publish(defaultSettings);
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

export function resolvedTheme(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Puts the settings that are pure styling onto <html>, where CSS and CodeMirror themes pick them up.
export function applyDocumentSettings(settings: Settings) {
  const root = document.documentElement;
  const theme = resolvedTheme(settings.theme);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.zoom = "";
  root.style.setProperty("--ui-zoom", String(settings.zoom));
  root.style.setProperty("--editor-font", `${settings.editorFontSize}px`);
  if (settings.reduceMotion) root.dataset.motion = "reduce";
  else delete root.dataset.motion;
}

// Stored layout that is not a setting but that "Reset layout" should clear.
export const layoutKeys = ["podgaze.dock", "podgaze.sidebar", "podgaze.tab"];
