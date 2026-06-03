import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { CatalogExplorer } from "../components/CatalogExplorer";
import { ScanScheduleMenu } from "../components/ScanScheduleMenu";
import { IconSearch, IconWand, IconArrowRight } from "../components/Icons";
import { cx } from "../lib/cx";
import {
  useDimensions, useSources, scanSources, deriveCanonical, setSourceSchedule,
  fetchUnmappedSample, type SourceInfo, type UnmappedSample,
} from "../store";

/* Sources — the Operator's Ledger.
   One document; the standing of every warehouse column on the record. Accent
   appears in exactly two surfaces: the Standing callout (the single highest-
   impact row, called out by name) and the unmapped count on a row when > 0.
   Everything else lives in ink/line. */

const SCHED_LABEL: Record<string, string> = { "15m": "auto 15m", hourly: "auto hourly", daily: "auto daily" };
const STALE_DAYS = 7;
const PAGE = 30;

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

/* The row's standing bar — a 1px underline that fills from the left in the
   row's standing tone. Mid-coverage is neutral (ink-3); only the worst rows
   (<70%) carry accent, so they visually scream. */
function StandingFill({ pct }: { pct: number }) {
  const tone = pct >= 95 ? "bg-ok" : pct >= 70 ? "bg-ink-3/60" : "bg-accent";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line">
      <div className={cx("h-full transition-[width] duration-500", tone)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
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

  /* per-schema rollup for the tabs */
  const schemaTabs = useMemo(() => {
    const m = new Map<string, { schema: string; columns: number; unmapped: number }>();
    for (const s of sources) {
      const k = s.table.split(".")[0];
      const e = m.get(k) ?? { schema: k, columns: 0, unmapped: 0 };
      e.columns += 1;
      e.unmapped += s.unmapped;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.unmapped - a.unmapped || a.schema.localeCompare(b.schema));
  }, [sources]);

  const counts = useMemo(() => {
    const c: Record<RealStatus, number> = { needs: 0, clean: 0, missing: 0 };
    for (const s of sources) c[statusOf(s)]++;
    return c;
  }, [sources]);

  /* filter + sort */
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
  ];

  const SORTS: { k: Sort; label: string }[] = [
    { k: "impact", label: "By impact" },
    { k: "recent", label: "Recently scanned" },
    { k: "name", label: "Alphabetical" },
  ];

  /* prose dashboard sentence — replaces the metric tile array */
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

  return (
    <div>
      {catalog && <CatalogExplorer dims={dims} onClose={() => setCatalog(false)} />}

      {/* ─────────── HEADER ─────────── */}
      <header className="zz-rise">
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
            <Button variant="ghost" size="sm" onClick={() => setCatalog(true)}>Wire a source</Button>
            <Button variant="ghost" size="sm" icon={<IconWand className="h-3.5 w-3.5" />} onClick={scan} disabled={scanning}>
              {scanning ? "Scanning…" : flash !== null ? `✓ scanned ${flash}` : "Scan all"}
            </Button>
          </div>
        </div>
        <div className="mt-8 h-px bg-line" />
      </header>

      {/* ─────────── STANDING CALLOUT (the moment) ─────────── */}
      {agg.worst && agg.worst.unmapped > 0 ? (
        <div className="zz-rise -mx-8 mt-6 mb-10 border-l-2 border-accent bg-accent-wash px-8 py-5" style={{ animationDelay: "120ms" }}>
          <div className="flex items-baseline gap-3 font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-accent">
            <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
            Standing · today
          </div>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="font-display text-[22px] font-semibold tracking-[-0.02em] text-ink">
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
        <div className="zz-rise mt-6 mb-10" style={{ animationDelay: "120ms" }}>
          <p className="font-display text-[20px] italic text-ink-2">Nothing requires a decision today.</p>
        </div>
      ) : (
        <div className="mt-6" />
      )}

      {derived && (
        <div className="mb-6 border-l-2 border-accent bg-accent-wash px-4 py-2 text-[12.5px] text-accent">{derived}</div>
      )}

      {/* ─────────── SCHEMA TABS ─────────── */}
      {schemaTabs.length > 0 && (
        <nav className="zz-rise flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-line pb-3" style={{ animationDelay: "180ms" }}>
          <TabBtn
            label="All"
            count={sources.length}
            active={schema === null}
            onClick={() => { setSchema(null); setShown(PAGE); }}
          />
          {schemaTabs.map((t) => (
            <TabBtn
              key={t.schema}
              label={t.schema}
              count={t.columns}
              warn={t.unmapped > 0}
              active={schema === t.schema}
              onClick={() => { setSchema(t.schema === schema ? null : t.schema); setShown(PAGE); }}
            />
          ))}
        </nav>
      )}

      {/* ─────────── FILTER BAR ─────────── */}
      <div className="zz-rise mt-2 flex flex-wrap items-center gap-3 border-b border-line py-3" style={{ animationDelay: "240ms" }}>
        <label className="flex min-w-[220px] flex-1 items-center gap-2 border-b border-transparent py-1 text-ink-3 focus-within:border-ink-3">
          <IconSearch className="h-3.5 w-3.5" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
            placeholder="Search columns, tables, master lists…"
            className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3" />
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
      </div>

      {/* ─────────── LEDGER ─────────── */}
      <div className="zz-rise" style={{ animationDelay: "300ms" }}>
        {/* column header (very quiet) */}
        <div className="grid grid-cols-[minmax(0,1fr)_120px_96px_72px_88px] items-center gap-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-3">
          <span>Column</span>
          <span>Status</span>
          <span className="text-right">Rows</span>
          <span className="text-right">Unmapped</span>
          <span />
        </div>

        {visible.map((r) => (
          <LedgerRow
            key={`${r.dimId}::${r.table}::${r.column}`}
            row={r}
            expanded={expanded === `${r.dimId}::${r.table}::${r.column}`}
            onToggle={() => setExpanded((e) => e === `${r.dimId}::${r.table}::${r.column}` ? null : `${r.dimId}::${r.table}::${r.column}`)}
            onScheduleChange={(next) => { void setSourceSchedule(r.dimId, r.table, r.column, next); }}
            onDerive={() => derive(r)}
          />
        ))}

        {filtered.length === 0 && (
          <EmptyState wired={sources.length} filteredByStatus={status !== "all" || !!schema || !!q.trim()} status={status} />
        )}

        {filtered.length > shown && (
          <div className="flex items-center justify-between py-3">
            <span className="font-mono text-[10.5px] text-ink-3">{visible.length} of {filtered.length}</span>
            <button type="button" onClick={() => setShown((n) => n + PAGE)}
              className="font-mono text-[11px] text-ink-2 hover:text-ink">Load {Math.min(PAGE, filtered.length - shown)} more →</button>
          </div>
        )}

        {/* ledger footer — the only at-a-glance totals on the page */}
        {sources.length > 0 && (
          <div className="mt-4 pt-3 text-right font-mono text-[10.5px] text-ink-3">
            {agg.columns} columns · {agg.totalRowsWatched.toLocaleString()} rows watched
            {agg.lastScanned ? ` · last scan ${ago(agg.lastScanned)} ago` : " · never scanned"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================================================================== */
/*                         Sub-components                                  */
/* ===================================================================== */

function TabBtn({ label, count, active, warn, onClick }: { label: string; count: number; active: boolean; warn?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group flex items-baseline gap-1.5 border-b-2 pb-1 font-display text-[14px] font-medium transition-colors",
        active ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink",
      )}
    >
      <span className="capitalize">{label}</span>
      <span className={cx("font-mono text-[10.5px] tabular-nums", warn && !active ? "text-warn" : "text-ink-3")}>{count}</span>
    </button>
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
  const lastSeg = tableName.split(".").slice(-1)[0];
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

  return (
    <div className={cx("relative border-t border-transparent transition-colors", expanded ? "bg-surface-2/40" : "hover:bg-hover")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[minmax(0,1fr)_120px_96px_72px_88px] items-center gap-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] text-ink">
            <span className="text-ink-3">{row.table.split(".")[0]}.</span>
            {lastSeg}
            <span className="text-ink-3">.{row.column}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
            <span>→ <span className="text-ink-2">{row.dimension}</span></span>
            {row.schedule && <span>· {SCHED_LABEL[row.schedule] ?? row.schedule}</span>}
            {row.scannedAt && <span>· {ago(row.scannedAt)} ago</span>}
          </div>
        </div>
        <div className="min-w-0">
          <div className={cx("text-[12.5px] font-medium", standingTone)}>{standing}</div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ink-3 tabular-nums">{Math.round(coverage)}% mapped</div>
        </div>
        <div className="text-right text-[13px] tabular-nums text-ink-2">{row.rows.toLocaleString()}</div>
        <div className="text-right">
          {row.unmapped > 0 ? (
            <span className="font-display text-[14px] font-semibold text-accent tabular-nums">{row.unmapped.toLocaleString()}</span>
          ) : (
            <span className="font-mono text-[12px] text-ink-3 tabular-nums">0</span>
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
      <StandingFill pct={coverage} />
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
    <div className="border-t border-line/60 px-0 py-4 pl-0">
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

function EmptyState({ wired, filteredByStatus, status }: { wired: number; filteredByStatus: boolean; status: Status }) {
  if (wired === 0) {
    return (
      <div className="py-16 text-center">
        <div className="font-display text-[20px] italic text-ink-2">No sources wired yet.</div>
        <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-ink-3">A source is a warehouse column Zug Zug watches for new values. Wire your first to start tracking.</p>
      </div>
    );
  }
  if (filteredByStatus && status === "clean") {
    return (
      <div className="py-12 text-center">
        <div className="font-display text-[18px] italic text-ok">Everything here is clean.</div>
      </div>
    );
  }
  if (filteredByStatus && status === "needs") {
    return (
      <div className="py-12 text-center">
        <div className="font-display text-[18px] italic text-ok">Nothing needs your attention.</div>
      </div>
    );
  }
  return (
    <div className="py-12 text-center text-[12.5px] text-ink-3">nothing matches this filter</div>
  );
}
