import { useMemo } from "react";
import type { RowActivityEntry } from "../../lib/use-row-activity";

/** Per-row activity badge: thin left-edge pip + hover-revealed
 *  "[Name] · [N]m ago" label. Inside a DataGrid row container that has
 *  `relative group` set so the hover state propagates correctly.
 *
 *  Badge uses a plain <span> rather than <Badge> because Badge does not
 *  accept a className prop and we need a smaller font size (10px). */
export function RowActivityBadge({ entry }: { entry: RowActivityEntry }) {
  const relative = useMemo(() => relativeTime(new Date(entry.at)), [entry.at]);

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 bottom-0 w-0.5 bg-line-2 group-hover:bg-accent transition-colors"
      />
      <div className="pointer-events-none group-hover:pointer-events-auto absolute left-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <span className="inline-flex items-center gap-1.5 rounded-sm border border-line-2 bg-surface-2 px-2 py-0.5 font-mono text-[10px] font-medium text-ink-2">
          {entry.displayName} · {relative}
        </span>
      </div>
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
