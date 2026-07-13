import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useNavLinks } from "../../lib/use-tenant-navigate";
import { Button } from "../Button";
import { IconArrowRight, IconWand } from "../Icons";
import { LedgerRow } from "../sources/LedgerRow";
import { ago } from "../sources/utils";
import { PALETTE } from "../../lib/palette";
import { cx } from "../../lib/cx";
import { deriveCanonical, useSources, useCanEdit } from "../../store";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { toast } from "../Toast";
import type { MappingDimension } from "../../data";

/* WiredSourcesModeBody — third mode for a per-table workbench tab. A console
   panel reading "this table's plumbing": KPI strip up top (coverage, unmapped,
   last scan, schedules), the LedgerRow list condensed to this dim only, and a
   reverse handoff into the full Sources route. A per-dim color stripe on the
   left edge signals which table the panel belongs to — mirrors the tab-strip
   monogram convention. */

interface Props {
  dim: MappingDimension;
}

export function WiredSourcesModeBody({ dim }: Props) {
  const sources = useSources();
  const [expanded, setExpanded] = useState<string | null>(null);
  const wired = useMemo(() => sources.filter((s) => s.dimId === dim.id), [sources, dim.id]);
  const canEdit = useCanEdit();
  const nav = useNavLinks();
  const deriveAction = useAsyncAction(async (dimId: string, table: string, column: string) => {
    const n = await deriveCanonical(dimId, table, column);
    toast(
      n > 0
        ? `Imported ${n} record${n === 1 ? "" : "s"} from ${table}.${column}`
        : `${table}.${column} has no rows to import`,
    );
  });

  // Per-dim accent for the left stripe + kicker. Falls back to brand accent
  // when the table hasn't been assigned a palette tint.
  const tint = dim.color ? PALETTE[dim.color] : null;
  const stripeBg = tint ? tint.bg : "var(--accent)";
  const kickerFg = tint ? tint.fg : "var(--accent)";

  // ── Aggregates ──────────────────────────────────────────────────────────
  const agg = useMemo(() => {
    let values = 0;
    let unmapped = 0;
    let rows = 0;
    let lastScannedAt: string | null = null;
    let worstUnmapped = 0;
    for (const s of wired) {
      values += s.values;
      unmapped += s.unmapped;
      rows += s.rows;
      if (s.unmapped > worstUnmapped) worstUnmapped = s.unmapped;
      if (s.scannedAt && (!lastScannedAt || new Date(s.scannedAt) > new Date(lastScannedAt))) {
        lastScannedAt = s.scannedAt;
      }
    }
    const coverage = values > 0 ? Math.round(((values - unmapped) / values) * 100) : 100;
    const schemas = new Set(wired.map((s) => s.table.split(".")[0]));
    return { values, unmapped, rows, coverage, lastScannedAt, schemas, worstUnmapped };
  }, [wired]);

  // ── Empty state — no wiring yet ─────────────────────────────────────────
  if (wired.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 py-16">
        <div className="zz-rise max-w-[42ch] text-center" style={{ animationDelay: "60ms" }}>
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center border border-line bg-surface-2 text-ink-3">
            <IconWand className="h-5 w-5" />
          </div>
          <div className="font-display text-[20px] font-semibold tracking-[-0.01em] text-ink">
            No sources wired to {dim.dimension} yet.
          </div>
          <p className="mx-auto mt-2 text-[13px] leading-snug text-ink-3">
            Wire a warehouse column to start watching for new {dim.dimension.toLowerCase()} values.
          </p>
          <div className="mt-5 inline-flex">
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

  // ── Main panel ───────────────────────────────────────────────────────────
  const schemaCount = agg.schemas.size;
  const firstSchema = wired[0].table.split(".")[0];

  return (
    <div className="zz-fade-in flex flex-1 flex-col min-h-0">
      {/* Per-dim color stripe on the left edge — the workbench signature for
          "which table am I looking at". The container itself is transparent so
          the canvas grid bleeds through below the last row; the hero header
          and each LedgerRow paint their own bg-surface. */}
      <div
        className="relative flex flex-1 flex-col min-h-0 border-l-2"
        style={{ borderLeftColor: stripeBg }}
      >
        {/* Hero strip — kicker, count, KPI ribbon, reverse handoff */}
        <header className="relative border-b border-line bg-surface px-7 pt-5 pb-4">
          {/* a 1px accent edge at the very top — the folder-tab signature, mini */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent"
          />
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <div
                className="flex items-baseline gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.22em]"
                style={{ color: kickerFg }}
              >
                <span
                  className={cx("zz-live h-1.5 w-1.5 rounded-pill")}
                  style={{ background: stripeBg }}
                />
                Wired sources · {dim.dimension}
              </div>
              <h2 className="mt-2 font-display text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">
                <span className="tabular-nums">{wired.length}</span>{" "}
                <span className="text-ink-2">column{wired.length === 1 ? "" : "s"} watched</span>
                <span className="ml-2 font-mono text-[12px] text-ink-3">
                  across {schemaCount} schema{schemaCount === 1 ? "" : "s"}
                </span>
              </h2>
            </div>
            <Link to={`${nav.sources}?focus=${encodeURIComponent(firstSchema)}`}>
              <Button
                variant="secondary"
                size="sm"
                icon={<IconArrowRight className="h-3.5 w-3.5" />}
              >
                View in Sources
              </Button>
            </Link>
          </div>

          {/* KPI ribbon — coverage with hairline bar, then mono stats, then schedule rollup */}
          <div className="mt-4 flex items-center gap-x-6 gap-y-2 overflow-x-auto border-t border-line pt-3 font-mono text-[11px] text-ink-3 [scrollbar-width:none] max-md:flex-nowrap">
            {/* Coverage with progress bar — the headline metric */}
            <div className="flex items-center gap-2.5">
              <span className="uppercase tracking-wider">Coverage</span>
              <div className="h-1.5 w-32 overflow-hidden rounded-pill bg-surface-2">
                <div
                  className={cx(
                    "h-full rounded-pill transition-[width] duration-[var(--dur-slide)] ease-[var(--ease-spring)]",
                    agg.coverage >= 95 ? "bg-ok" : agg.coverage >= 70 ? "bg-warn" : "bg-accent",
                  )}
                  style={{ width: `${agg.coverage}%` }}
                />
              </div>
              <span className="tabular-nums text-ink-2">{agg.coverage}%</span>
            </div>

            <span className="text-line-2">·</span>

            {/* Unmapped count — accent when nonzero, the spec's "accent-as-status" */}
            <span>
              {agg.unmapped > 0 ? (
                <>
                  <span className="font-semibold tabular-nums text-accent">
                    {agg.unmapped.toLocaleString()}
                  </span>{" "}
                  <span className="text-ink-3">unmapped</span>
                </>
              ) : (
                <span className="text-ok">✓ everything resolved</span>
              )}
            </span>

            <span className="text-line-2">·</span>

            <span>
              <span className="tabular-nums text-ink-2">{agg.rows.toLocaleString()}</span>{" "}
              <span className="text-ink-3">rows watched</span>
            </span>

            {agg.lastScannedAt && (
              <span className="ml-auto">
                <span className="text-ink-3">last scan </span>
                <span className="text-ink-2">{ago(agg.lastScannedAt)} ago</span>
              </span>
            )}
          </div>
        </header>

        {/* Sticky column header so the LedgerRow grid reads at scale */}
        <div className="sticky top-0 z-10 overflow-x-auto border-b border-line bg-surface/95 backdrop-blur-sm">
          <div className="grid min-w-[480px] grid-cols-[20px_minmax(0,1fr)_minmax(110px,1fr)_88px_72px_88px] items-center gap-4 px-7 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
            <span />
            <span>Column → record</span>
            <span>Standing</span>
            <span className="text-right">Rows</span>
            <span className="text-right">Unmapped</span>
            <span className="text-right">Actions</span>
          </div>
        </div>

        {/* Row list — each LedgerRow paints its own bg-surface so the canvas
            grid bleeds through the empty space below the last row. The
            coverage-encoded standing bar is hidden here (it's load-bearing
            density in the full Sources ledger; chartjunk in a 1–3 row panel). */}
        <div className="flex-1 overflow-y-auto">
          {wired.map((row) => {
            const key = `${row.dimId}::${row.table}::${row.column}`;
            return (
              <LedgerRow
                key={key}
                row={row}
                expanded={expanded === key}
                hideStandingBar
                onToggle={() => setExpanded(expanded === key ? null : key)}
                onDerive={
                  canEdit
                    ? () => void deriveAction.run(row.dimId, row.table, row.column)
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
