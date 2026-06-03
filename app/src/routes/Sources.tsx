import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { CatalogExplorer } from "../components/CatalogExplorer";
import { ScanScheduleMenu } from "../components/ScanScheduleMenu";
import { IconSearch, IconWand, IconArrowRight, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import {
  useDimensions, useSources, scanSources, deriveCanonical, setSourceSchedule,
  fetchUnmappedSample, type SourceInfo, type UnmappedSample,
} from "../store";

/* Sources — the Operator's Ledger, built to scale from 9 schemas today to 100+
   tomorrow.

   What this page is FOR:
   1. THE MOMENT  — surface the single most consequential thing right now
      (the Standing callout). One thing, always findable.
   2. WATCHING    — the wired columns we monitor, grouped by system so a user
      with 100 schemas and 1000 columns navigates by collapsing not by
      scrolling.
   3. FINDING     — search is first-class and types over schema/table/column;
      it auto-expands matching groups so the answer comes to the user.
   4. DISCOVERING — a peer entry into the warehouse catalog so wiring a new
      source is a first-class action, not buried in a toolbar.

   Accent appears on exactly two surfaces: the Standing callout (chrome) and
   the unmapped count on a column row (data). Everything else lives in ink. */

const SCHED_LABEL: Record<string, string> = { "15m": "auto 15m", hourly: "auto hourly", daily: "auto daily" };
const STALE_DAYS = 7;
const PAGE = 60;
/* schemas auto-expand when there are this many or fewer wired; beyond that,
   only the schema containing the standing source opens by default. */
const AUTO_EXPAND_MAX_SCHEMAS = 6;

type RealStatus = "needs" | "clean" | "missing";
type Status = RealStatus | "all";
type Sort = "impact" | "name" | "recent";

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

interface SchemaGroup {
  schema: string;
  columns: SourceInfo[];
  totalCols: number;
  unmapped: number;
  values: number;
  rows: number;
  coverage: number;
  lastScanned: string | null;
  worstScore: number; // for ranking
}

export function Sources() {
  const sources = useSources();
  const dims = useDimensions();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("needs");
  const [sort, setSort] = useState<Sort>("impact");
  const [shown, setShown] = useState(PAGE);
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [derived, setDerived] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null); // expanded column drill
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openInit, setOpenInit] = useState(false);

  /* ---- aggregates ---- */
  const agg = useMemo(() => {
    let columns = 0, scannedCols = 0, valuesSum = 0, unmapped = 0, atRisk = 0;
    let worst: SourceInfo | null = null;
    let worstScore = 0;
    let lastScanned: string | null = null;
    for (const s of sources) {
      columns++;
      if (s.scanned || s.scannedAt) scannedCols++;
      valuesSum += s.values;
      unmapped += s.unmapped;
      if (s.unmapped > 0) atRisk += s.rows;
      if (s.scannedAt && (!lastScanned || new Date(s.scannedAt) > new Date(lastScanned))) lastScanned = s.scannedAt;
      const score = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (score > worstScore) { worstScore = score; worst = s; }
    }
    const systems = new Set(sources.map((s) => s.table.split(".")[0])).size;
    const totalRowsWatched = sources.reduce((n, s) => n + s.rows, 0);
    return { columns, scannedCols, valuesSum, unmapped, atRisk, worst, systems, totalRowsWatched, lastScanned };
  }, [sources]);

  /* ---- counts for the status pills ---- */
  const counts = useMemo(() => {
    const c: Record<RealStatus, number> = { needs: 0, clean: 0, missing: 0 };
    for (const s of sources) c[statusOf(s)]++;
    return c;
  }, [sources]);

  /* ---- group + sort + filter ---- */
  const groups = useMemo<SchemaGroup[]>(() => {
    const needle = q.trim().toLowerCase();
    const filtered = sources.filter((s) =>
      (status === "all" || statusOf(s) === status) &&
      (!needle || `${s.table}.${s.column} ${s.dimension}`.toLowerCase().includes(needle)),
    );
    const map = new Map<string, SchemaGroup>();
    for (const s of filtered) {
      const k = s.table.split(".")[0];
      const g = map.get(k) ?? { schema: k, columns: [], totalCols: 0, unmapped: 0, values: 0, rows: 0, coverage: 0, lastScanned: null, worstScore: 0 };
      g.columns.push(s);
      g.totalCols++;
      g.unmapped += s.unmapped;
      g.values += s.values;
      g.rows += s.rows;
      if (s.scannedAt && (!g.lastScanned || new Date(s.scannedAt) > new Date(g.lastScanned))) g.lastScanned = s.scannedAt;
      const sc = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (sc > g.worstScore) g.worstScore = sc;
      map.set(k, g);
    }
    for (const g of map.values()) g.coverage = g.values > 0 ? ((g.values - g.unmapped) / g.values) * 100 : 100;
    const list = [...map.values()];

    const colCmp = (a: SourceInfo, b: SourceInfo): number => {
      if (sort === "impact") {
        const sa = a.unmapped > 0 ? a.unmapped * Math.log10(Math.max(10, a.rows)) : -1;
        const sb = b.unmapped > 0 ? b.unmapped * Math.log10(Math.max(10, b.rows)) : -1;
        return sb - sa;
      }
      if (sort === "recent") return (b.scannedAt ? new Date(b.scannedAt).getTime() : 0) - (a.scannedAt ? new Date(a.scannedAt).getTime() : 0);
      return a.table.localeCompare(b.table) || a.column.localeCompare(b.column);
    };
    for (const g of list) g.columns.sort(colCmp);

    const grpCmp = (a: SchemaGroup, b: SchemaGroup): number => {
      if (sort === "impact") return b.worstScore - a.worstScore || a.schema.localeCompare(b.schema);
      if (sort === "recent") return (b.lastScanned ? new Date(b.lastScanned).getTime() : 0) - (a.lastScanned ? new Date(a.lastScanned).getTime() : 0);
      return a.schema.localeCompare(b.schema);
    };
    list.sort(grpCmp);
    return list;
  }, [sources, status, q, sort]);

  /* ---- initial open-schemas: auto-expand small workspaces, fold large ones ---- */
  useEffect(() => {
    if (openInit) return;
    if (sources.length === 0) { setOpenInit(true); return; }
    const allSchemas = new Set(sources.map((s) => s.table.split(".")[0]));
    if (allSchemas.size <= AUTO_EXPAND_MAX_SCHEMAS) {
      setOpenSchemas(allSchemas);
    } else if (agg.worst) {
      setOpenSchemas(new Set([agg.worst.table.split(".")[0]]));
    }
    setOpenInit(true);
  }, [sources, agg.worst, openInit]);

  /* ---- when the user types a search, auto-open every group with a match ---- */
  const visibleGroups = useMemo<SchemaGroup[]>(() => groups.slice(0, shown), [groups, shown]);
  const matchingSchemas = useMemo(() => new Set(groups.map((g) => g.schema)), [groups]);
  const effectiveOpen = useMemo(() => {
    if (q.trim().length === 0) return openSchemas;
    return matchingSchemas;
  }, [q, openSchemas, matchingSchemas]);

  /* ---- actions ---- */
  const scan = async () => { setScanning(true); const n = await scanSources(); setScanning(false); setFlash(n); setTimeout(() => setFlash(null), 2600); };
  const derive = async (s: SourceInfo) => {
    const n = await deriveCanonical(s.dimId, s.table, s.column);
    setDerived(n > 0 ? `Imported ${n} master record${n === 1 ? "" : "s"} into ${s.dimension} from ${s.table}.${s.column}` : `${s.table}.${s.column} has no rows to import`);
    setTimeout(() => setDerived(null), 3200);
  };
  const toggleSchema = (k: string) => {
    setOpenSchemas((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const collapseAll = () => setOpenSchemas(new Set());
  const expandAll = () => setOpenSchemas(new Set(groups.map((g) => g.schema)));

  const CHIPS: { k: Status; label: string; n: number }[] = [
    { k: "needs", label: "Needs review", n: counts.needs },
    { k: "all", label: "All", n: sources.length },
    { k: "clean", label: "Clean", n: counts.clean },
  ];

  const SORTS: { k: Sort; label: string }[] = [
    { k: "impact", label: "By impact" },
    { k: "recent", label: "Recently scanned" },
    { k: "name", label: "Alphabetical" },
  ];

  const dashboardSentence = (() => {
    const cols = agg.columns;
    const sys = agg.systems;
    const um = agg.unmapped;
    if (cols === 0) return "No sources wired yet. Connect your first warehouse column to start watching.";
    const head = `${cols.toLocaleString()} column${cols === 1 ? "" : "s"} watched across ${sys} system${sys === 1 ? "" : "s"}`;
    const tail = um > 0
      ? ` · ${um.toLocaleString()} value${um === 1 ? "" : "s"} await${um === 1 ? "s" : ""} a decision.`
      : ` · everything resolved.`;
    return head + tail;
  })();

  const totalFilteredCols = groups.reduce((n, g) => n + g.totalCols, 0);
  const totalFilteredUnmapped = groups.reduce((n, g) => n + g.unmapped, 0);

  return (
    <div>
      {catalog && <CatalogExplorer dims={dims} onClose={() => setCatalog(false)} />}

      {/* ─────────── HEADER (above the ledger, on the canvas) ─────────── */}
      <header className="zz-rise mb-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[clamp(40px,5.6vw,56px)] font-bold leading-[0.95] tracking-[-0.035em] text-ink">
              Sources
            </h1>
            <p className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-ink-2">
              {dashboardSentence}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" icon={<IconWand className="h-3.5 w-3.5" />} onClick={scan} disabled={scanning}>
              {scanning ? "Scanning…" : flash !== null ? `✓ scanned ${flash}` : "Scan all"}
            </Button>
            <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />} onClick={() => setCatalog(true)}>Browse warehouse</Button>
          </div>
        </div>
      </header>

      {derived && <div className="mb-4 border-l-2 border-accent bg-accent-wash px-4 py-2 text-[12.5px] text-accent">{derived}</div>}

      {/* ─────────── LEDGER SURFACE (paper) ─────────── */}
      <section className="zz-rise relative overflow-hidden rounded-xl border border-line bg-surface shadow-pop" style={{ animationDelay: "60ms" }}>
        {/* a thin accent edge at the very top — the 'folder tab' that signals
            this is the working surface and quietly carries the brand */}
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" aria-hidden="true" />

        {/* ─── STANDING CALLOUT (the moment) ─── */}
        {agg.worst && agg.worst.unmapped > 0 ? (
          <div className="border-b border-line border-l-2 border-l-accent bg-accent-wash px-7 py-5">
            <div className="flex items-baseline gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-accent">
              <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
              Standing · today
            </div>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="font-display text-[22px] font-semibold tracking-[-0.02em]">
                  <span className="font-mono text-[18px] text-ink-2">{agg.worst.table}</span>
                  <span className="font-mono text-[18px] text-ink-3">.</span>
                  <span className="font-mono text-[18px] text-ink">{agg.worst.column}</span>
                </div>
                <p className="mt-1.5 text-[13.5px] text-ink-2">
                  <span className="font-semibold text-ink">{agg.worst.unmapped.toLocaleString()}</span> unmapped value{agg.worst.unmapped === 1 ? "" : "s"} across{" "}
                  <span className="font-semibold text-ink">{agg.worst.rows.toLocaleString()}</span> downstream rows in <em className="font-display not-italic text-ink">{agg.worst.dimension}</em>.
                </p>
              </div>
              <Link to="/app/mapping" className="shrink-0">
                <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>Resolve</Button>
              </Link>
            </div>
          </div>
        ) : agg.columns > 0 ? (
          <div className="border-b border-line px-7 py-5">
            <p className="font-display text-[18px] italic text-ink-2">Nothing requires a decision today.</p>
          </div>
        ) : null}

        {/* ─── TOOLBAR (sticky inside the surface) ─── */}
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-surface/95 px-7 py-3 backdrop-blur-sm">
          <label className="flex min-w-[240px] flex-1 items-center gap-2 border-b border-line py-1 text-ink-3 focus-within:border-ink-3">
            <IconSearch className="h-3.5 w-3.5" />
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
              placeholder={`Search ${agg.columns.toLocaleString()} column${agg.columns === 1 ? "" : "s"} across ${agg.systems} system${agg.systems === 1 ? "" : "s"}…`}
              className="w-full bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
            />
            {q.trim() && (
              <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="text-ink-3 hover:text-ink">×</button>
            )}
          </label>

          <div className="flex items-center gap-0.5 rounded-sm border border-line bg-bg p-0.5">
            {CHIPS.map((c) => (
              <button key={c.k} type="button" onClick={() => { setStatus(c.k); setShown(PAGE); }}
                className={cx(
                  "rounded-sm px-2.5 py-1 text-[12px] transition-colors",
                  status === c.k ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2",
                )}>
                {c.label} <span className="font-mono text-[10.5px] text-ink-3">{c.n}</span>
              </button>
            ))}
          </div>

          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
            className="border-0 bg-transparent text-[12.5px] text-ink-2 outline-none hover:text-ink">
            {SORTS.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
          </select>

          {/* expand/collapse all — scales with schema count */}
          {groups.length > 1 && q.trim().length === 0 && (
            <div className="flex items-center gap-2 border-l border-line pl-3 font-mono text-[10.5px] text-ink-3">
              <button type="button" onClick={expandAll} className="hover:text-ink">expand all</button>
              <span className="opacity-40">·</span>
              <button type="button" onClick={collapseAll} className="hover:text-ink">collapse all</button>
            </div>
          )}
        </div>

        {/* ─── GROUPED LEDGER ─── */}
        <div>
          {visibleGroups.map((g) => (
            <SchemaSection
              key={g.schema}
              group={g}
              open={effectiveOpen.has(g.schema)}
              onToggle={() => toggleSchema(g.schema)}
              expanded={expanded}
              setExpanded={setExpanded}
              onScheduleChange={(r, next) => { void setSourceSchedule(r.dimId, r.table, r.column, next); }}
              onDerive={derive}
            />
          ))}

          {groups.length === 0 && (
            <EmptyState
              wired={sources.length}
              filteredByStatus={status !== "all" || !!q.trim()}
              status={status}
              onBrowse={() => setCatalog(true)}
            />
          )}

          {groups.length > shown && (
            <div className="flex items-center justify-between border-t border-line px-7 py-3">
              <span className="font-mono text-[10.5px] text-ink-3">{shown} of {groups.length} systems</span>
              <button type="button" onClick={() => setShown((n) => n + PAGE)}
                className="font-mono text-[11px] text-ink-2 hover:text-ink">Load {Math.min(PAGE, groups.length - shown)} more →</button>
            </div>
          )}
        </div>

        {/* ─── FOOTER — the only at-a-glance totals on the page ─── */}
        {sources.length > 0 && (
          <div className="flex items-center justify-between border-t border-line px-7 py-3 font-mono text-[10.5px] text-ink-3">
            <span>
              {q.trim() || status !== "all" ? `${totalFilteredCols} of ${agg.columns} columns shown` : `${agg.columns} columns watched`}
              {(q.trim() || status !== "all") && totalFilteredUnmapped !== agg.unmapped && (
                <> · {totalFilteredUnmapped.toLocaleString()} unmapped here</>
              )}
            </span>
            <span>
              {agg.totalRowsWatched.toLocaleString()} rows watched
              {agg.lastScanned ? ` · last scan ${ago(agg.lastScanned)} ago` : " · never scanned"}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

/* ===================================================================== */
/*                         Sub-components                                  */
/* ===================================================================== */

function SchemaSection({ group, open, onToggle, expanded, setExpanded, onScheduleChange, onDerive }: {
  group: SchemaGroup;
  open: boolean;
  onToggle: () => void;
  expanded: string | null;
  setExpanded: (next: string | null) => void;
  onScheduleChange: (r: SourceInfo, next: string | null) => void;
  onDerive: (r: SourceInfo) => void;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      {/* schema header */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group sticky top-[57px] z-10 grid w-full grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-4 bg-surface-2/60 px-7 py-2.5 text-left backdrop-blur-sm hover:bg-surface-2"
      >
        <IconChevron className={cx("h-3 w-3 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate font-display text-[15px] font-semibold capitalize text-ink">{group.schema}</span>
          <span className="font-mono text-[10.5px] text-ink-3 tabular-nums">
            {group.totalCols} column{group.totalCols === 1 ? "" : "s"}
            {group.lastScanned ? ` · ${ago(group.lastScanned)} ago` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3 tabular-nums">
          <span>{Math.round(group.coverage)}%</span>
        </div>
        <div className="flex w-[72px] justify-end">
          {group.unmapped > 0 ? (
            <span className="font-display text-[13px] font-semibold tabular-nums text-accent">{group.unmapped.toLocaleString()}</span>
          ) : (
            <span className="font-mono text-[11px] text-ink-3">—</span>
          )}
        </div>
      </button>

      {/* columns under the schema */}
      {open && (
        <div>
          {group.columns.map((r) => {
            const key = `${r.dimId}::${r.table}::${r.column}`;
            return (
              <LedgerRow
                key={key}
                row={r}
                expanded={expanded === key}
                onToggle={() => setExpanded(expanded === key ? null : key)}
                onScheduleChange={(next) => onScheduleChange(r, next)}
                onDerive={() => onDerive(r)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function LedgerRow({ row, expanded, onToggle, onScheduleChange, onDerive }: {
  row: SourceInfo;
  expanded: boolean;
  onToggle: () => void;
  onScheduleChange: (next: string | null) => void;
  onDerive: () => void;
}) {
  const tableName = row.table.split(".").slice(1).join(".") || row.table;
  const coverage = row.values > 0 ? ((row.values - row.unmapped) / row.values) * 100 : (row.scanned ? 100 : 0);
  const stale = daysAgo(row.scannedAt) > STALE_DAYS;
  const standing = !row.scanned && !row.scannedAt
    ? "unscanned"
    : !row.present && row.scanned
      ? "not found"
      : row.unmapped > 0
        ? stale ? "stale drift" : "drift"
        : stale ? "stale" : "clean";
  const standingTone = standing === "clean"
    ? "text-ok"
    : standing === "unscanned" || standing === "not found"
      ? "text-ink-3"
      : "text-warn";
  const standingBarTone = coverage >= 95 ? "bg-ok" : coverage >= 70 ? "bg-ink-3/40" : "bg-accent";

  return (
    <div className={cx("relative transition-colors", expanded ? "bg-surface-2/40" : "hover:bg-hover")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[20px_minmax(0,1fr)_minmax(110px,1fr)_88px_72px_88px] items-center gap-4 px-7 py-2.5 text-left"
      >
        <IconChevron className={cx("h-3 w-3 shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} />
        <div className="min-w-0">
          <div className="truncate font-mono text-[12.5px] text-ink">
            {tableName}
            <span className="text-ink-3">.{row.column}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-ink-3">
            <span>→ <span className="text-ink-2">{row.dimension}</span></span>
            {row.schedule && <span>· {SCHED_LABEL[row.schedule] ?? row.schedule}</span>}
            {row.scannedAt && <span>· {ago(row.scannedAt)} ago</span>}
          </div>
        </div>
        <div className="min-w-0">
          <div className={cx("text-[12px] font-medium", standingTone)}>{standing}</div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-3 tabular-nums">{Math.round(coverage)}% mapped</div>
        </div>
        <div className="text-right text-[12.5px] tabular-nums text-ink-2">{row.rows.toLocaleString()}</div>
        <div className="text-right">
          {row.unmapped > 0 ? (
            <span className="font-display text-[14px] font-semibold tabular-nums text-accent">{row.unmapped.toLocaleString()}</span>
          ) : (
            <span className="font-mono text-[11.5px] text-ink-3 tabular-nums">0</span>
          )}
        </div>
        <div className="flex items-center justify-end gap-1.5">
          <ScanScheduleMenu value={row.schedule ?? null} onChange={onScheduleChange} />
          <button type="button"
            aria-label={`Import master records from ${row.table}.${row.column}`}
            title="Import master records from this column"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDerive(); }}
            className="grid h-6 w-6 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink">
            <IconWand className="h-3 w-3" />
          </button>
        </div>
      </button>
      {/* standing bar — 1px hairline that fills from the left in the row's tone */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line">
        <div className={cx("h-full transition-[width] duration-500", standingBarTone)} style={{ width: `${Math.max(0, Math.min(100, coverage))}%` }} />
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
    <div className="border-t border-line/60 bg-bg/30 px-7 py-4 pl-[68px]">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-3">
        Top unmapped values{row.unmapped > 0 ? ` — showing up to 8 of ${row.unmapped.toLocaleString()}` : ""}
      </div>
      {sample === "loading" ? (
        <div className="mt-2 text-[12px] text-ink-3">loading…</div>
      ) : sample === "error" ? (
        <div className="mt-2 text-[12px] text-danger">couldn&apos;t load — is the warehouse attached?</div>
      ) : sample.length === 0 ? (
        row.unmapped > 0 ? (
          <div className="mt-2 text-[12px] text-ink-3">Run a scan — the unmapped count is cached; the sample needs a live read.</div>
        ) : (
          <div className="mt-2 text-[12px] text-ok">No unmapped values here.</div>
        )
      ) : (
        <ul className="mt-3 grid gap-1.5">
          {sample.map((s, i) => (
            <li key={i} className="grid grid-cols-[1fr_auto] items-baseline gap-3">
              <span className="truncate font-mono text-[12.5px] text-ink">{s.raw}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">{s.rows.toLocaleString()} rows</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center gap-3 text-[11.5px] text-ink-3">
        <Link to="/app/mapping" className="text-accent hover:underline">Resolve in Match values →</Link>
        <span>→ {row.dimension}</span>
      </div>
    </div>
  );
}

function EmptyState({ wired, filteredByStatus, status, onBrowse }: { wired: number; filteredByStatus: boolean; status: Status; onBrowse: () => void }) {
  if (wired === 0) {
    return (
      <div className="py-16 text-center">
        <div className="font-display text-[20px] italic text-ink-2">No sources wired yet.</div>
        <p className="mx-auto mt-2 max-w-[48ch] text-[13px] text-ink-3">A source is a warehouse column Zug Zug watches for new values. Browse your warehouse to wire the first one.</p>
        <div className="mt-5 flex justify-center">
          <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />} onClick={onBrowse}>Browse warehouse</Button>
        </div>
      </div>
    );
  }
  if (filteredByStatus && status === "clean") {
    return <div className="py-12 text-center"><div className="font-display text-[18px] italic text-ok">Everything here is clean.</div></div>;
  }
  if (filteredByStatus && status === "needs") {
    return <div className="py-12 text-center"><div className="font-display text-[18px] italic text-ok">Nothing needs your attention.</div></div>;
  }
  return <div className="py-12 text-center text-[12.5px] text-ink-3">nothing matches this filter</div>;
}
