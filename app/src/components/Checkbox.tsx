import { cx } from "../lib/cx";
import { IconCheck } from "./Icons";

/* Checkbox — a squared, token-driven checkbox supporting a mixed state. */
export function Checkbox({
  state,
  onClick,
  "aria-label": ariaLabel,
}: {
  state: "on" | "off" | "mixed";
  onClick: () => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "mixed" ? "mixed" : state === "on"}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cx(
        "grid h-4 w-4 shrink-0 place-items-center rounded-sm border transition-colors",
        state === "off" ? "border-line-2 hover:border-accent" : "border-accent bg-accent text-accent-ink",
      )}
    >
      {state === "on" && <IconCheck className="h-3 w-3" strokeWidth={3} />}
      {state === "mixed" && <span className="h-0.5 w-2 rounded-pill bg-current" />}
    </button>
  );
}
