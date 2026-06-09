import { IconChevron, IconWand } from "../Icons";
import { cx } from "../../lib/cx";
import type { SourceInfo } from "../../store";
import { STALE_DAYS, ago, daysAgo } from "./utils";
import { ExpandedDrill } from "./ExpandedDrill";

/* LedgerRow — a single wired-column line in the Sources ledger. Extracted
   from `routes/Sources.tsx` so the per-table workbench's "wired sources" mode
   body can render the same row without dragging the whole route along. The
   component is props-only; no Sources-scope closures. */

interface LedgerRowProps {
  row: SourceInfo;
  expanded: boolean;
  onToggle: () => void;
  onDerive: () => void;
  /** Drop the coverage-encoded standing bar at the bottom edge. The bar earns
   *  its place in the full Sources ledger (long, dense list, the % readout is
   *  load-bearing) but turns to chartjunk in a per-table panel of 1–3 rows. */
  hideStandingBar?: boolean;
  /** Keyboard cursor is on this row — paint the focus ring + accent wash. */
  focused?: boolean;
  /** Stable key used by the cursor scroll-into-view query (`data-row-key`).
   *  Format: `${dimId}::${table}::${column}`. */
  rowKey?: string;
  /** When false, the import-records (wand) button is disabled. */
  canEdit?: boolean;
}

export function LedgerRow({
  row,
  expanded,
  onToggle,
  onDerive,
  hideStandingBar,
  focused,
  rowKey,
  canEdit = true,
}: LedgerRowProps) {
  const tableName = row.table.split(".").slice(1).join(".") || row.table;
  const coverage =
    row.values > 0 ? ((row.values - row.unmapped) / row.values) * 100 : row.scanned ? 100 : 0;
  const stale = daysAgo(row.scannedAt) > STALE_DAYS;
  const standing =
    !row.scanned && !row.scannedAt
      ? "unscanned"
      : !row.present && row.scanned
        ? "not found"
        : row.unmapped > 0
          ? stale
            ? "stale drift"
            : "drift"
          : stale
            ? "stale"
            : "clean";
  // Canonical status scale (shared with DataGrid Chip + Match-mode status pills):
  //   clean → text-ok ; warn states → text-warn ; meta/unscanned → text-ink-3
  const standingTone =
    standing === "clean"
      ? "text-ok"
      : standing === "unscanned" || standing === "not found"
        ? "text-ink-3"
        : "text-warn";
  const standingBarTone = coverage >= 95 ? "bg-ok" : coverage >= 70 ? "bg-ink-3/40" : "bg-accent";

  return (
    <div
      data-row-key={rowKey}
      className={cx(
        "relative bg-surface transition-colors",
        // When the standing bar is hidden (per-table workbench mode), a 1px
        // hairline carries the separator instead — same role the bar plays
        // in the dense Sources ledger.
        hideStandingBar && "border-b border-line",
        // Focus ring stays whether or not the row is expanded; bg precedence is
        // expanded > focused > default-hover so a focused+expanded row reads
        // as "drill is open" while still showing keyboard focus.
        focused && "ring-1 ring-accent/60",
        expanded ? "bg-surface-2/40" : focused ? "bg-accent-wash/40" : "hover:bg-surface-2",
      )}
    >
      {/* Desktop layout: single grid row across 6 columns (original structure) */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="hidden md:grid w-full grid-cols-[20px_minmax(0,1fr)_minmax(110px,1fr)_88px_72px_88px] items-center gap-4 px-7 py-2.5 text-left"
      >
        <IconChevron
          className={cx(
            "h-3 w-3 shrink-0 text-ink-3 transition-transform",
            expanded && "rotate-180",
          )}
        />
        <div className="min-w-0">
          <div className="truncate font-mono text-[12.5px] text-ink">
            {tableName}
            <span className="text-ink-3">.{row.column}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-ink-3">
            <span>
              → <span className="text-ink-2">{row.dimension}</span>
            </span>
            {row.scannedAt && <span>· {ago(row.scannedAt)} ago</span>}
          </div>
        </div>
        <div className="min-w-0">
          <div className={cx("text-[12px] font-medium", standingTone)}>{standing}</div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-3 tabular-nums">
            {Math.round(coverage)}% mapped
          </div>
        </div>
        <div className="text-right text-[12.5px] tabular-nums text-ink-2">
          {row.rows.toLocaleString()}
        </div>
        <div className="text-right">
          {row.unmapped > 0 ? (
            <span className="font-display text-[14px] font-semibold tabular-nums text-accent">
              {row.unmapped.toLocaleString()}
            </span>
          ) : (
            <span className="font-mono text-[11.5px] text-ink-3 tabular-nums">0</span>
          )}
        </div>
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            aria-label={`Import records from ${row.table}.${row.column}`}
            title="Import records from this column"
            disabled={!canEdit}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDerive();
            }}
            className="grid h-6 w-6 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <IconWand className="h-3 w-3" />
          </button>
        </div>
      </button>

      {/* Mobile layout: two-line stacked card */}
      <div className="flex md:hidden min-h-[44px] items-stretch">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2.5 px-4 py-3 text-left"
        >
          <IconChevron
            className={cx(
              "mt-1 h-3 w-3 shrink-0 text-ink-3 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[13px] text-ink">
              {tableName}
              <span className="text-ink-3">.{row.column}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
              <span>
                → <span className="text-ink-2">{row.dimension}</span>
              </span>
              <span className={cx("font-medium", standingTone)}>{standing}</span>
              <span className="tabular-nums">{Math.round(coverage)}% mapped</span>
              {row.scannedAt && <span>{ago(row.scannedAt)} ago</span>}
            </div>
          </div>
        </button>
        {/* right cluster: unmapped count + wand — both touch-friendly */}
        <div className="flex shrink-0 items-stretch divide-x divide-line">
          <div className="flex min-w-[48px] items-center justify-center px-3">
            {row.unmapped > 0 ? (
              <span className="font-display text-[14px] font-semibold tabular-nums text-accent">
                {row.unmapped.toLocaleString()}
              </span>
            ) : (
              <span className="font-mono text-[11.5px] text-ink-3 tabular-nums">0</span>
            )}
          </div>
          <button
            type="button"
            aria-label={`Import records from ${row.table}.${row.column}`}
            title="Import records from this column"
            disabled={!canEdit}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDerive();
            }}
            className="grid min-h-[44px] w-11 place-items-center text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <IconWand className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {!hideStandingBar && (
        /* standing bar — 1px hairline that fills from the left in the row's tone */
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line">
          <div
            className={cx("h-full transition-[width] duration-500", standingBarTone)}
            style={{ width: `${Math.max(0, Math.min(100, coverage))}%` }}
          />
        </div>
      )}
      {expanded && <ExpandedDrill row={row} />}
    </div>
  );
}
