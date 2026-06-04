import { cx } from "../lib/cx";

/* Mark — the Zug Zug ZZ zigzag monogram. Three bars in ink + two diagonals in
   accent, driven by `currentColor` + token-backed text utilities (no hex). */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cx("block", className)} aria-hidden="true">
      <g
        className="text-ink"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 6H25" />
        <path d="M7 16H25" />
        <path d="M7 26H25" />
      </g>
      <g
        className="text-accent"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M25 6L7 16" />
        <path d="M25 16L7 26" />
      </g>
    </svg>
  );
}
