import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

/* A settings section: title + hint float above the content, which sits in a
   clean bordered card (no shadow — in-page surfaces separate with a hairline,
   per DESIGN.md §7). Pass `bare` for sections that bring their own card(s)
   (tables, card grids) so we don't frame a card inside a card. */
export function SettingsSection({
  title,
  hint,
  action,
  wide = false,
  bare = false,
  children,
}: {
  title: string;
  hint?: string;
  /** Optional element rendered in the section header, aligned to the trailing edge. */
  action?: ReactNode;
  /**
   * Widen the content column for list- or table-like sections (e.g. the member
   * roster). Form sections keep the default narrow reading measure. The header
   * text stays narrow either way.
   */
  wide?: boolean;
  /** Skip the content card — the children provide their own framing. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">{hint}</p>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      {bare ? (
        children
      ) : (
        <div className="rounded-lg border border-line bg-surface p-5 md:p-6">
          <div className={cx("space-y-6", wide ? "max-w-5xl" : "max-w-2xl")}>{children}</div>
        </div>
      )}
    </section>
  );
}
