// Theme toggle shared by the landing page and the demo. The pre-paint script in each HTML page
// applies the saved choice (or ?theme=) before first paint; this module wires the buttons.

export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "callpoint-theme";

export const themeToggleHtml = `
      <div class="theme-toggle" role="group" aria-label="Theme" id="theme-toggle">
        <button type="button" data-theme-choice="system" aria-label="Use system theme" title="System">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
        </button>
        <button type="button" data-theme-choice="light" aria-label="Use light theme" title="Light">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button type="button" data-theme-choice="dark" aria-label="Use dark theme" title="Dark">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        </button>
      </div>`;

export function currentTheme(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "dark" || t === "light" ? t : "system";
}

/** System = no attribute (prefers-color-scheme decides). The choice is saved when storage works. */
export function setTheme(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // Storage blocked (private mode, sandbox): the theme still applies for this page view.
  }
  syncThemeToggle();
}

export function syncThemeToggle() {
  const t = currentTheme();
  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeChoice === t)));
}

export function wireThemeToggle() {
  document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeChoice as Theme)));
  syncThemeToggle();
}

/** Small guarded localStorage helpers for per-browser UI choices. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice applies for this page view only.
  }
}
