/* theme.ts — React theming util over <html data-theme>.
   Ports the brand engine's live theming: toggle the theme attribute, and recolor
   the whole UI from one --accent change with a luminance-aware --accent-ink.
   This is a .ts utility, so the black/white ink literals below are allowed —
   they are generic, not brand identity, and never appear in .tsx. */
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const root = (): HTMLElement => document.documentElement;

export function getTheme(): Theme {
  return root().getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  root().setAttribute("data-theme", theme);
}

export function toggleTheme(): void {
  setTheme(getTheme() === "light" ? "dark" : "light");
}

/** Read the live --accent (hex) from the cascade — used to sync the dev picker. */
export function currentAccent(): string {
  return getComputedStyle(root()).getPropertyValue("--accent").trim();
}

/**
 * Re-accent the whole UI from one hex. Sets --accent and derives a readable
 * --accent-ink via the same luminance rule as the brand engine. Dev fidelity
 * proof: change one value, every token-backed utility recolors.
 */
export function setAccent(hex: string): void {
  root().style.setProperty("--accent", hex);
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  root().style.setProperty("--accent-ink", luminance > 0.6 ? "#0A0A0A" : "#FFFFFF");
}

/** React hook over the theme attribute. */
export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
  setAccent: (hex: string) => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeState(getTheme()));
    observer.observe(root(), { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const toggle = useCallback(() => {
    toggleTheme();
    setThemeState(getTheme());
  }, []);

  const set = useCallback((t: Theme) => {
    setTheme(t);
    setThemeState(t);
  }, []);

  return { theme, toggle, setTheme: set, setAccent };
}
