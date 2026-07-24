import { cx } from "../lib/cx";

/** Identity avatar: a colored disc with optically-centered white initials.
 *  One visual language for the account menu, table owners, and (later) peers.
 *  Centering is the whole point — a grid box plus `leading-none` and a
 *  proportional font size keep the glyphs dead-center at any size, which the
 *  old mono + default-line-height badges did not. */
export function Avatar({
  name,
  color,
  size = 20,
  initials,
  title,
  className,
}: {
  /** Display name — used to derive initials when `initials` is not given. */
  name: string;
  /** Fill color, e.g. `var(--tint-indigo)` or a `PALETTE[...].bg`. */
  color: string;
  /** Diameter in px. Font scales with it. */
  size?: number;
  /** Explicit initials override (e.g. a server-curated value). */
  initials?: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      title={title}
      className={cx(
        "grid shrink-0 select-none place-items-center rounded-pill font-display font-semibold leading-none text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        background: color,
      }}
    >
      {initials ?? avatarInitials(name)}
    </span>
  );
}

/** First + last initial, upper-cased. Single word → its first letter. */
export function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
  return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
}
