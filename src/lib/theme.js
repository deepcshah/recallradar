/* Light / dark, with the OS as the default.
 *
 * The chosen theme is written to <html data-theme> — index.html applies the
 * stored value before first paint, so a dark-mode user never sees a white
 * flash. "system" removes the attribute and lets the CSS media query decide.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "rr-theme";
export const THEMES = ["light", "dark", "system"];

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch (_) {
    return "system";
  }
}

function apply(theme) {
  const el = document.documentElement;
  if (theme === "system") delete el.dataset.theme;
  else el.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState(stored);
  const [systemDark, setSystemDark] = useState(prefersDark);

  // While following the OS, a change out there has to reach React too —
  // the CSS updates on its own, but `resolved` drives the map basemap.
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia("(prefers-color-scheme: dark)"); } catch (_) { return; }
    const sync = () => setSystemDark(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    apply(theme);
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch (_) { /* private mode */ }
  }, [theme]);

  /* Cycle in the order people expect from a single control: whatever you are
   * seeing now → the other one → back to following the OS. */
  const cycle = useCallback(() => {
    setTheme((t) => (t === "system" ? (prefersDark() ? "light" : "dark") : t === "dark" ? "light" : "system"));
  }, []);

  return {
    theme,
    setTheme,
    cycle,
    resolved: theme === "system" ? (systemDark ? "dark" : "light") : theme,
  };
}

function prefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (_) {
    return false;
  }
}
