import { useTheme } from "../theme";
import { IconSun, IconMoon } from "./Icons";

/* ThemeToggle — an icon toggle (sun in dark mode, moon in light mode). The accent
   stays fixed to the brand; re-theming is proven via window.BrandApp.setAccent. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
      className="grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-2 transition-colors hover:border-accent hover:text-ink"
    >
      {theme === "dark" ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
    </button>
  );
}
