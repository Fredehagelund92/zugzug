/* RecordHistoryDrawer — an in-context panel showing one record's full change
 *  history: who changed what, when, and — for field edits and renames — the
 *  before → after value. Reuses the activity-feed formatting (day dividers,
 *  threading rail, kind glyph) from `../lib/audit-format` so it reads like a
 *  focused lens on the same log the Activity page shows. Opened from the grid's
 *  row / cell context menu; the record stays one Escape away. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AuditEntry } from "../store";
import { useRecordHistory } from "../lib/use-record-history";
import { absoluteTime, dayBucket, humanize, KindGlyph, relativeTime } from "../lib/audit-format";
import { cx } from "../lib/cx";

export interface RecordHistoryDrawerProps {
  open: boolean;
  /** RefTable / table id the record lives in. */
  tableId: string | null;
  /** Stable record key (slug) — the history anchor. */
  rowKey: string | null;
  /** Record's current display label, for the drawer title. */
  recordLabel: string | null;
  /** Table's display name, shown under the title. */
  tableName?: string | null;
  /** When opened from a specific cell, the field id — its entries are
   *  highlighted and can be isolated with the header filter. */
  field?: string | null;
  /** Whether the reader may restore historical values (edit permission). */
  canRestore?: boolean;
  /** Restore a field to a past value. field === "label" renames the record.
   *  Resolves once the write lands so the timeline can refresh. */
  onRestore?: (field: string, value: string | null) => void | Promise<void>;
  onClose: () => void;
}

// --- diff extraction -------------------------------------------------------

interface Diff {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

/** A "before → after" edit carries these keys in its audit metadata (see
 *  setFieldValue / renameRecord). Older entries logged before enrichment
 *  won't have them and fall back to the plain event line. */
function extractDiff(metadata: AuditEntry["metadata"]): Diff | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  if (!("before" in m) && !("after" in m)) return null;
  const field = typeof m.field === "string" ? m.field : "";
  const label = typeof m.label === "string" ? m.label : field;
  const norm = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return { field, label, before: norm(m.before), after: norm(m.after) };
}

// --- component -------------------------------------------------------------

const CLOSE_MS = 280; // keep in step with --dur-slide

export function RecordHistoryDrawer(props: RecordHistoryDrawerProps) {
  const { open, tableId, rowKey, recordLabel, tableName, field, canRestore, onRestore, onClose } =
    props;

  // Mount/unmount around the slide so the panel animates both ways. `shown`
  // drives the transform; it flips on after mount and off before unmount.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setMounted(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  // Return focus to whatever opened the drawer once it's fully closed.
  useEffect(() => {
    if (!mounted && restoreFocusRef.current) {
      restoreFocusRef.current.focus?.();
      restoreFocusRef.current = null;
    }
  }, [mounted]);

  // Escape to close + focus trap, mirroring ConfirmDialog.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const f = panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])',
        );
        if (!f || f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" aria-hidden={!open}>
      {/* Backdrop — refTables the grid, click to dismiss. */}
      <button
        type="button"
        aria-label="Close history"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-[2px] transition-opacity"
        style={{ opacity: shown ? 1 : 0, transitionDuration: "var(--dur-slide)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-history-title"
        className="absolute right-0 top-0 flex h-full w-[min(420px,92vw)] flex-col border-l border-line bg-surface shadow-lg"
        style={{
          transform: shown ? "none" : "translateX(100%)",
          transition: "transform var(--dur-slide) var(--ease-spring)",
        }}
      >
        <DrawerHeader recordLabel={recordLabel} tableName={tableName} onClose={onClose} />
        <DrawerBody
          tableId={tableId}
          rowKey={rowKey}
          open={open}
          field={field ?? null}
          onRestore={canRestore ? onRestore : undefined}
        />
      </div>
    </div>,
    document.body,
  );
}

function DrawerHeader({
  recordLabel,
  tableName,
  onClose,
}: {
  recordLabel: string | null;
  tableName?: string | null;
  onClose: () => void;
}) {
  return (
    <header className="flex items-start gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
          History
        </p>
        <h2
          id="record-history-title"
          className="mt-1 truncate font-display text-[17px] font-bold leading-tight text-ink"
          title={recordLabel ?? undefined}
        >
          {recordLabel || "Record"}
        </h2>
        {tableName && <p className="mt-0.5 truncate text-[12px] text-ink-2">{tableName}</p>}
      </div>
      <button
        type="button"
        data-autofocus
        onClick={onClose}
        aria-label="Close history"
        className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </header>
  );
}

function DrawerBody({
  tableId,
  rowKey,
  open,
  field,
  onRestore,
}: {
  tableId: string | null;
  rowKey: string | null;
  open: boolean;
  field: string | null;
  onRestore?: (field: string, value: string | null) => void | Promise<void>;
}) {
  const { entries, loading, loadingMore, error, hasMore, loadMore, reload } = useRecordHistory(
    tableId,
    rowKey,
    open,
  );

  // A restore is an ordinary edit to a past value — after it lands, refresh so
  // the new entry appears at the top and the "current value" markers update.
  const handleRestore = useCallback(
    async (f: string, value: string | null) => {
      await onRestore?.(f, value);
      reload();
    },
    [onRestore, reload],
  );
  // "Only this field" filter, offered when the drawer was opened from a cell.
  const [fieldOnly, setFieldOnly] = useState(false);
  useEffect(() => setFieldOnly(false), [rowKey, field]);

  // Human label for the focused field — pulled from any of its own entries.
  const fieldLabel = useMemo(() => {
    if (!field) return null;
    for (const e of entries) {
      const d = extractDiff(e.metadata);
      if (d?.field === field) return d.label;
    }
    return field;
  }, [entries, field]);

  const visible = useMemo(
    () =>
      fieldOnly && field
        ? entries.filter((e) => extractDiff(e.metadata)?.field === field)
        : entries,
    [entries, fieldOnly, field],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {field && fieldLabel && (
        <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
          <span className="text-[12px] text-ink-3">Focused on</span>
          <button
            type="button"
            onClick={() => setFieldOnly((v) => !v)}
            aria-pressed={fieldOnly}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
              fieldOnly
                ? "border-transparent bg-accent text-accent-ink"
                : "border-line text-ink-2 hover:bg-surface-2",
            )}
          >
            {fieldLabel}
            {fieldOnly && (
              <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
          <span className="text-[11px] text-ink-3">
            {fieldOnly ? "showing only this field" : "tap to isolate"}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <HistorySkeleton />
        ) : error ? (
          <ErrorState onRetry={reload} />
        ) : visible.length === 0 ? (
          <EmptyState fieldOnly={fieldOnly && !!field} />
        ) : (
          <>
            <RecordHistoryTimeline
              entries={visible}
              focusField={field}
              onRestore={onRestore ? handleRestore : undefined}
            />

            {hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load older"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Presentational timeline: groups entries by day and threads them on the rail,
 *  matching the Activity feed. Pure — no data fetching — so it's easy to preview
 *  and unit-test with fixtures. */
export function RecordHistoryTimeline({
  entries,
  focusField = null,
  onRestore,
}: {
  entries: AuditEntry[];
  focusField?: string | null;
  onRestore?: (field: string, value: string | null) => void | Promise<void>;
}) {
  const grouped = useMemo(() => {
    const out: { key: string; label: string; items: AuditEntry[] }[] = [];
    for (const r of entries) {
      const b = dayBucket(r.at);
      const last = out[out.length - 1];
      if (last && last.key === b.key) last.items.push(r);
      else out.push({ ...b, items: [r] });
    }
    return out;
  }, [entries]);

  // Which entries can be restored: a concrete past value that isn't already the
  // field's current value. Entries are newest-first, so the first diff seen per
  // field holds the current value (never restorable — it's a no-op).
  const restorableIds = useMemo(() => {
    if (!onRestore) return new Set<string>();
    const current = new Map<string, string | null>();
    const ok = new Set<string>();
    for (const e of entries) {
      const d = extractDiff(e.metadata);
      if (!d) continue;
      if (!current.has(d.field)) {
        current.set(d.field, d.after);
        continue;
      }
      if (d.after !== null && d.after !== current.get(d.field)) ok.add(e.id);
    }
    return ok;
  }, [entries, onRestore]);

  return (
    <div className="space-y-7">
      {grouped.map((g) => (
        <section key={g.key} aria-labelledby={`rh-day-${g.key}`}>
          <header className="mb-1.5 flex items-center gap-3">
            <h3
              id={`rh-day-${g.key}`}
              className="font-mono text-[10.5px] font-medium uppercase tracking-[0.2em] text-ink-2"
            >
              {g.label}
            </h3>
            <span aria-hidden className="h-px flex-1 bg-line" />
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] tabular-nums text-ink-3">
              {g.items.length} change{g.items.length === 1 ? "" : "s"}
            </span>
          </header>
          <ol className="relative">
            <span
              aria-hidden
              className="absolute left-[13px] top-[26px] bottom-[26px] w-px"
              style={{ background: "var(--line)" }}
            />
            {g.items.map((row) => (
              <HistoryRow
                key={row.id}
                row={row}
                focusField={focusField}
                onRestore={restorableIds.has(row.id) ? onRestore : undefined}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function HistoryRow({
  row,
  focusField,
  onRestore,
}: {
  row: AuditEntry;
  focusField: string | null;
  onRestore?: (field: string, value: string | null) => void | Promise<void>;
}) {
  const diff = extractDiff(row.metadata);
  const phrase = humanize(row);
  const isFocused = !!focusField && diff?.field === focusField;
  const restore = diff && onRestore ? () => onRestore(diff.field, diff.after) : undefined;

  return (
    <li className="relative">
      <div className="relative flex items-start gap-3 py-3">
        <KindGlyph kind={phrase.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] leading-snug text-ink">
              <span className="font-semibold">{row.user.name}</span>{" "}
              <span className="text-ink-2">{phrase.verb}</span>
              {phrase.noun && <span className="text-ink-2"> {phrase.noun}</span>}
            </p>
            <time
              dateTime={row.at}
              title={absoluteTime(row.at)}
              className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3"
            >
              {relativeTime(row.at)}
            </time>
          </div>

          {diff ? (
            <DiffBlock diff={diff} focused={isFocused} onRestore={restore} />
          ) : (
            phrase.target && (
              <p className="mt-1 truncate font-mono text-[12px] text-ink-2" title={phrase.target}>
                {phrase.target}
              </p>
            )
          )}
        </div>
      </div>
    </li>
  );
}

/* The signature element: a value's move from old to new, boxed as a small "value
   card". Old value struck through, new value carried in ink. Colour is reserved
   for the one thing that needs it — the field the reader came in focused on.
   When the value is a restorable past state, a quiet "Restore" reveals on hover;
   because restoring overwrites the current value, it asks for confirmation
   inline before committing. */
function DiffBlock({
  diff,
  focused,
  onRestore,
}: {
  diff: Diff;
  focused: boolean;
  onRestore?: () => void | Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "pending">("idle");
  const valueLabel = diff.after === null ? "empty" : `"${diff.after}"`;
  const confirm = async () => {
    if (!onRestore) return;
    setPhase("pending");
    try {
      await onRestore();
    } finally {
      setPhase("idle");
    }
  };
  return (
    <div
      className={cx(
        "group/diff mt-1.5 rounded-md border-l-2 py-1 pl-2.5 pr-1 transition-colors",
        focused ? "bg-accent-soft" : "bg-surface-2/40",
      )}
      style={{ borderColor: focused ? "var(--accent)" : "var(--line-2)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
          {diff.label}
        </p>
        {onRestore && phase === "pending" && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
            Restoring…
          </span>
        )}
        {onRestore && phase === "confirm" && (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPhase("idle")}
              aria-label="Cancel restore"
              className="rounded font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 transition-colors hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              aria-label={`Confirm restoring ${diff.label || "value"} to ${valueLabel}`}
              className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-accent-ink"
            >
              Restore
            </button>
          </span>
        )}
        {onRestore && phase === "idle" && (
          <button
            type="button"
            onClick={() => setPhase("confirm")}
            aria-label={`Restore ${diff.label || "value"} to ${valueLabel}`}
            className="inline-flex shrink-0 items-center gap-1 rounded font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3 opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/diff:opacity-100"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M6 4 3 7l3 3M3.2 7H9a4 4 0 0 1 0 8H7.5"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Restore
          </button>
        )}
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[12.5px]">
        <Value v={diff.before} tone="old" />
        <span aria-hidden className="text-ink-3">
          →
        </span>
        <Value v={diff.after} tone="new" />
      </p>
    </div>
  );
}

function Value({ v, tone }: { v: string | null; tone: "old" | "new" }) {
  if (v === null) {
    return <span className="italic text-ink-3">empty</span>;
  }
  return (
    <span
      className={cx(
        "max-w-full truncate",
        tone === "old" ? "text-ink-3 line-through decoration-ink-3/50" : "text-ink",
      )}
      title={v}
    >
      {v}
    </span>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3 py-2">
          <span className="ak-skeleton h-7 w-7 rounded-full" />
          <div className="flex-1 space-y-2 pt-1">
            <span className="ak-skeleton block h-3 w-2/3 rounded" />
            <span className="ak-skeleton block h-3 w-2/5 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ fieldOnly }: { fieldOnly: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-ink-3">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </span>
      <p className="mt-3 text-[13px] font-medium text-ink">
        {fieldOnly ? "No changes to this field yet" : "No changes recorded yet"}
      </p>
      <p className="mt-1 text-[12px] text-ink-2">
        {fieldOnly
          ? "Edits to this field will show up here."
          : "Edits, renames, and merges for this record will show up here."}
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="text-[13px] font-medium text-ink">Couldn&apos;t load history</p>
      <p className="mt-1 text-[12px] text-ink-2">Check your connection and try again.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-md border border-line px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-surface-2"
      >
        Try again
      </button>
    </div>
  );
}
