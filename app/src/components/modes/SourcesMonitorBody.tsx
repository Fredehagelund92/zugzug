import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { MappingRefTable } from "../../data";
import { useSources, useCanEdit, deriveRecord } from "../../store";
import { sortByUrgency, summarizeSources, type SourceStatus } from "../../lib/source-status";
import { useNavLinks } from "../../lib/use-tenant-navigate";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { toast } from "../Toast";
import { Button } from "../Button";
import { IconWand, IconArrowRight } from "../Icons";
import { cx } from "../../lib/cx";
import { ago } from "../sources/utils";

const STATUS_META: Record<SourceStatus, { label: string; pill: string; bar: string }> = {
  broken: { label: "Broken", pill: "bg-danger-soft text-danger", bar: "border-l-danger" },
  new: { label: "New values", pill: "bg-warn-soft text-warn", bar: "border-l-warn" },
  stale: { label: "Not checked", pill: "bg-surface-2 text-ink-3", bar: "border-l-ink-3" },
  healthy: { label: "Healthy", pill: "bg-ok-soft text-ok", bar: "border-l-committed" },
};

/* SourcesMonitorBody — the "plumbing" view for one table. Classifies each wired
   column into four action states, orders by urgency, and hands the mapping work
   off to Map values. Scanning is automatic; per-row Re-check is the exception. */
export function SourcesMonitorBody({ refTable }: { refTable: MappingRefTable }) {
  const sources = useSources();
  const canEdit = useCanEdit();
  const nav = useNavLinks();
  const wired = useMemo(
    () => sources.filter((s) => s.refTableId === refTable.id),
    [sources, refTable.id],
  );
  const ranked = useMemo(() => sortByUrgency(wired), [wired]);
  const summary = useMemo(() => summarizeSources(wired), [wired]);

  const recheck = useAsyncAction(async (table: string, column: string) => {
    try {
      await deriveRecord(refTable.id, table, column);
      toast(`Re-checked ${table}.${column}`);
    } catch (e) {
      toast(
        e instanceof Error
          ? `Couldn't re-check ${table}.${column}: ${e.message}`
          : `Couldn't re-check ${table}.${column}.`,
        "error",
      );
      throw e;
    }
  });

  if (wired.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 py-16">
        <div className="max-w-[46ch] text-center">
          <div className="rounded-lg mx-auto mb-4 grid h-12 w-12 place-items-center border border-line bg-surface-2 text-ink-3">
            <IconWand className="h-5 w-5" />
          </div>
          <div className="font-display text-[20px] font-semibold text-ink">
            Watch a column to get started.
          </div>
          <p className="mx-auto mt-2 text-[13px] leading-snug text-ink-3">
            Point Sources at a warehouse column and Zugzug catches new {refTable.refTable} values as
            they appear — no manual re-checking.
          </p>
          <ol className="mx-auto mt-5 flex max-w-[40ch] flex-col gap-2 text-left">
            {[
              { n: "1", text: <>Pick a column that holds {refTable.refTable} values.</> },
              {
                n: "2",
                text: <>Zugzug scans it automatically and flags values without a record.</>,
              },
              { n: "3", text: <>Map them in one place — this list shows what needs a look.</> },
            ].map((step) => (
              <li
                key={step.n}
                className="flex items-start gap-2.5 text-[12px] leading-snug text-ink-2"
              >
                <span className="rounded-sm grid h-4 w-4 flex-none place-items-center border border-line font-mono text-[9px] text-ink-3">
                  {step.n}
                </span>
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
          <div className="mt-6 inline-flex">
            <Link to={nav.sources}>
              <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
                Browse warehouse
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const chips = [
    { n: summary.broken, label: "broken", dot: "bg-danger" },
    { n: summary.needsMapping, label: "need mapping", dot: "bg-warn" },
    { n: summary.notChecked, label: "not checked", dot: "bg-ink-3" },
    { n: summary.healthy, label: "healthy", dot: "bg-committed" },
  ];
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
      {/* wiring-health header */}
      <header className="border-b border-line bg-surface px-5 pt-5 pb-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
          sources · {refTable.refTable}
        </div>
        <h2 className="mt-2 font-display text-[22px] font-semibold tracking-[-0.02em] text-ink">
          <span className="tabular-nums">{wired.length}</span>{" "}
          <span className="text-ink-2">column{wired.length === 1 ? "" : "s"} feed this table</span>
        </h2>
        {/* at-a-glance wiring health */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {chips.map((c) => (
            <span
              key={c.label}
              className={cx(
                "inline-flex items-center gap-1.5 font-mono text-[11px]",
                c.n === 0 && "opacity-40",
              )}
            >
              <span className={cx("h-1.5 w-1.5 rounded-pill", c.dot)} aria-hidden="true" />
              <span className="font-semibold tabular-nums text-ink">{c.n}</span>
              <span className="text-ink-3">{c.label}</span>
            </span>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-ink-3">
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full rounded-pill bg-committed opacity-70 motion-safe:animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-pill bg-committed" />
          </span>
          Checked automatically · re-check any column below to refresh it now
        </div>
      </header>

      {summary.newValuesTotal > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-accent-wash px-5 py-3">
          <span className="text-[14px] text-ink">
            <span className="font-semibold">
              {summary.newValuesTotal.toLocaleString("en-US")} new values
            </span>{" "}
            across {summary.needsMapping} column{summary.needsMapping === 1 ? "" : "s"} need a
            record.
          </span>
          <Link to={nav.table(refTable.id, "match")} className="ml-auto">
            <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
              Map them
            </Button>
          </Link>
        </div>
      )}

      {/* per-column status rows, urgency-ordered */}
      <ul className="flex flex-col">
        {ranked.map(({ source: s, status: st }) => {
          const meta = STATUS_META[st.status];
          return (
            <li
              key={`${s.table}.${s.column}`}
              className={cx(
                "grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-line border-l-2 bg-surface px-5 py-3.5",
                meta.bar,
              )}
            >
              <span
                className={cx(
                  "rounded-pill px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide",
                  meta.pill,
                )}
              >
                {meta.label}
              </span>
              <div className="min-w-0">
                <div className="font-mono text-[14px] font-semibold text-ink">
                  {s.table}
                  <span className="text-ink-3">.{s.column}</span>
                  <span className="text-ink-3"> → {refTable.refTable}</span>
                </div>
                <div className="mt-1 font-mono text-[11.5px] text-ink-3">
                  {st.status === "broken"
                    ? "Column no longer exists in the warehouse"
                    : st.status === "stale" && !s.scanned
                      ? "Never scanned since it was wired"
                      : `${s.rows.toLocaleString("en-US")} rows${s.scannedAt ? ` · checked ${ago(s.scannedAt)} ago` : ""}${st.stale ? " · counts may be stale" : ""}`}
                </div>
              </div>
              <div className="text-right">
                <div
                  className={cx(
                    "font-mono text-[17px] font-semibold tabular-nums",
                    st.status === "new" ? "text-warn" : "text-ink-3",
                  )}
                >
                  {st.status === "new"
                    ? st.unmapped.toLocaleString("en-US")
                    : st.status === "healthy"
                      ? "0"
                      : "—"}
                </div>
                <div className="font-mono text-[10px] text-ink-3">
                  {st.status === "healthy"
                    ? "all resolved"
                    : st.status === "new"
                      ? "need a record"
                      : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {st.status === "new" && (
                  <Link to={nav.table(refTable.id, "match")}>
                    <Button size="sm">Map these</Button>
                  </Link>
                )}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Re-check ${s.column}`}
                    onClick={() => void recheck.run(s.table, s.column)}
                    className="rounded-sm grid h-8 w-8 place-items-center border border-line text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    <IconWand className="h-4 w-4" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
