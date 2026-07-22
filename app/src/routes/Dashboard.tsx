import { useState, useMemo } from "react";
import { usePageTitle } from "../hooks/usePageTitle";
import { Link, useNavigate } from "react-router-dom";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { useTenant } from "../lib/tenant-context";
import { Kpi } from "../components/Kpi";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Mark } from "../components/Mark";
import { PageHeader } from "../components/PageHeader";
import { IconWand, IconPlus } from "../components/Icons";
import { cx } from "../lib/cx";
import { useDimensions, useAudit, useWorkspaceInfo, useStoreLoading } from "../store";
import {
  type FilterKey,
  type SortKey,
  type SortDir,
  applyFilter,
  applySort,
  coveragePct,
  formatTimeAgo,
  toPublishCount,
  warehouseSyncStatusByDim,
} from "./dashboard-helpers";
import { PALETTE, defaultTintFor, type PaletteName } from "../lib/palette";

const MarkBackdrop = () => (
  <Mark className="pointer-events-none absolute -right-2 -top-12 h-48 w-48 opacity-[0.05]" />
);

/* EmptyStateIllustration — tells the Zugzug story in a single picture:
   three scattered source values (left) reconciled into one approved record (right).
   Token-driven (ink/line/accent), animated reveal via zz-rise. */
const EmptyStateIllustration = () => (
  <div className="zz-rise relative mx-auto flex h-44 w-full max-w-md items-center justify-center md:h-56">
    <svg viewBox="0 0 360 200" fill="none" className="h-full w-full" aria-hidden="true">
      <defs>
        <pattern id="zz-grid" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <path
            d="M 14 0 L 0 0 0 14"
            className="text-line-2"
            stroke="currentColor"
            strokeWidth="0.5"
          />
        </pattern>
      </defs>

      {/* Subtle grid background */}
      <rect width="360" height="200" fill="url(#zz-grid)" opacity="0.4" />

      {/* Left column — three scattered source variants */}
      <g className="text-line" stroke="currentColor" strokeWidth="1.25">
        <rect x="24" y="36" width="118" height="28" rx="6" fill="var(--bg)" />
        <rect x="24" y="86" width="118" height="28" rx="6" fill="var(--bg)" />
        <rect x="24" y="136" width="118" height="28" rx="6" fill="var(--bg)" />
      </g>
      <g className="font-mono text-ink-2" fontSize="11" fontFamily="ui-monospace, monospace">
        <text x="38" y="55">
          espn
        </text>
        <text x="38" y="105">
          E.S.P.N
        </text>
        <text x="38" y="155">
          Espn Inc.
        </text>
      </g>

      {/* Connection lines — dashed, accent */}
      <g
        className="text-accent"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        fill="none"
      >
        <path d="M 142 50 C 190 50, 200 100, 218 100" />
        <path d="M 142 100 L 218 100" />
        <path d="M 142 150 C 190 150, 200 100, 218 100" />
      </g>

      {/* Right approved record card — solid, accented */}
      <g>
        <rect
          x="218"
          y="78"
          width="118"
          height="44"
          rx="8"
          className="text-accent"
          fill="var(--ak-accent-wash, color-mix(in srgb, var(--accent) 9%, transparent))"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <text
          x="277"
          y="105"
          className="text-ink font-display"
          fontSize="14"
          fontWeight="700"
          textAnchor="middle"
        >
          ESPN
        </text>
      </g>

      {/* Tiny accent dots on connection joins */}
      <g className="text-accent" fill="currentColor">
        <circle cx="142" cy="50" r="2" />
        <circle cx="142" cy="100" r="2" />
        <circle cx="142" cy="150" r="2" />
        <circle cx="218" cy="100" r="2.5" />
      </g>
    </svg>
  </div>
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

function DashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] animate-pulse space-y-6 p-3 md:space-y-8 md:p-8">
      <div className="space-y-2">
        <div className="h-2.5 w-16 rounded-sm bg-surface-3" />
        <div className="h-7 w-36 rounded-sm bg-surface-3" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-sm border border-line bg-surface p-4">
            <div className="h-2.5 w-16 rounded-sm bg-surface-3" />
            <div className="h-7 w-12 rounded-sm bg-surface-3" />
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-sm border border-line">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-0"
          >
            <div className="h-2 w-2 shrink-0 rounded-pill bg-surface-3" />
            <div className="h-3 w-28 rounded-sm bg-surface-3" />
            <div className="h-2 w-16 rounded-sm bg-surface-3" />
            <div className="ml-auto h-3 w-10 rounded-sm bg-surface-3" />
            <div className="h-3 w-10 rounded-sm bg-surface-3" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  const tenant = useTenant();
  usePageTitle(tenant.label);
  const dims = useDimensions();
  const auditLog = useAudit();
  const wsInfo = useWorkspaceInfo();
  const loading = useStoreLoading();
  const navigate = useNavigate();
  const nav = useNavLinks();
  const totalNew = dims.reduce((n, s) => n + s.counts.newCount, 0);

  // Live KPI derivations — replace the static fixtures.
  // Values mapped = total raw-value entries already in the map tables.
  // Rows at risk = warehouse source rows behind currently-unmapped values.
  // Coverage = mapped rows / (mapped rows + at-risk rows).
  const valuesMapped = dims.reduce((n, d) => n + d.rows, 0);
  const rowsAtRisk = dims.reduce((n, d) => n + d.counts.unmappedRowsTotal, 0);
  const rowsMapped = dims.reduce((n, d) => n + d.counts.mappedRowsTotal, 0);
  const coverage =
    rowsMapped + rowsAtRisk > 0 ? (rowsMapped / (rowsMapped + rowsAtRisk)) * 100 : 100;
  const tablesWithNew = dims.filter((d) => d.counts.newCount > 0).length;
  const attentionTables = dims.filter((d) => d.counts.newCount > 0 || toPublishCount(d) > 0);
  const cleanTables = dims.filter((d) => d.counts.newCount === 0 && toPublishCount(d) === 0);
  const toPublishTotal = dims.reduce((n, d) => n + toPublishCount(d), 0);
  const toPublishTables = dims.filter((d) => toPublishCount(d) > 0).length;

  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "review", dir: "desc" });

  const toggleSort = (key: SortKey) =>
    setSort(
      (s) =>
        s.key === key
          ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
          : { key, dir: key === "name" ? "asc" : "desc" }, // text A→Z, everything else high→low
    );

  const visibleDims = useMemo(
    () => applySort(applyFilter(dims, filter), sort.key, sort.dir),
    [dims, filter, sort],
  );

  const syncStatus = useMemo(() => warehouseSyncStatusByDim(auditLog, dims), [auditLog, dims]);

  const dimTint = (dim: (typeof dims)[0]) => {
    const palette = dim.color ?? defaultTintFor(dim.id);
    return (PALETTE[palette as PaletteName] ?? PALETTE[defaultTintFor(dim.id)]).fg; // e.g. "var(--tint-rose)"
  };

  const kpis: Array<{
    label: string;
    value: string;
    featured?: boolean;
    coveragePct?: number;
    delta?: string;
    dir?: "up" | "down" | "warn";
    valueColor?: string;
  }> = [
    {
      label: "Tables",
      value: String(dims.length),
      delta: `${attentionTables.length} active · ${cleanTables.length} clean`,
      dir: attentionTables.length > 0 ? "warn" : undefined,
    },
    {
      label: "Coverage",
      value: `${coverage.toFixed(1)}%`,
      featured: true,
      coveragePct: coverage,
      delta: undefined,
      dir: undefined,
    },
    {
      label: "In review",
      value: String(totalNew),
      valueColor: "var(--accent)",
      delta:
        totalNew > 0 ? `across ${tablesWithNew} table${tablesWithNew === 1 ? "" : "s"}` : undefined,
      dir: undefined,
    },
    {
      label: "To publish",
      value: String(toPublishTotal),
      valueColor: "var(--ak-staged)",
      delta:
        toPublishTotal > 0
          ? `across ${toPublishTables} table${toPublishTables === 1 ? "" : "s"}`
          : undefined,
      dir: undefined,
    },
  ];

  const COLS: Array<{ key: SortKey; label: string; align: "left" | "right" }> = [
    { key: "name", label: "Table", align: "left" },
    { key: "records", label: "Records", align: "right" },
    { key: "coverage", label: "Coverage", align: "left" },
    { key: "review", label: "In review", align: "left" },
    { key: "toPublish", label: "To publish", align: "left" },
    { key: "published", label: "Published", align: "right" },
  ];

  if (loading) return <DashboardSkeleton />;

  if (dims.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-8 p-6 md:p-12">
        <EmptyStateIllustration />
        <PageHeader
          backdrop={<MarkBackdrop />}
          kicker="Tables"
          title="Your workspace is empty"
          lede="Create a table for each list you curate — Country, Channel, Partner. Turn scattered source values into approved records, so your dashboards all count the same thing."
          meta={
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link to={nav.tables}>
                <Button icon={<IconPlus className="h-4 w-4" />}>Create your first table</Button>
              </Link>
              <Link to={nav.sources}>
                <Button variant="secondary">Browse the warehouse</Button>
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[var(--wide)] space-y-6 p-3 md:space-y-8 md:p-8">
      <PageHeader
        backdrop={<MarkBackdrop />}
        kicker="Overview"
        title={tenant.label}
        meta={
          <div className="mt-3 flex flex-wrap gap-5">
            <span className="text-sm text-ink-2">
              <span className="font-display text-base font-bold text-ink">{dims.length}</span>{" "}
              tables
            </span>
            <span className="text-sm text-ink-2">
              <span className="font-display text-base font-bold text-ink">
                {fmtK(valuesMapped)}
              </span>{" "}
              records
            </span>
            <span className="text-sm text-ink-2">
              <span
                className="font-display text-base font-bold tabular-nums"
                style={{ color: "var(--accent)" }}
              >
                {totalNew}
              </span>{" "}
              in review
            </span>
            <span className="text-sm text-ink-2">
              <span
                className="font-display text-base font-bold tabular-nums"
                style={{ color: "var(--ak-staged)" }}
              >
                {toPublishTotal}
              </span>{" "}
              to publish
            </span>
          </div>
        }
        action={
          totalNew > 0 ? (
            <Link to={nav.triage}>
              <Button icon={<IconWand className="h-4 w-4" />} className="zz-glow-sm">
                Review {totalNew} new
              </Button>
            </Link>
          ) : undefined
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4 lg:grid-cols-4">
        {kpis.map((m, i) => (
          <div key={m.label} {...rise(1 + i)}>
            <Kpi
              label={m.label}
              value={m.value}
              featured={m.featured}
              coveragePct={m.coveragePct}
              delta={m.delta}
              dir={m.dir}
              valueColor={m.valueColor}
            />
          </div>
        ))}
      </div>

      {/* Table-health section: title + sort on one row (demo parity), the
         health filter facets on their own row below. Grouped in one block so
         the title sits close to its controls; the table keeps the section gap. */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="font-display text-[18px] font-semibold tracking-tight text-ink">
            Table health
          </h2>
          <span className="font-mono text-[10px] text-ink-3">Click a column to sort</span>
        </div>

        {/* health filter facets — primary control */}
        <div className="mt-3 flex flex-wrap items-center gap-2 overflow-x-auto pb-0.5 md:overflow-visible md:pb-0">
          {(
            [
              { key: "all" as FilterKey, label: "All", count: dims.length },
              {
                key: "attention" as FilterKey,
                label: "Needs attention",
                count: attentionTables.length,
              },
              {
                key: "clean" as FilterKey,
                label: "Clean",
                count: cleanTables.length,
              },
            ] as const
          ).map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={cx(
                "flex h-7 items-center gap-1.5 rounded-sm border px-3 font-mono text-[10px] transition-colors",
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
        </div>
      </div>

      {/* Dimension health table — white surface behind the rows so the
         translucent hover tint reads as gray, not the lattice showing through. */}
      <div {...rise(5)} className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr>
              {COLS.map((col, i) => {
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    className={cx(
                      "border-b border-line-2 bg-surface p-0",
                      i === 0 && "sticky left-0 z-10",
                    )}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cx(
                        "flex w-full items-center gap-1.5 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                        col.align === "right" ? "justify-end" : "justify-start",
                        active ? "text-ink" : "text-ink-3 hover:text-ink-2",
                      )}
                    >
                      {col.label}
                      <span
                        className={cx(
                          "text-[9px] transition-opacity",
                          active ? "text-accent opacity-100" : "opacity-0",
                        )}
                        aria-hidden="true"
                      >
                        {sort.dir === "asc" ? "▲" : "▼"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleDims.map((dim) => {
              const pct = coveragePct(dim);
              const newCount = dim.counts.newCount;
              const tint = dimTint(dim);
              const dimId = dim.dimTable.replace(/^[^.]+\./, "");

              return (
                <tr
                  key={dim.id}
                  onClick={() => navigate(nav.table(dim.id, "match"))}
                  className="group cursor-pointer"
                >
                  {/* table name + dim_* id with 3px tint bar. Hover is applied
                     per-cell (group-hover) — not on the <tr> — so the opaque
                     sticky cell and the transparent cells all composite one
                     --hover layer over the white container: a single uniform
                     gray, matching every other table in the app. */}
                  <td className="sticky left-0 z-10 border-b border-line bg-surface py-0 pr-4 group-hover:bg-hover">
                    <div className="flex items-stretch gap-3">
                      <div className="w-[3px] shrink-0 self-stretch" style={{ background: tint }} />
                      <div className="min-w-0 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="font-display text-[13px] font-semibold text-ink">
                            {dim.dimension}
                          </span>
                          {wsInfo?.writable && syncStatus[dim.id] === "failed" && (
                            <span
                              title="Last warehouse scan failed — manual re-scan required"
                              className="inline-flex items-center font-mono text-[9px] text-amber-600"
                            >
                              🔄 needs re-scan
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-ink-3">{dimId}</div>
                      </div>
                    </div>
                  </td>

                  {/* records */}
                  <td className="border-b border-line px-4 py-3 group-hover:bg-hover text-right font-mono text-[11px] tabular-nums text-ink-2">
                    {dim.canonical.length.toLocaleString()}
                  </td>

                  {/* coverage bar + pct — wide, prominent bar (demo parity) */}
                  <td className="w-[220px] border-b border-line px-4 py-3 group-hover:bg-hover">
                    <div className="flex items-center gap-3">
                      <div className="h-[6px] flex-1 overflow-hidden rounded-pill bg-surface-3">
                        <div
                          className="h-full rounded-pill bg-committed"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-[42px] shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-2">
                        {pct}%
                      </span>
                    </div>
                  </td>

                  {/* in review */}
                  <td className="border-b border-line px-4 py-3 group-hover:bg-hover">
                    {newCount > 0 ? (
                      <Badge tone="warn" dot>
                        {newCount}
                      </Badge>
                    ) : (
                      <span className="font-mono text-[11px] text-ink-3">—</span>
                    )}
                  </td>

                  {/* to publish — drafts + edited records; hover for the split */}
                  <td className="border-b border-line px-4 py-3 group-hover:bg-hover">
                    {(() => {
                      const p = dim.publish;
                      const total = toPublishCount(dim);
                      if (total === 0)
                        return <span className="font-mono text-[11px] text-ink-3">—</span>;
                      const drafts = p?.pendingDrafts ?? 0;
                      const edits = p?.changedRecords ?? 0;
                      return (
                        <span
                          title={`${drafts} draft${drafts === 1 ? "" : "s"}, ${edits} record edit${edits === 1 ? "" : "s"}`}
                          className="inline-flex items-center gap-1.5 rounded-sm border border-transparent bg-staged-soft px-2 py-0.5 font-mono text-[11px] font-medium text-staged"
                        >
                          {total} to publish
                        </span>
                      );
                    })()}
                  </td>

                  {/* published — per-table version + when; "Never" when unpublished */}
                  <td className="border-b border-line px-4 py-3 group-hover:bg-hover text-right">
                    {dim.publish && dim.publish.version > 0 && dim.publish.publishedAt ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium text-committed">
                          <span className="h-[5px] w-[5px] rounded-pill bg-committed" />v
                          {dim.publish.version}
                        </span>
                        <span className="font-mono text-[10px] text-ink-3">
                          {formatTimeAgo(dim.publish.publishedAt)}
                        </span>
                      </div>
                    ) : (
                      <span className="font-mono text-[11px] text-ink-3">Never</span>
                    )}
                  </td>
                </tr>
              );
            })}

            {/* empty filter state */}
            {visibleDims.length === 0 && (
              <tr>
                <td colSpan={6} className="border-b border-line px-4 py-12 text-center">
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
                        ? "Review the new values in your active tables to flip them clean."
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

      {/* Scan failure feed — only rendered when scheduler has emitted scan_failed events */}
      <ScanFailureFeed auditLog={auditLog} />
    </div>
  );
}

/** Renders the most recent scan_failed audit entries (up to 5). Hidden when empty. */
function ScanFailureFeed({ auditLog }: { auditLog: import("../store").AuditEntry[] }) {
  const failures = auditLog.filter((e) => e.action === "scan_failed");
  if (failures.length === 0) return null;

  return (
    <div className="zz-rise rounded-sm border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-display text-[13px] font-semibold text-ink">Scan failures</span>
        <span className="font-mono text-[10px] text-warn">{failures.length}</span>
      </div>
      <ul className="divide-y divide-line">
        {failures.slice(0, 5).map((e) => (
          <li key={e.id} className="flex items-start gap-3 px-4 py-2.5">
            <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-pill bg-warn-soft font-mono text-[7px] font-semibold text-warn">
              {e.user.initials}
            </span>
            <div className="min-w-0 flex-1">
              <span className="font-mono text-[11px] text-warn">{e.detail}</span>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-ink-3">{formatTimeAgo(e.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
