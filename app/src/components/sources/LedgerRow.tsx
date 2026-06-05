import { ScanScheduleMenu } from "../ScanScheduleMenu";
import { IconChevron, IconWand } from "../Icons";
import { cx } from "../../lib/cx";
import type { SourceInfo } from "../../store";
import { SCHED_LABEL, STALE_DAYS, ago, daysAgo } from "./utils";
import { ExpandedDrill } from "./ExpandedDrill";

/* LedgerRow — a single wired-column line in the Sources ledger. Extracted
   from `routes/Sources.tsx` so the per-table workbench's "wired sources" mode
   body can render the same row without dragging the whole route along. The
   component is props-only; no Sources-scope closures. */

interface LedgerRowProps {
  row: SourceInfo;
  expanded: boolean;
  onToggle: () => void;
  onScheduleChange: (next: string | null) => void;
  onDerive: () => void;
}

export function LedgerRow({
  row,
  expanded,
  onToggle,
  onScheduleChange,
  onDerive,
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
      className={cx("relative transition-colors", expanded ? "bg-surface-2/40" : "hover:bg-hover")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[20px_minmax(0,1fr)_minmax(110px,1fr)_88px_72px_88px] items-center gap-4 px-7 py-2.5 text-left"
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
            {row.schedule && <span>· {SCHED_LABEL[row.schedule] ?? row.schedule}</span>}
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
          <ScanScheduleMenu value={row.schedule ?? null} onChange={onScheduleChange} />
          <button
            type="button"
            aria-label={`Import records from ${row.table}.${row.column}`}
            title="Import records from this column"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDerive();
            }}
            className="grid h-6 w-6 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
          >
            <IconWand className="h-3 w-3" />
          </button>
        </div>
      </button>
      {/* standing bar — 1px hairline that fills from the left in the row's tone */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line">
        <div
          className={cx("h-full transition-[width] duration-500", standingBarTone)}
          style={{ width: `${Math.max(0, Math.min(100, coverage))}%` }}
        />
      </div>
      {expanded && <ExpandedDrill row={row} />}
    </div>
  );
}
