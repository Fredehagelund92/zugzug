import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { CatalogExplorer } from "../components/CatalogExplorer";
import { ScanScheduleMenu } from "../components/ScanScheduleMenu";
import { IconSearch, IconWand, IconArrowRight, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import {
  useDimensions, useSources, scanSources, deriveCanonical, setSourceSchedule,
  fetchUnmappedSample, type SourceInfo, type UnmappedSample,
} from "../store";

/* Sources — designed for a 13" Mac main column (~900px) as the constraint,
   not the desire. Single-column flow:
     1. Header
     2. Pulse strip (horizontal) — workspace coverage at a glance
     3. Insight strip — proactive nudges in one row
     4. Schema strip — horizontal scroll of system cards (filters the list)
     5. Filter bar — search · status · sort
     6. Dense list with per-row coverage bar and expandable drill
*/

const SCHED_LABEL: Record<string, string> = { "15m": "Auto every 15m", hourly: "Auto hourly", daily: "Auto daily" };
const STALE_DAYS = 7;
const PAGE = 30;

type RealStatus = "needs" | "clean" | "missing";
type Status = RealStatus | "all";
type Sort = "impact" | "unmapped" | "rows" | "name" | "recent";

const statusOf = (s: SourceInfo): RealStatus =>
  s.unmapped > 0 ? "needs" : s.scanned && !s.present ? "missing" : "clean";

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function daysAgo(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function CovBar({ pct, h = "h-[3px]" }: { pct: number; h?: string }) {
  const tone = pct >= 95 ? "bg-ok" : pct >= 70 ? "bg-accent" : "bg-warn";
  return (
    <div className={cx("relative w-full overflow-hidden rounded-pill bg-line/40", h)}>
      <div
        className={cx("h-full rounded-pill transition-[width] duration-500", tone)}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

export function Sources() {
  const sources = useSources();
  const dims = useDimensions();
  const [q, setQ] = useState("");
  const [schema, setSchema] = useState<string | null>(null);
  const totalUnmapped = sources.reduce((n, s) => n + s.unmapped, 0);
  const [status, setStatus] = useState<Status>(totalUnmapped > 0 ? "needs" : "all");
  const [sort, setSort] = useState<Sort>("impact");
  const [shown, setShown] = useState(PAGE);
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [derived, setDerived] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  /* --- aggregates --- */
  const agg = useMemo(() => {
    let columns = 0, scannedCols = 0, scheduled = 0, valuesSum = 0, unmapped = 0, atRisk = 0, neverScanned = 0, stale = 0;
    let worst: SourceInfo | null = null;
    let worstScore = 0;
    for (const s of sources) {
      columns++;
      if (s.scanned || s.scannedAt) scannedCols++;
      if (s.schedule) scheduled++;
      valuesSum += s.values;
      unmapped += s.unmapped;
      if (s.unmapped > 0) atRisk += s.rows;
      if (!s.scanned && !s.scannedAt) neverScanned++;
      else if (daysAgo(s.scannedAt) > STALE_DAYS) stale++;
      const score = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (score > worstScore) { worstScore = score; worst = s; }
    }
    const coverage = valuesSum > 0 ? Math.max(0, Math.min(100, ((valuesSum - unmapped) / valuesSum) * 100)) : 100;
    const systems = new Set(sources.map((s) => s.table.split(".")[0])).size;
    return { columns, scannedCols, scheduled, valuesSum, unmapped, atRisk, neverScanned, stale, worst, coverage, systems };
  }, [sources]);

  /* --- per-schema rollup --- */
  const facets = useMemo(() => {
    const m = new Map<string, { schema: string; columns: number; unmapped: number; values: number; missing: number; rows: number; lastScanned: string | null }>();
    for (const s of sources) {
      const k = s.table.split(".")[0];
      const e = m.get(k) ?? { schema: k, columns: 0, unmapped: 0, values: 0, missing: 0, rows: 0, lastScanned: null };
      e.columns += 1;
      e.unmapped += s.unmapped;
      e.values += s.values;
      e.rows += s.rows;
      if (s.scanned && !s.present) e.missing += 1;
      if (s.scannedAt && (!e.lastScanned || new Date(s.scannedAt) > new Date(e.lastScanned))) e.lastScanned = s.scannedAt;
      m.set(k, e);
    }
    return [...m.values()]
      .map((f) => ({ ...f, coverage: f.values > 0 ? ((f.values - f.unmapped) / f.values) * 100 : 100 }))
      .sort((a, b) => b.unmapped - a.unmapped || a.schema.localeCompare(b.schema));
  }, [sources]);

  const counts = useMemo(() => {
    const c: Record<RealStatus, number> = { needs: 0, clean: 0, missing: 0 };
    for (const s of sources) c[statusOf(s)]++;
    return c;
  }, [sources]);

  /* --- filter + sort --- */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = sources.filter((s) =>
      (!schema || s.table.split(".")[0] === schema) &&
      (status === "all" || statusOf(s) === status) &&
      (!needle || `${s.table}.${s.column} ${s.dimension}`.toLowerCase().includes(needle)),
    );
    const cmp = (a: SourceInfo, b: SourceInfo): number => {
      if (sort === "impact") {
        const sa = a.unmapped > 0 ? a.unmapped * Math.log10(Math.max(10, a.rows)) : -1;
        const sb = b.unmapped > 0 ? b.unmapped * Math.log10(Math.max(10, b.rows)) : -1;
        return sb - sa;
      }
      if (sort === "unmapped") return b.unmapped - a.unmapped;
      if (sort === "rows") return b.rows - a.rows;
      if (sort === "recent") return (b.scannedAt ? new Date(b.scannedAt).getTime() : 0) - (a.scannedAt ? new Date(a.scannedAt).getTime() : 0);
      return a.table.localeCompare(b.table) || a.column.localeCompare(b.column);
    };
    return [...list].sort(cmp);
  }, [sources, schema, status, q, sort]);

  const visible = filtered.slice(0, shown);

  const scan = async () => { setScanning(true); const n = await scanSources(); setScanning(false); setFlash(n); setTimeout(() => setFlash(null), 2600); };
  const derive = async (s: SourceInfo) => {
    const n = await deriveCanonical(s.dimId, s.table, s.column);
    setDerived(n > 0 ? `Imported ${n} master record${n === 1 ? "" : "s"} into ${s.dimension} from ${s.table}.${s.column}` : `${s.table}.${s.column} has no rows to import`);
    setTimeout(() => setDerived(null), 3200);
  };

  const CHIPS: { k: Status; label: string; n: number }[] = [
    { k: "needs", label: "Needs review", n: counts.needs },
    { k: "all", label: "All", n: sources.length },
    { k: "clean", label: "Clean", n: counts.clean },
    { k: "missing", label: "Not found", n: counts.missing },
  ];

  const SORTS: { k: Sort; label: string }[] = [
    { k: "impact", label: "Impact" },
    { k: "unmapped", label: "Unmapped" },
    { k: "rows", label: "Rows" },
    { k: "recent", label: "Recently scanned" },
    { k: "name", label: "Name" },
  ];

  return (
    <div className="space-y-5">
      {catalog && <CatalogExplorer dims={dims} onClose={() => setCatalog(false)} />}

      {/* ─────────── HEADER ─────────── */}
      <div className="zz-rise flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
            <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
            Discovery · live
          </div>
          <h1 className="mt-1 font-display text-[26px] font-extrabold leading-none tracking-[-0.025em] text-ink">
            Sources
          </h1>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />} onClick={() => setCatalog(true)}>Wire a source</Button>
          <Button size="sm" icon={<IconWand className="h-3.5 w-3.5" />} onClick={scan} className="zz-glow-sm" disabled={scanning}>
            {scanning ? "Scanning…" : flash !== null ? `✓ scanned ${flash}` : "Scan all"}
          </Button>
        </div>
      </div>

      {derived && <div className="rounded-md border border-line bg-accent-wash px-3 py-2 font-mono text-[11.5px] text-accent">{derived}</div>}

      {/* ─────────── PULSE STRIP ─────────── */}
      <div className="zz-rise" style={{ animationDelay: "60ms" }}>
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="grid grid-cols-[auto_1fr] items-stretch">
            {/* big-number anchor */}
            <div className="border-r border-line px-5 py-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Coverage</div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className={cx(
                  "font-display text-[44px] font-extrabold leading-none tracking-[-0.04em] tabular-nums",
                  agg.coverage >= 95 ? "text-ok" : agg.coverage >= 70 ? "text-ink" : "text-warn",
                )}>
                  {agg.coverage.toFixed(1)}
                </span>
                <span className="font-display text-[18px] font-bold text-ink-3">%</span>
              </div>
              <div className="mt-2 w-[140px]"><CovBar pct={agg.coverage} h="h-1.5" /></div>
            </div>

            {/* metric cells */}
            <div className="grid grid-cols-4 divide-x divide-line">
              <PulseCell label="Sources" value={agg.columns} sub={`${agg.systems} system${agg.systems === 1 ? "" : "s"}`} />
              <PulseCell label="Values" value={agg.valuesSum.toLocaleString()} sub={`${agg.scannedCols}/${agg.columns} scanned`} />
              <PulseCell label="Unmapped" value={agg.unmapped.toLocaleString()} sub={agg.unmapped > 0 ? "to review" : "all clear"} tone={agg.unmapped > 0 ? "warn" : "ok"} />
              <PulseCell label="Rows at risk" value={agg.atRisk.toLocaleString()} sub="downstream" tone={agg.atRisk > 0 ? "warn" : "ok"} />
            </div>
          </div>
        </div>
      </div>

      {/* ─────────── INSIGHT STRIP ─────────── */}
      {(agg.neverScanned > 0 || agg.stale > 0 || (agg.worst && agg.worst.unmapped > 0)) && (
        <div className="zz-rise grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" style={{ animationDelay: "120ms" }}>
          {agg.neverScanned > 0 && (
            <InsightCard
              tone="warn"
              eyebrow="Never scanned"
              headline={agg.neverScanned}
              subhead={`source${agg.neverScanned === 1 ? "" : "s"} waiting for a first look`}
              cta={{ label: "Scan all", onClick: scan, disabled: scanning }}
            />
          )}
          {agg.stale > 0 && (
            <InsightCard
              tone="neutral"
              eyebrow={`Stale > ${STALE_DAYS}d`}
              headline={agg.stale}
              subhead={`source${agg.stale === 1 ? "" : "s"} haven’t been scanned in a week`}
              cta={{ label: "Scan all", onClick: scan, disabled: scanning }}
            />
          )}
          {agg.worst && agg.worst.unmapped > 0 && (
            <InsightCard
              tone="accent"
              eyebrow="Highest impact"
              headline={`${agg.worst.unmapped.toLocaleString()} unmapped`}
              subhead={`in ${agg.worst.table}.${agg.worst.column} — ${agg.worst.rows.toLocaleString()} rows affected`}
              cta={{ label: "Open", to: "/app/mapping" }}
            />
          )}
        </div>
      )}

      {/* ─────────── SCHEMA STRIP ─────────── */}
      {facets.length > 0 && (
        <div className="zz-rise" style={{ animationDelay: "180ms" }}>
          <div className="mb-2 flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Systems</div>
            {schema && (
              <button type="button" onClick={() => { setSchema(null); setShown(PAGE); }}
                className="font-mono text-[10.5px] text-ink-3 hover:text-accent">clear filter ↺</button>
            )}
          </div>
          <div className="-mx-1 flex gap-2 overflow-x-auto pb-1 pl-1 pr-1">
            <SchemaCard
              label="All"
              columns={sources.length}
              unmapped={agg.unmapped}
              coverage={agg.coverage}
              active={schema === null}
              onClick={() => { setSchema(null); setShown(PAGE); }}
              compact
            />
            {facets.map((f) => (
              <SchemaCard
                key={f.schema}
                label={f.schema}
                columns={f.columns}
                unmapped={f.unmapped}
                coverage={f.coverage}
                lastScanned={f.lastScanned}
                active={schema === f.schema}
                onClick={() => { setSchema(f.schema === schema ? null : f.schema); setShown(PAGE); }}
              />
            ))}
          </div>
        </div>
      )}

      {/* ─────────── FILTER BAR + LIST ─────────── */}
      <div className="zz-rise overflow-hidden rounded-lg border border-line bg-surface" style={{ animationDelay: "240ms" }}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <label className="flex min-w-[200px] flex-1 items-center gap-2 rounded-sm border border-line-2 bg-bg px-2.5 py-1 text-ink-3 focus-within:border-accent">
            <IconSearch className="h-3.5 w-3.5" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
              placeholder="Search columns, tables, lists…"
              className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3" />
          </label>
          <div className="flex items-center gap-1">
            {CHIPS.map((c) => (
              <button key={c.k} type="button" onClick={() => { setStatus(c.k); setShown(PAGE); }}
                className={cx(
                  "rounded-sm px-2 py-1 font-mono text-[10.5px] transition-colors",
                  status === c.k ? "bg-accent-wash text-accent" : "text-ink-3 hover:bg-hover hover:text-ink-2",
                )}>
                {c.label} <span className="opacity-60">{c.n}</span>
              </button>
            ))}
          </div>
          <div className="ml-1 flex items-center gap-1.5 border-l border-line pl-2">
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-3">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink outline-none">
              {SORTS.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
            </select>
          </div>
        </div>

        {/* column header */}
        <div className="grid grid-cols-[20px_minmax(0,1.8fr)_110px_72px_72px_64px_auto] items-center gap-3 border-b border-line bg-surface-2/40 px-4 py-1.5 font-mono text-[9.5px] uppercase tracking-wider text-ink-3">
          <span />
          <span>Column</span>
          <span>Coverage</span>
          <span className="text-right">Rows</span>
          <span className="text-right">Values</span>
          <span className="text-right">Unmapped</span>
          <span />
        </div>

        {visible.map((r) => (
          <SourceRow
            key={`${r.dimId}::${r.table}::${r.column}`}
            row={r}
            expanded={expanded === `${r.dimId}::${r.table}::${r.column}`}
            onToggle={() => setExpanded((e) => e === `${r.dimId}::${r.table}::${r.column}` ? null : `${r.dimId}::${r.table}::${r.column}`)}
            onScheduleChange={(next) => { void setSourceSchedule(r.dimId, r.table, r.column, next); }}
            onDerive={() => derive(r)}
          />
        ))}

        {filtered.length === 0 && (
          <EmptyState
            wired={sources.length}
            filteredByStatus={status !== "all" || !!schema || !!q.trim()}
            status={status}
          />
        )}

        {filtered.length > shown && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2">
            <span className="font-mono text-[10.5px] text-ink-3">{visible.length} of {filtered.length}</span>
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>Load {Math.min(PAGE, filtered.length - shown)} more</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================================================================== */
/*                          Sub-components                                */
/* ===================================================================== */

function PulseCell({ label, value, sub, tone = "neutral" }: { label: string; value: string | number; sub?: string; tone?: "neutral" | "ok" | "warn" }) {
  const valueCls = tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="px-4 py-4">
      <div className="font-mono text-[9.5px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx("mt-0.5 font-display text-[20px] font-bold leading-none tracking-tight tabular-nums", valueCls)}>{value}</div>
      {sub && <div className="mt-1 font-mono text-[10px] text-ink-3">{sub}</div>}
    </div>
  );
}

function InsightCard({ tone, eyebrow, headline, subhead, cta }: {
  tone: "warn" | "neutral" | "accent";
  eyebrow: string;
  headline: string | number;
  subhead: string;
  cta: { label: string; onClick?: () => void; to?: string; disabled?: boolean };
}) {
  const eyebrowCls = tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "text-ink-3";
  const headlineCls = tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={cx("font-mono text-[9.5px] font-medium uppercase tracking-[0.18em]", eyebrowCls)}>{eyebrow}</div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className={cx("font-display text-[16px] font-bold leading-none tabular-nums", headlineCls)}>{headline}</span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3" title={subhead}>{subhead}</div>
      </div>
      <div className="shrink-0">
        {cta.to ? (
          <Link to={cta.to}><Button size="sm" variant="ghost">{cta.label} →</Button></Link>
        ) : (
          <Button size="sm" variant="ghost" onClick={cta.onClick} disabled={cta.disabled}>{cta.label}</Button>
        )}
      </div>
    </div>
  );
}

function SchemaCard({ label, columns, unmapped, coverage, lastScanned, active, onClick, compact }: {
  label: string;
  columns: number;
  unmapped: number;
  coverage: number;
  lastScanned?: string | null;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group flex shrink-0 flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors",
        compact ? "min-w-[120px]" : "min-w-[160px]",
        active ? "border-accent bg-accent-wash" : "border-line bg-surface hover:border-line-2",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cx("truncate font-display text-[12.5px] font-semibold", active ? "text-accent" : "text-ink")}>{label}</span>
        {unmapped > 0 && <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[9.5px] text-warn">{unmapped}</span>}
      </div>
      <div className="flex items-center gap-2">
        <CovBar pct={coverage} h="h-[2px]" />
        <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">{Math.round(coverage)}%</span>
      </div>
      <div className="flex items-center justify-between font-mono text-[9.5px] text-ink-3">
        <span>{columns} col{columns === 1 ? "" : "s"}</span>
        {lastScanned && <span>{ago(lastScanned)} ago</span>}
      </div>
    </button>
  );
}

function SourceRow({ row, expanded, onToggle, onScheduleChange, onDerive }: {
  row: SourceInfo;
  expanded: boolean;
  onToggle: () => void;
  onScheduleChange: (next: string | null) => void;
  onDerive: () => void;
}) {
  const tableName = row.table.split(".").slice(1).join(".") || row.table;
  const lastSeg = tableName.split(".").slice(-1)[0];
  const coverage = row.values > 0 ? ((row.values - row.unmapped) / row.values) * 100 : (row.scanned ? 100 : 0);
  const stale = daysAgo(row.scannedAt) > STALE_DAYS;

  return (
    <div className={cx("border-b border-line transition-colors", expanded && "bg-surface-2/30")}>
      <div className="grid grid-cols-[20px_minmax(0,1.8fr)_110px_72px_72px_64px_auto] items-center gap-3 px-4 py-2 hover:bg-hover">
        <button type="button" onClick={onToggle} aria-label={expanded ? "Collapse" : "Expand"}
          className="grid h-5 w-5 place-items-center rounded-sm text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink">
          <IconChevron className={cx("h-3 w-3 transition-transform", expanded && "rotate-180")} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[12px] text-ink">
              <span className="text-ink-3">{row.table.split(".")[0]}.</span>{lastSeg}<span className="text-ink-3">.{row.column}</span>
            </span>
            {!row.present && row.scanned && <Badge>not found</Badge>}
            {!row.scanned && !row.scannedAt && <Badge tone="warn">unscanned</Badge>}
            {stale && row.scannedAt && <Badge>stale</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-[10px] text-ink-3">
            <Link to="/app/tables" className="hover:text-accent">→ {row.dimension}</Link>
            {row.schedule && <span className="text-accent">· {SCHED_LABEL[row.schedule] ?? row.schedule}</span>}
            {row.scannedAt && <span>· {ago(row.scannedAt)} ago</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <CovBar pct={coverage} />
          <span className="shrink-0 font-mono text-[10.5px] text-ink-3 tabular-nums">{Math.round(coverage)}%</span>
        </div>
        <span className="text-right font-mono text-[11.5px] text-ink-2 tabular-nums">{row.rows.toLocaleString()}</span>
        <span className="text-right font-mono text-[11.5px] text-ink-3 tabular-nums">{row.values.toLocaleString()}</span>
        <span className="text-right">
          {row.unmapped > 0 ? <Badge tone="warn">{row.unmapped}</Badge> : <Badge tone="ok">0</Badge>}
        </span>
        <span className="flex items-center justify-end gap-1.5">
          <ScanScheduleMenu value={row.schedule ?? null} onChange={onScheduleChange} />
          <button type="button"
            aria-label={`Import master records from ${row.table}.${row.column}`}
            title="Import master records from this column"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDerive(); }}
            className="grid h-6 w-6 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-accent hover:text-accent">
            <IconWand className="h-3 w-3" />
          </button>
        </span>
      </div>
      {expanded && <ExpandedDrill row={row} />}
    </div>
  );
}

function ExpandedDrill({ row }: { row: SourceInfo }) {
  const [sample, setSample] = useState<UnmappedSample[] | "loading" | "error">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchUnmappedSample(row.dimId, row.table, row.column, 8);
        if (alive) setSample(s);
      } catch {
        if (alive) setSample("error");
      }
    })();
    return () => { alive = false; };
  }, [row.dimId, row.table, row.column]);

  return (
    <div className="border-t border-line bg-bg/30 px-4 py-3 pl-12">
      <div className="flex items-baseline gap-3">
        <div className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">
          Top unmapped values
        </div>
        {row.unmapped > 0 && (
          <div className="font-mono text-[10px] text-ink-3">
            showing up to 8 of {row.unmapped.toLocaleString()}
          </div>
        )}
      </div>
      {sample === "loading" ? (
        <div className="mt-2 font-mono text-[11px] text-ink-3">loading…</div>
      ) : sample === "error" ? (
        <div className="mt-2 font-mono text-[11px] text-danger">couldn&apos;t load — is the warehouse attached?</div>
      ) : sample.length === 0 ? (
        row.unmapped > 0 ? (
          <div className="mt-2 font-mono text-[11px] text-ink-3">Run a scan first — the unmapped count comes from the cache; the sample needs a live read.</div>
        ) : (
          <div className="mt-2 font-mono text-[11px] text-ok">🎉 No unmapped values here.</div>
        )
      ) : (
        <div className="mt-2 grid gap-1">
          {sample.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-3 font-mono text-[11px]">
              <span className="truncate text-ink">{s.raw}</span>
              <span className="shrink-0 text-ink-3 tabular-nums">{s.rows.toLocaleString()} rows</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-3 font-mono text-[10px] text-ink-3">
        <Link to="/app/mapping" className="text-accent hover:underline">Resolve in Match values →</Link>
        <span>→ {row.dimension}</span>
      </div>
    </div>
  );
}

function EmptyState({ wired, filteredByStatus, status }: { wired: number; filteredByStatus: boolean; status: Status }) {
  if (wired === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <div className="font-display text-[16px] font-semibold text-ink">No sources wired yet</div>
        <p className="mx-auto mt-1 max-w-[44ch] text-[12.5px] text-ink-2">A source is a warehouse column Zug Zug watches for new values. Wire your first to start tracking.</p>
      </div>
    );
  }
  if (filteredByStatus && status === "clean") {
    return (
      <div className="px-5 py-10 text-center">
        <div className="font-display text-[15px] font-semibold text-ok">🎉 Everything here is clean</div>
        <p className="mx-auto mt-1 max-w-[44ch] text-[12px] text-ink-2">Every value in this view resolves to a master record.</p>
      </div>
    );
  }
  if (filteredByStatus && status === "needs") {
    return (
      <div className="px-5 py-10 text-center">
        <div className="font-display text-[15px] font-semibold text-ok">🎉 Nothing needs your attention</div>
        <p className="mx-auto mt-1 max-w-[44ch] text-[12px] text-ink-2">All scanned sources are fully resolved.</p>
      </div>
    );
  }
  return (
    <div className="px-5 py-10 text-center font-mono text-[11.5px] text-ink-3">nothing matches this filter</div>
  );
}
