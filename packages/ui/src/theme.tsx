import { Icon } from "./icons";
import { applyDocumentSettings, getSettings, resolvedTheme, updateSettings, useSettings } from "./settings";

export type ThemeName = "dark" | "light";

export function readTheme(): ThemeName {
  return resolvedTheme(getSettings().theme);
}

export function applyTheme(theme: ThemeName) {
  updateSettings({ theme });
  applyDocumentSettings(getSettings());
}

// Quick flip between dark and light; "Match system" lives in Settings.
export function ThemeToggle() {
  const settings = useSettings();
  const theme = resolvedTheme(settings.theme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      role="switch"
      className="theme-switch"
      aria-checked={theme === "light"}
      aria-label={next === "light" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => applyTheme(next)}
    >
      <span className="theme-moon"><Icon name="moon" /></span>
      <span className="theme-sun"><Icon name="sun" /></span>
      <span className="theme-switch-thumb" />
    </button>
  );
}
