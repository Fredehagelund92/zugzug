import { useMemo } from "react";
import type { RowActivityEntry } from "../../lib/use-row-activity";

/** Per-row activity badge: thin left-edge pip + hover-revealed
 *  "[Name] · [N]m ago" label anchored to the row's RIGHT edge so it doesn't
 *  collide with the row-number gutter or the primary label column. Must sit
 *  inside a DataGrid row container that has `relative group` set so the hover
 *  state propagates correctly.
 *
 *  The badge is capped at 180px and truncates long display names — keeps the
 *  chip from blowing out into adjacent columns when the row is narrow. Sits at
 *  z-20 with a backdrop blur so the underlying cell text is legibly dimmed
 *  rather than smashed against the chip border.
 *
 *  While a cell in the row is being edited (`editing`), the right-edge hover
 *  chip is suppressed — row hover and edit hover are the same gesture, so the
 *  chip would otherwise pop up over the field being edited. The left-edge pip
 *  stays; it never overlaps cell content. */
export function RowActivityBadge({
  entry,
  editing = false,
}: {
  entry: RowActivityEntry;
  editing?: boolean;
}) {
  const relative = useMemo(() => relativeTime(new Date(entry.at)), [entry.at]);

  return (
    <>
      {/* Left-edge pip — tied to row hover, signals "this row was touched". */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 bottom-0 w-0.5 bg-line-2 group-hover:bg-accent transition-colors z-[2]"
      />
      {/* Hover chip — right-aligned, width-capped, sticky to the visible viewport
       *  via right-3 (3 = 12px gutter for the scrollbar). Hidden while editing so
       *  it doesn't cover the field in play. */}
      {!editing && (
      <div className="pointer-events-none group-hover:pointer-events-auto absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 translate-x-1 group-hover:translate-x-0 transition-all duration-150 z-20 max-w-[180px]">
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-line-2 px-2 py-0.5 font-mono text-[10px] font-medium text-ink-2 shadow-[0_2px_8px_-2px_color-mix(in_srgb,var(--ink)_18%,transparent)]"
          style={{
            background: "color-mix(in srgb, var(--surface-2) 92%, transparent)",
            backdropFilter: "blur(6px)",
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" aria-hidden />
          <span className="truncate">{entry.displayName}</span>
          <span className="shrink-0 text-ink-3">· {relative}</span>
        </span>
      </div>
      )}
    </>
  );
}

function relativeTime(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
