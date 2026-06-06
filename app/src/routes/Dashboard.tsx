import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Kpi } from "../components/Kpi";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Mark } from "../components/Mark";
import { PageHeader } from "../components/PageHeader";
import { IconWand, IconPlus } from "../components/Icons";
import { cx } from "../lib/cx";
import { valueRows } from "../data";
import { useDimensions, useAudit, useDrafts } from "../store";
import {
  type FilterKey,
  type SortKey,
  applyFilter,
  applySort,
  coveragePct,
  coverageColor,
  lastAuditForDim,
} from "./dashboard-helpers";
import { PALETTE, defaultTintFor, type PaletteName } from "../lib/palette";

const MarkBackdrop = () => (
  <Mark className="pointer-events-none absolute -right-2 -top-12 h-48 w-48 opacity-[0.05]" />
);

function rise(i: number) {
  return { className: "zz-rise", style: { animationDelay: `${i * 70}ms` } };
}

// "4541" → "4.5k", "964123" → "964k", "12" → "12"
function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function Dashboard() {
  const dims = useDimensions();
  const auditLog = useAudit();
  const draftsMap = useDrafts();
  const navigate = useNavigate();
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const staged = Object.values(draftsMap).filter(
    (d) =>
      d.status === "mapped" &&
      dims.find((s) => s.id === d.dimId)?.values.find((v) => v.value === d.raw)?.status === "new",
  );

  // Live KPI derivations — replace the static fixtures.
  // Values mapped = total raw-value entries already in the map tables.
  // Rows at risk = warehouse source rows behind currently-unmapped values.
  // Coverage = mapped rows / (mapped rows + at-risk rows).
  const valuesMapped = dims.reduce((n, d) => n + d.rows, 0);
  const rowsAtRisk = dims.reduce(
    (n, d) => n + d.values.filter((v) => v.status === "new").reduce((m, v) => m + valueRows(v), 0),
    0,
  );
  const rowsMapped = dims.reduce(
    (n, d) =>
      n + d.values.filter((v) => v.status === "mapped").reduce((m, v) => m + valueRows(v), 0),
    0,
  );
  const coverage =
    rowsMapped + rowsAtRisk > 0 ? (rowsMapped / (rowsMapped + rowsAtRisk)) * 100 : 100;
  const attentionTables = dims.filter((d) =>
    d.values.some((v) => v.status === "new"),
  ).length;
  const cleanTables = dims.length - attentionTables;

  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("urgency");

  // Dim ids that have at least one staged draft (for filter + row highlighting)
  const stagedDimIds = useMemo(
    () => new Set(staged.map((d) => d.dimId)),
    [staged],
  );

  // Staged drafts grouped by dimId for the inline flag in table rows
  const stagedByDim = useMemo(() => {
    const map: Record<string, typeof staged> = {};
    for (const d of staged) {
      if (!map[d.dimId]) map[d.dimId] = [];
      map[d.dimId].push(d);
    }
    return map;
  }, [staged]);

  const visibleDims = useMemo(
    () => applySort(applyFilter(dims, filter, stagedDimIds), sort),
    [dims, filter, sort, stagedDimIds],
  );

  const lastAuditByDim = useMemo(
    () =>
      Object.fromEntries(
        dims.map((d) => [d.id, lastAuditForDim(d.id, d.dimension, auditLog)]),
      ),
    [dims, auditLog],
  );

  const dimTint = (dim: typeof dims[0]) => {
    const palette = dim.color ?? defaultTintFor(dim.id);
    return (PALETTE[palette as PaletteName] ?? PALETTE[defaultTintFor(dim.id)]).fg; // e.g. "var(--tint-rose)"
  };

  const kpis: Array<{
    label: string;
    value: string;
    featured?: boolean;
    delta?: string;
    dir?: "up" | "down" | "warn";
  }> = [
    {
      label: "Tables",
      value: String(dims.length),
      delta: `${attentionTables} active · ${cleanTables} clean`,
      dir: attentionTables > 0 ? "warn" : undefined,
    },
    {
      label: "Values mapped",
      value: fmtK(valuesMapped),
      delta: undefined,
      dir: undefined,
    },
    {
      label: "New to resolve",
      value: String(totalNew),
      featured: totalNew > 0,
      delta: totalNew > 0 ? `across ${attentionTables} table${attentionTables === 1 ? "" : "s"}` : undefined,
      dir: totalNew > 0 ? "warn" : undefined,
    },
    {
      label: "Rows at risk",
      value: fmtK(rowsAtRisk),
      delta: rowsAtRisk > 0 ? "unmapped warehouse rows" : undefined,
      dir: rowsAtRisk > 0 ? "warn" : undefined,
    },
  ];

  if (dims.length === 0) {
    return (
      <div className="space-y-8">
        <PageHeader
          backdrop={<MarkBackdrop />}
          kicker="Master data"
          title="Your workspace is empty"
          lede="Create a master table to start reconciling messy source values to canonical ones. Each table maps a single dimension (countries, regions, post types, …) from your warehouse."
          meta={
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link to="/app/tables">
                <Button icon={<IconPlus className="h-4 w-4" />}>Create your first table</Button>
              </Link>
              <Link to="/app/sources">
                <Button variant="secondary">Browse the warehouse</Button>
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[var(--wide)] space-y-8 p-8">
      <PageHeader
        backdrop={<MarkBackdrop />}
        kicker="Master data"
        title="Home"
        meta={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-ink-2">
            <span className="flex items-center gap-1.5">
              <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" /> live
            </span>
            <span className="text-line-2">/</span>
            <span className="tabular-nums">{dims.length} tables</span>
            <span className="text-line-2">/</span>
            <span className="tabular-nums">{fmtK(valuesMapped)} values mapped</span>
            <span className="text-line-2">/</span>
            <span className="text-accent tabular-nums">{coverage.toFixed(1)}% coverage</span>
            <span className="text-line-2">/</span>
            <span className="text-warn tabular-nums">{totalNew} new to resolve</span>
            {staged.length > 0 && (
              <>
                <span className="text-line-2">/</span>
                <span className="text-staged tabular-nums">{staged.length} staged for review</span>
              </>
            )}
          </div>
        }
        action={
          totalNew > 0 ? (
            <Link to="/app/triage">
              <Button icon={<IconWand className="h-4 w-4" />} className="zz-glow-sm">
                Resolve {totalNew} new
              </Button>
            </Link>
          ) : undefined
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((m, i) => (
          <div key={m.label} {...rise(1 + i)}>
            <Kpi
              label={m.label}
              value={m.value}
              featured={m.featured}
              delta={m.delta}
              dir={m.dir}
            />
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* filter pills */}
        {(
          [
            { key: "all" as FilterKey, label: "All", count: dims.length },
            {
              key: "attention" as FilterKey,
              label: "Needs attention",
              count: dims.filter(
                (d) => d.values.some((v) => v.status === "new") || stagedDimIds.has(d.id),
              ).length,
            },
            {
              key: "clean" as FilterKey,
              label: "Clean",
              count: dims.filter(
                (d) => !d.values.some((v) => v.status === "new") && !stagedDimIds.has(d.id),
              ).length,
            },
          ] as const
        ).map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cx(
              "flex h-6 items-center gap-1.5 rounded-sm border px-2.5 font-mono text-[10px] transition-colors",
              filter === key && key === "attention"
                ? "border-warn/40 bg-warn-soft text-warn"
                : filter === key
                  ? "border-accent/40 bg-accent-wash text-accent"
                  : "border-line-2 bg-surface-2 text-ink-3 hover:text-ink-2",
            )}
          >
            {label}
            <span className="opacity-50">{count}</span>
          </button>
        ))}

        <div className="mx-1 h-4 w-px bg-line-2" />

        {/* sort pills */}
        {(
          [
            { key: "urgency" as SortKey, label: "Urgency" },
            { key: "coverage" as SortKey, label: "Coverage" },
            { key: "name" as SortKey, label: "Name" },
            { key: "rows" as SortKey, label: "Rows" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSort(key)}
            className={cx(
              "flex h-6 items-center gap-1 rounded-sm border px-2.5 font-mono text-[10px] transition-colors",
              sort === key
                ? "border-line bg-surface-3 text-ink-2"
                : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {sort === key && <span className="opacity-60">↑</span>}
            {label}
          </button>
        ))}
      </div>

      {/* Dimension health table */}
      <div {...rise(5)}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-1 border-b border-line-2 bg-surface p-0" />
              <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
                Table
              </th>
              <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
                Coverage
              </th>
              <th className="border-b border-line-2 bg-surface px-4 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
                Records
              </th>
              <th className="border-b border-line-2 bg-surface px-4 py-2 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
                Rows
              </th>
              <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
                Status
              </th>
              <th className="border-b border-line-2 bg-surface px-4 py-2 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-ink-3">
                Last activity
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleDims.map((dim) => {
              const pct = coveragePct(dim);
              const color = coverageColor(pct);
              const newCount = dim.values.filter((v) => v.status === "new").length;
              const dimStaged = stagedByDim[dim.id] ?? [];
              const isStaged = dimStaged.length > 0;
              const lastAudit = lastAuditByDim[dim.id] ?? null;
              const tint = dimTint(dim);
              const hasUrgency = newCount > 0 || isStaged;

              return (
                <tr
                  key={dim.id}
                  onClick={() => navigate(`/app/tables?open=${dim.id}&active=${dim.id}&mode=match`)}
                  className={cx(
                    "cursor-pointer",
                    isStaged ? "bg-staged/[0.04] hover:bg-staged/[0.07]" : "bg-surface hover:bg-hover",
                  )}
                >
                  {/* tint accent bar — only on urgent rows */}
                  <td className="p-0">
                    {hasUrgency && (
                      <div
                        className="h-10 w-[3px] rounded-sm"
                        style={{ background: tint }}
                      />
                    )}
                  </td>

                  {/* table name + map table + optional staged flag */}
                  <td className="border-b border-line px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div
                        className="h-2 w-2 shrink-0 rounded-pill"
                        style={{ background: tint }}
                      />
                      <div className="min-w-0">
                        <div className="font-display text-[13px] font-semibold text-ink">
                          {dim.dimension}
                        </div>
                        <div className="font-mono text-[9px] text-ink-3">{dim.mapTable}</div>
                        {isStaged && (
                          <div className="mt-1 flex items-center gap-1 rounded-sm border border-staged/25 bg-staged-soft px-1.5 py-0.5 font-mono text-[9px] text-staged w-fit">
                            <span>⏸</span>
                            <span>
                              {dimStaged.length} staged
                              {dimStaged[0]
                                ? ` · ${dimStaged[0].user.initials} staged "${dimStaged[0].raw}"`
                                : ""}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* coverage bar + pct */}
                  <td className="border-b border-line px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-[3px] w-[72px] overflow-hidden rounded-pill bg-surface-3">
                        <div
                          className="h-full rounded-pill"
                          style={{ width: `${pct}%`, background: color }}
                        />
                      </div>
                      <span
                        className="min-w-[28px] font-mono text-[11px] tabular-nums"
                        style={{ color }}
                      >
                        {pct}%
                      </span>
                    </div>
                  </td>

                  {/* records */}
                  <td className="border-b border-line px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-2">
                    {dim.canonical.length.toLocaleString()}
                  </td>

                  {/* rows */}
                  <td className="border-b border-line px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-2">
                    {fmtK(dim.rows)}
                  </td>

                  {/* status badge */}
                  <td className="border-b border-line px-4 py-2.5">
                    {newCount > 0 ? (
                      <Badge tone={newCount > 5 ? "accent" : "warn"} dot>
                        {newCount} new
                      </Badge>
                    ) : isStaged ? (
                      <Badge tone="staged" dot>
                        staged
                      </Badge>
                    ) : (
                      <Badge tone="ok" dot>
                        clean
                      </Badge>
                    )}
                  </td>

                  {/* last activity */}
                  <td className="border-b border-line px-4 py-2.5">
                    {lastAudit ? (
                      <div className="flex items-center gap-1.5">
                        <span
                          className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-pill bg-surface-3 font-mono text-[7px] font-semibold text-ink-2"
                        >
                          {lastAudit.user.initials}
                        </span>
                        <span className="font-mono text-[10px] text-ink-3">
                          {lastAudit.action} · {lastAudit.at}
                        </span>
                      </div>
                    ) : (
                      <span className="font-mono text-[10px] text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              );
            })}

            {/* empty filter state */}
            {visibleDims.length === 0 && (
              <tr>
                <td colSpan={7} className="border-b border-line px-4 py-12 text-center">
                  <div className="font-display text-[20px] text-ink-2">
                    {filter === "attention"
                      ? "Nothing needs attention."
                      : filter === "clean"
                        ? "No tables are fully clean yet."
                        : "No tables match."}
                  </div>
                  <p className="mx-auto mt-2 max-w-[44ch] text-[12.5px] text-ink-3">
                    {filter === "attention"
                      ? "Every table is mapped or has its drafts published."
                      : filter === "clean"
                        ? "Resolve the new values in your active tables to flip them clean."
                        : "Try a different filter."}
                  </p>
                  {filter !== "all" && (
                    <button
                      type="button"
                      onClick={() => setFilter("all")}
                      className="mt-3 font-mono text-[11px] text-accent transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-sm"
                    >
                      Show all tables →
                    </button>
                  )}
                </td>
              </tr>
            )}

          </tbody>
        </table>
      </div>

    </div>
  );
}
