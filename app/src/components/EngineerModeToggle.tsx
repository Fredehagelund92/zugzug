import { useEngineerMode } from "../lib/engineer-mode";
import { cx } from "../lib/cx";

/* EngineerModeToggle — the </> chip in the topbar that flips warehouse-internals
   visibility on/off. Mirrors ThemeToggle's footprint (h-8 w-8, square, border). */
export function EngineerModeToggle() {
  const { engineer, setEngineer } = useEngineerMode();
  return (
    <button
      type="button"
      onClick={() => setEngineer(!engineer)}
      aria-label="Toggle engineer details"
      aria-pressed={engineer}
      title="Show engineering details (IDs, wiring, map tables)"
      className={cx(
        "grid h-8 w-8 place-items-center rounded-sm border font-mono text-[11px] transition-colors",
        engineer
          ? "border-accent bg-accent-wash text-accent"
          : "border-line-2 text-ink-3 hover:border-accent hover:text-ink",
      )}
    >
      &lt;/&gt;
    </button>
  );
}
