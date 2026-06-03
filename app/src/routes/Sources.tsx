import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/Card";
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

/* Sources — the overview pillar. Designed to answer four questions at-a-glance:
   (1) Is my warehouse healthy?  → workspace pulse hero
   (2) What needs my attention?  → insight strip with proactive nudges
   (3) Where is the work?        → schema cards + ranked list
   (4) Why does it matter?       → per-row expand showing real unmapped values
*/

const SCHED_LABEL: Record<string, string> = { "15m": "Auto every 15m", hourly: "Auto hourly", daily: "Auto daily" };
const STALE_DAYS = 7;
const PAGE = 25;

type RealStatus = "needs" | "clean" | "missing";
type Status = RealStatus | "all";
type Sort = "impact" | "unmapped" | "rows" | "name" | "recent";

const statusOf = (s: SourceInfo): RealStatus =>
  s.unmapped > 0 ? "needs" : s.scanned && !s.present ? "missing" : "clean";

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function daysAgo(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function rise(i: number) {
  return { className: "zz-rise" as const, style: { animationDelay: `${i * 70}ms` } };
}

/** Coverage bar — token-driven, accent fill, used in the schema cards and rows. */
function CoverageBar({ pct, height = "h-1" }: { pct: number; height?: string }) {
  return (
    <div className={cx("w-full overflow-hidden rounded-pill bg-surface-2", height)}>
      <div
        className={cx("h-full rounded-pill transition-[width] duration-500", pct >= 95 ? "bg-ok" : pct >= 70 ? "bg-accent" : "bg-warn")}
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

  /* --- aggregates: pulse hero + insights + schema cards rely on these --- */
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
      // impact score: rows-at-risk weighted = unmapped × log(rows)
      const score = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (score > worstScore) { worstScore = score; worst = s; }
    }
    const coverage = valuesSum > 0 ? Math.max(0, Math.min(100, ((valuesSum - unmapped) / valuesSum) * 100)) : 100;
    const systems = new Set(sources.map((s) => s.table.split(".")[0])).size;
    return { columns, scannedCols, scheduled, valuesSum, unmapped, atRisk, neverScanned, stale, worst, coverage, systems };
  }, [sources]);

  /* --- per-schema rollup for the rich schema cards --- */
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

  /* --- filtering + sorting for the main list --- */
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
    <div className="space-y-6">
      {catalog && <CatalogExplorer dims={dims} onClose={() => setCatalog(false)} />}

      {/* --- header --- */}
      <div className="zz-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">Discovery</div>
          <h1 className="mt-1.5 font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-none tracking-[-0.035em] text-ink">Sources</h1>
          <p className="mt-3 max-w-[60ch] text-ink-2">Every warehouse column wired to a master list. Watch what&apos;s healthy, what&apos;s drifting, and what&apos;s never been looked at — all in one place.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<IconArrowRight className="h-4 w-4" />} onClick={() => setCatalog(true)}>Wire a source</Button>
          <Button icon={<IconWand className="h-4 w-4" />} onClick={scan} className="zz-glow-sm" disabled={scanning}>
            {scanning ? "Scanning…" : flash !== null ? `✓ scanned ${flash}` : "Scan all sources"}
          </Button>
        </div>
      </div>

      {derived && <div className="rounded-lg border border-line bg-accent-wash px-4 py-2.5 font-mono text-[12px] text-accent">{derived}</div>}

      {/* --- WORKSPACE PULSE HERO --- */}
      <div {...rise(1)}>
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-1 gap-0 md:grid-cols-[1.2fr_1fr]">
            <div className="border-b border-line p-6 md:border-b-0 md:border-r">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Workspace coverage</div>
              <div className="mt-1.5 flex items-baseline gap-3">
                <span className={cx("font-display font-extrabold leading-none tracking-[-0.04em] text-[clamp(56px,8vw,84px)]", agg.coverage >= 95 ? "text-ok" : agg.coverage >= 70 ? "text-ink" : "text-warn")}>
                  {agg.coverage.toFixed(1)}<span className="text-[0.45em] text-ink-3">%</span>
                </span>
                <span className="font-mono text-[12px] text-ink-3">across {agg.valuesSum.toLocaleString()} value{agg.valuesSum === 1 ? "" : "s"} in {agg.scannedCols} scanned source{agg.scannedCols === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-4"><CoverageBar pct={agg.coverage} height="h-2" /></div>
            </div>
            <div className="grid grid-cols-2 gap-0">
              <PulseCell label="Sources wired" value={agg.columns.toLocaleString()} sub={`${agg.systems} system${agg.systems === 1 ? "" : "s"}`} />
              <PulseCell label="Unmapped values" value={agg.unmapped.toLocaleString()} sub={agg.unmapped > 0 ? "across the warehouse" : "everything resolved"} tone={agg.unmapped > 0 ? "warn" : "ok"} />
              <PulseCell label="Rows at risk" value={agg.atRisk.toLocaleString()} sub="missing downstream" tone={agg.atRisk > 0 ? "warn" : "ok"} />
              <PulseCell label="On schedule" value={agg.scheduled.toLocaleString()} sub={`of ${agg.columns} sources`} tone={agg.scheduled === agg.columns ? "ok" : "neutral"} />
            </div>
          </div>
        </Card>
      </div>

      {/* --- INSIGHT STRIP --- */}
      {(agg.neverScanned > 0 || agg.stale > 0 || (agg.worst && agg.worst.unmapped > 0)) && (
        <div {...rise(2)} className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {agg.neverScanned > 0 && (
            <InsightCard
              tone="warn"
              eyebrow="Never scanned"
              title={`${agg.neverScanned} source${agg.neverScanned === 1 ? "" : "s"} haven’t been scanned yet`}
              detail="Run a scan to find out what they contain."
              cta={{ label: "Scan all", onClick: scan, disabled: scanning }}
            />
          )}
          {agg.stale > 0 && (
            <InsightCard
              tone="neutral"
              eyebrow={`Stale > ${STALE_DAYS}d`}
              title={`${agg.stale} source${agg.stale === 1 ? "" : "s"} haven’t been scanned in over a week`}
              detail="Schedule a regular scan so drift gets caught automatically."
              cta={{ label: "Scan all", onClick: scan, disabled: scanning }}
            />
          )}
          {agg.worst && agg.worst.unmapped > 0 && (
            <InsightCard
              tone="accent"
              eyebrow="Highest impact"
              title={`${agg.worst.table}.${agg.worst.column}`}
              detail={`${agg.worst.unmapped.toLocaleString()} unmapped value${agg.worst.unmapped === 1 ? "" : "s"} affecting ${agg.worst.rows.toLocaleString()} row${agg.worst.rows === 1 ? "" : "s"} downstream.`}
              cta={{ label: "Open in Match values", to: "/app/mapping" }}
            />
          )}
        </div>
      )}

      {/* --- SCHEMA CARDS + LIST --- */}
      <div {...rise(3)} className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        {/* schema rail */}
        <Card className="h-max p-0">
          <div className="border-b border-line px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">Systems</div>
          <button type="button" onClick={() => { setSchema(null); setShown(PAGE); }}
            className={cx("flex w-full items-center justify-between border-b border-line px-4 py-3 text-left transition-colors", schema === null ? "bg-accent-wash" : "hover:bg-hover")}>
            <div>
              <div className={cx("font-display text-[13px] font-semibold", schema === null ? "text-accent" : "text-ink")}>All systems</div>
              <div className="mt-0.5 font-mono text-[10px] text-ink-3">{sources.length} source{sources.length === 1 ? "" : "s"} · {agg.systems} system{agg.systems === 1 ? "" : "s"}</div>
            </div>
            <div className="text-right">
              <div className="font-mono text-[11px] text-ink-2 tabular-nums">{agg.coverage.toFixed(0)}%</div>
              <div className="mt-0.5 w-16"><CoverageBar pct={agg.coverage} /></div>
            </div>
          </button>
          <div className="max-h-[520px] overflow-y-auto">
            {facets.map((f) => (
              <button key={f.schema} type="button" onClick={() => { setSchema(f.schema === schema ? null : f.schema); setShown(PAGE); }}
                className={cx("flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left transition-colors", f.schema === schema ? "bg-accent-wash" : "hover:bg-hover")}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <SchemaInitial label={f.schema} active={f.schema === schema} />
                    <span className={cx("truncate font-display text-[13px] font-semibold", f.schema === schema ? "text-accent" : "text-ink")}>{f.schema}</span>
                    {f.unmapped > 0 && <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[10px] text-warn">{f.unmapped}</span>}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-ink-3">{f.columns} column{f.columns === 1 ? "" : "s"}{f.lastScanned ? ` · ${ago(f.lastScanned)}` : ""}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[11px] text-ink-2 tabular-nums">{f.coverage.toFixed(0)}%</div>
                  <div className="mt-0.5 w-12"><CoverageBar pct={f.coverage} /></div>
                </div>
              </button>
            ))}
            {facets.length === 0 && (
              <div className="px-4 py-6 font-mono text-[11px] text-ink-3">No sources wired yet — use &ldquo;Wire a source&rdquo;.</div>
            )}
          </div>
        </Card>

        {/* main list */}
        <Card className="p-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-sm border border-line-2 bg-bg px-3 py-1.5 text-ink-3 focus-within:border-accent">
              <IconSearch className="h-4 w-4" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search columns, tables, master lists…"
                className="w-full bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3" />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {CHIPS.map((c) => (
                <button key={c.k} type="button" onClick={() => { setStatus(c.k); setShown(PAGE); }}
                  className={cx("rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors", status === c.k ? "bg-accent-wash text-accent" : "text-ink-3 hover:bg-hover hover:text-ink-2")}>
                  {c.label} <span className="opacity-60">{c.n}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 border-l border-line pl-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
                className="rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none">
                {SORTS.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {/* column header */}
          <div className="grid grid-cols-[24px_minmax(200px,1.6fr)_minmax(120px,0.9fr)_auto_auto_auto] items-center gap-3 border-b border-line px-5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3">
            <span />
            <span>Column</span>
            <span>Coverage</span>
            <span className="text-right">Rows</span>
            <span className="text-right">Values</span>
            <span className="text-right">Unmapped</span>
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
            <div className="flex items-center justify-between px-5 py-3">
              <span className="font-mono text-[11px] text-ink-3">{visible.length} of {filtered.length}</span>
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>Load more</Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ===================================================================== */
/*                         Sub-components                                  */
/* ===================================================================== */

function PulseCell({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: "neutral" | "ok" | "warn" }) {
  const valueCls = tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="border-b border-l border-line p-4 first:border-l-0 md:border-b-0">
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx("mt-1 font-display text-[22px] font-bold leading-none tracking-tight tabular-nums", valueCls)}>{value}</div>
      {sub && <div className="mt-1 font-mono text-[10.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

function InsightCard({ tone, eyebrow, title, detail, cta }: {
  tone: "warn" | "neutral" | "accent";
  eyebrow: string;
  title: string;
  detail: string;
  cta: { label: string; onClick?: () => void; to?: string; disabled?: boolean };
}) {
  const eyebrowCls = tone === "warn" ? "text-warn" : tone === "accent" ? "text-accent" : "text-ink-3";
  const borderCls = tone === "warn" ? "border-warn-soft" : tone === "accent" ? "border-accent-soft" : "border-line";
  return (
    <Card className={cx("flex h-full flex-col gap-2 p-4", borderCls)}>
      <div className={cx("font-mono text-[10px] font-medium uppercase tracking-[0.18em]", eyebrowCls)}>{eyebrow}</div>
      <div className="font-display text-[15px] font-semibold leading-tight text-ink">{title}</div>
      <div className="text-[12.5px] text-ink-2">{detail}</div>
      <div className="mt-auto pt-2">
        {cta.to ? (
          <Link to={cta.to}><Button size="sm" variant="secondary" icon={<IconArrowRight className="h-3.5 w-3.5" />}>{cta.label}</Button></Link>
        ) : (
          <Button size="sm" variant="secondary" onClick={cta.onClick} disabled={cta.disabled}>{cta.label}</Button>
        )}
      </div>
    </Card>
  );
}

function SchemaInitial({ label, active }: { label: string; active: boolean }) {
  return (
    <div className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-sm font-display text-[11px] font-bold", active ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent")}>
      {label.charAt(0).toUpperCase()}
    </div>
  );
}

function SourceRow({
  row, expanded, onToggle, onScheduleChange, onDerive,
}: {
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
      <div className="grid grid-cols-[24px_minmax(200px,1.6fr)_minmax(120px,0.9fr)_auto_auto_auto] items-center gap-3 px-5 py-3 hover:bg-hover">
        <button type="button" onClick={onToggle} aria-label={expanded ? "Collapse" : "Expand"}
          className="grid h-6 w-6 place-items-center rounded-sm text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink">
          <IconChevron className={cx("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">
              <span className="text-ink-3">{row.table.split(".")[0]}.</span>{lastSeg}<span className="text-ink-3">.{row.column}</span>
            </span>
            {!row.present && row.scanned && <Badge>not found</Badge>}
            {!row.scanned && !row.scannedAt && <Badge tone="warn">unscanned</Badge>}
            {stale && row.scannedAt && <Badge>stale</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-ink-3">
            <Link to="/app/tables" className="hover:text-accent">→ {row.dimension}</Link>
            {row.schedule && <span className="text-accent">· {SCHED_LABEL[row.schedule] ?? row.schedule}</span>}
            {row.scannedAt && <span>· scanned {ago(row.scannedAt)}</span>}
          </div>
        </div>
        <div className="flex min-w-[120px] items-center gap-2">
          <CoverageBar pct={coverage} />
          <span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">{Math.round(coverage)}%</span>
        </div>
        <span className="text-right font-mono text-[12px] text-ink-2 tabular-nums">{row.rows.toLocaleString()}</span>
        <span className="text-right font-mono text-[12px] text-ink-3 tabular-nums">{row.values.toLocaleString()}</span>
        <span className="flex items-center justify-end gap-2">
          <ScanScheduleMenu value={row.schedule ?? null} onChange={onScheduleChange} />
          <button type="button"
            aria-label={`Import master records from ${row.table}.${row.column}`}
            title="Import master records from this column's distinct values"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDerive(); }}
            className="grid h-6 w-6 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-accent hover:text-accent">
            <IconWand className="h-3 w-3" />
          </button>
          {row.unmapped > 0 ? <Badge tone="warn">{row.unmapped}</Badge> : <Badge tone="ok">0</Badge>}
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
    <div className="border-t border-line bg-bg/40 px-5 py-4 pl-[52px]">
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
        Top unmapped values{row.unmapped > 0 ? ` · top ${Math.min(8, row.unmapped)} of ${row.unmapped.toLocaleString()}` : ""}
      </div>
      {sample === "loading" ? (
        <div className="mt-2 font-mono text-[11px] text-ink-3">loading…</div>
      ) : sample === "error" ? (
        <div className="mt-2 font-mono text-[11px] text-danger">couldn&apos;t load — is the warehouse attached?</div>
      ) : sample.length === 0 ? (
        row.unmapped > 0 ? (
          <div className="mt-2 font-mono text-[11px] text-ink-3">Run a scan first — the unmapped count comes from the cache, the sample needs a live read.</div>
        ) : (
          <div className="mt-2 font-mono text-[11px] text-ok">🎉 No unmapped values here.</div>
        )
      ) : (
        <div className="mt-2 grid gap-1">
          {sample.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-3 font-mono text-[11.5px]">
              <span className="truncate text-ink">{s.raw}</span>
              <span className="shrink-0 text-ink-3 tabular-nums">{s.rows.toLocaleString()} rows</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link to="/app/mapping">
          <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>Resolve in Match values</Button>
        </Link>
        <span className="font-mono text-[10.5px] text-ink-3">→ {row.dimension}</span>
      </div>
    </div>
  );
}

function EmptyState({ wired, filteredByStatus, status }: { wired: number; filteredByStatus: boolean; status: Status }) {
  if (wired === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <div className="font-display text-[18px] font-semibold text-ink">No sources wired yet</div>
        <p className="mx-auto mt-1 max-w-[44ch] text-[13px] text-ink-2">A source is a warehouse column Zug Zug watches for new values. Wire your first column to start tracking.</p>
      </div>
    );
  }
  if (filteredByStatus && status === "clean") {
    return (
      <div className="px-5 py-12 text-center">
        <div className="font-display text-[18px] font-semibold text-ok">🎉 Everything in this view is clean</div>
        <p className="mx-auto mt-1 max-w-[44ch] text-[13px] text-ink-2">Every value here resolves to a master record. Nice.</p>
      </div>
    );
  }
  if (filteredByStatus && status === "needs") {
    return (
      <div className="px-5 py-12 text-center">
        <div className="font-display text-[18px] font-semibold text-ok">🎉 Nothing needs your attention</div>
        <p className="mx-auto mt-1 max-w-[44ch] text-[13px] text-ink-2">All scanned sources are fully resolved.</p>
      </div>
    );
  }
  return (
    <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">nothing matches this filter</div>
  );
}
