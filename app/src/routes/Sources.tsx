import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/Button";
import { CatalogExplorer } from "../components/CatalogExplorer";
import { PageHeader } from "../components/PageHeader";
import { LedgerRow } from "../components/sources/LedgerRow";
import { ago } from "../components/sources/utils";
import { IconSearch, IconWand, IconArrowRight, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import { useDimensions, useSources, scanSources, deriveCanonical, type SourceInfo } from "../store";
import { useSourcesCursor } from "./use-sources-cursor";

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

const PAGE = 60;
/* schemas auto-expand when there are this many or fewer wired; beyond that,
   only the schema containing the standing source opens by default. */
const AUTO_EXPAND_MAX_SCHEMAS = 6;

type RealStatus = "needs" | "clean" | "missing";
type Status = RealStatus | "all";
type Sort = "impact" | "name" | "recent";

const statusOf = (s: SourceInfo): RealStatus =>
  s.unmapped > 0 ? "needs" : s.scanned && !s.present ? "missing" : "clean";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";
  const initialStatus = ((): Status => {
    const v = searchParams.get("status");
    return v === "needs" || v === "all" || v === "clean" || v === "missing" ? v : "needs";
  })();
  const initialSort = ((): Sort => {
    const v = searchParams.get("sort");
    return v === "impact" || v === "name" || v === "recent" ? v : "impact";
  })();

  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState<Status>(initialStatus);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [shown, setShown] = useState(PAGE);
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [derived, setDerived] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null); // expanded column drill
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openInit, setOpenInit] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ---- aggregates ---- */
  const agg = useMemo(() => {
    let columns = 0,
      scannedCols = 0,
      valuesSum = 0,
      unmapped = 0,
      atRisk = 0;
    let worst: SourceInfo | null = null;
    let worstScore = 0;
    let lastScanned: string | null = null;
    for (const s of sources) {
      columns++;
      if (s.scanned || s.scannedAt) scannedCols++;
      valuesSum += s.values;
      unmapped += s.unmapped;
      if (s.unmapped > 0) atRisk += s.rows;
      if (s.scannedAt && (!lastScanned || new Date(s.scannedAt) > new Date(lastScanned)))
        lastScanned = s.scannedAt;
      const score = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (score > worstScore) {
        worstScore = score;
        worst = s;
      }
    }
    const systems = new Set(sources.map((s) => s.table.split(".")[0])).size;
    const totalRowsWatched = sources.reduce((n, s) => n + s.rows, 0);
    return {
      columns,
      scannedCols,
      valuesSum,
      unmapped,
      atRisk,
      worst,
      systems,
      totalRowsWatched,
      lastScanned,
    };
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
    const filtered = sources.filter(
      (s) =>
        (status === "all" || statusOf(s) === status) &&
        (!needle || `${s.table}.${s.column} ${s.dimension}`.toLowerCase().includes(needle)),
    );
    const map = new Map<string, SchemaGroup>();
    for (const s of filtered) {
      const k = s.table.split(".")[0];
      const g = map.get(k) ?? {
        schema: k,
        columns: [],
        totalCols: 0,
        unmapped: 0,
        values: 0,
        rows: 0,
        coverage: 0,
        lastScanned: null,
        worstScore: 0,
      };
      g.columns.push(s);
      g.totalCols++;
      g.unmapped += s.unmapped;
      g.values += s.values;
      g.rows += s.rows;
      if (s.scannedAt && (!g.lastScanned || new Date(s.scannedAt) > new Date(g.lastScanned)))
        g.lastScanned = s.scannedAt;
      const sc = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (sc > g.worstScore) g.worstScore = sc;
      map.set(k, g);
    }
    for (const g of map.values())
      g.coverage = g.values > 0 ? ((g.values - g.unmapped) / g.values) * 100 : 100;
    const list = [...map.values()];

    const colCmp = (a: SourceInfo, b: SourceInfo): number => {
      if (sort === "impact") {
        const sa = a.unmapped > 0 ? a.unmapped * Math.log10(Math.max(10, a.rows)) : -1;
        const sb = b.unmapped > 0 ? b.unmapped * Math.log10(Math.max(10, b.rows)) : -1;
        return sb - sa;
      }
      if (sort === "recent")
        return (
          (b.scannedAt ? new Date(b.scannedAt).getTime() : 0) -
          (a.scannedAt ? new Date(a.scannedAt).getTime() : 0)
        );
      return a.table.localeCompare(b.table) || a.column.localeCompare(b.column);
    };
    for (const g of list) g.columns.sort(colCmp);

    const grpCmp = (a: SchemaGroup, b: SchemaGroup): number => {
      if (sort === "impact") return b.worstScore - a.worstScore || a.schema.localeCompare(b.schema);
      if (sort === "recent")
        return (
          (b.lastScanned ? new Date(b.lastScanned).getTime() : 0) -
          (a.lastScanned ? new Date(a.lastScanned).getTime() : 0)
        );
      return a.schema.localeCompare(b.schema);
    };
    list.sort(grpCmp);
    return list;
  }, [sources, status, q, sort]);

  /* ---- initial open-schemas: auto-expand small workspaces, fold large ones ---- */
  useEffect(() => {
    if (openInit) return;
    if (sources.length === 0) {
      setOpenInit(true);
      return;
    }
    const allSchemas = new Set(sources.map((s) => s.table.split(".")[0]));
    const focusParam = searchParams.get("focus");
    if (focusParam && allSchemas.has(focusParam)) {
      // honor the deep-link first; auto-expand still applies on top per spec
      // open question #6, which we resolve "preserves user intent" (add to set).
      if (allSchemas.size <= AUTO_EXPAND_MAX_SCHEMAS) {
        setOpenSchemas(allSchemas);
      } else if (agg.worst) {
        setOpenSchemas(new Set([focusParam, agg.worst.table.split(".")[0]]));
      } else {
        setOpenSchemas(new Set([focusParam]));
      }
    } else if (allSchemas.size <= AUTO_EXPAND_MAX_SCHEMAS) {
      setOpenSchemas(allSchemas);
    } else if (agg.worst) {
      setOpenSchemas(new Set([agg.worst.table.split(".")[0]]));
    }
    setOpenInit(true);
  }, [sources, agg.worst, openInit, searchParams]);

  /* ---- URL write-through: q is debounced 200ms ---- */
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (q.trim()) next.set("q", q);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 200);
    return () => clearTimeout(handle);
  }, [q, setSearchParams]);

  /* ---- URL write-through: status + sort are immediate ---- */
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (status !== "needs") next.set("status", status);
        else next.delete("status");
        if (sort !== "impact") next.set("sort", sort);
        else next.delete("sort");
        return next;
      },
      { replace: true },
    );
  }, [status, sort, setSearchParams]);

  /* ---- when the user types a search, auto-open every group with a match ---- */
  const visibleGroups = useMemo<SchemaGroup[]>(() => groups.slice(0, shown), [groups, shown]);
  const matchingSchemas = useMemo(() => new Set(groups.map((g) => g.schema)), [groups]);
  const effectiveOpen = useMemo(() => {
    if (q.trim().length === 0) return openSchemas;
    return matchingSchemas;
  }, [q, openSchemas, matchingSchemas]);

  // Flatten visible expanded-schema rows into an ordered key list for the cursor.
  // A row that lives inside a collapsed schema is unreachable via j/k; collapsing
  // a schema while the cursor is on one of its rows triggers staleness in the hook.
  const visibleKeys = useMemo<string[]>(() => {
    const out: string[] = [];
    for (const g of visibleGroups) {
      if (!effectiveOpen.has(g.schema)) continue;
      for (const r of g.columns) out.push(`${r.dimId}::${r.table}::${r.column}`);
    }
    return out;
  }, [visibleGroups, effectiveOpen]);

  const rowsWithUnmapped = useMemo<string[]>(
    () =>
      visibleKeys.filter((k) => {
        // O(N·M) lookup is fine — visible row counts are bounded by PAGE (=60).
        for (const g of visibleGroups) {
          for (const r of g.columns) {
            if (`${r.dimId}::${r.table}::${r.column}` === k) return r.unmapped > 0;
          }
        }
        return false;
      }),
    [visibleKeys, visibleGroups],
  );

  const cursor = useSourcesCursor({
    visibleKeys,
    rowsWithUnmapped,
    toggleDrillAt: (key) => setExpanded(expanded === key ? null : key),
    focusSearch: () => searchInputRef.current?.focus(),
  });

  // Bring the focused row into view as the cursor moves. The ledger surface
  // (the parent <section>) is the scroll context, so scrollIntoView with
  // block:"nearest" keeps the sticky toolbar pinned at the top.
  useLayoutEffect(() => {
    const key = cursor.cursor;
    if (!key) return;
    const el = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor.cursor]);

  /* ---- actions ---- */
  const scan = async () => {
    setScanning(true);
    const n = await scanSources();
    setScanning(false);
    setFlash(n);
    setTimeout(() => setFlash(null), 2600);
  };
  const derive = async (s: SourceInfo) => {
    const n = await deriveCanonical(s.dimId, s.table, s.column);
    setDerived(
      n > 0
        ? `Imported ${n} record${n === 1 ? "" : "s"} into ${s.dimension} from ${s.table}.${s.column}`
        : `${s.table}.${s.column} has no rows to import`,
    );
    setTimeout(() => setDerived(null), 3200);
  };
  const toggleSchema = (k: string) => {
    setOpenSchemas((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const CHIPS: { k: Status; label: string; n: number }[] = [
    { k: "needs", label: "Needs review", n: counts.needs },
    { k: "all", label: "All", n: sources.length },
    { k: "clean", label: "Clean", n: counts.clean },
  ];

  const SORTS: { k: Sort; label: string }[] = [
    { k: "impact", label: "Most affected" },
    { k: "recent", label: "Recently scanned" },
    { k: "name", label: "Alphabetical" },
  ];

  const dashboardSentence = (() => {
    const cols = agg.columns;
    const sys = agg.systems;
    const um = agg.unmapped;
    if (cols === 0)
      return "No sources wired yet. Connect your first warehouse column to start watching.";
    const head = `${cols.toLocaleString()} column${cols === 1 ? "" : "s"} watched across ${sys} system${sys === 1 ? "" : "s"}`;
    const tail =
      um > 0
        ? ` · ${um.toLocaleString()} value${um === 1 ? "" : "s"} await${um === 1 ? "s" : ""} a decision.`
        : ` · everything resolved.`;
    return head + tail;
  })();

  const totalFilteredCols = groups.reduce((n, g) => n + g.totalCols, 0);
  const totalFilteredUnmapped = groups.reduce((n, g) => n + g.unmapped, 0);

  return (
    <div className="flex h-full min-h-0 flex-col px-2 pb-3 pt-3 md:px-5 md:pb-5 md:pt-4">
      {catalog && <CatalogExplorer dims={dims} onClose={() => setCatalog(false)} />}

      {/* ─────────── HEADER (above the ledger, on the canvas) ─────────── */}
      <div className="mb-3 shrink-0">
        <PageHeader
          kicker="Warehouse"
          title="Sources"
          lede={dashboardSentence}
          action={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                icon={
                  scanning ? (
                    <span
                      aria-hidden
                      className="block h-3.5 w-3.5 animate-spin rounded-pill border-2 border-line-2 border-t-accent"
                    />
                  ) : (
                    <IconWand className="h-3.5 w-3.5" />
                  )
                }
                onClick={scan}
                disabled={scanning}
              >
                {scanning ? "Scanning…" : flash !== null ? `✓ scanned ${flash}` : "Scan all"}
              </Button>
              <Button
                size="sm"
                icon={<IconArrowRight className="h-3.5 w-3.5" />}
                onClick={() => setCatalog(true)}
              >
                Browse warehouse
              </Button>
            </div>
          }
        />
      </div>

      {derived && (
        <div className="mb-3 shrink-0 border-l-2 border-accent bg-accent-wash px-4 py-2 text-[12px] text-accent md:text-[12.5px]">
          {derived}
        </div>
      )}

      {/* ─────────── LEDGER SURFACE (paper) ─────────── */}
      <section
        tabIndex={0}
        onKeyDown={cursor.onKeyDown}
        className="zz-rise relative flex min-h-0 flex-1 flex-col overflow-hidden border border-line bg-surface shadow-pop outline-none focus:ring-1 focus:ring-accent/30"
        style={{ animationDelay: "60ms" }}
      >
        {/* a thin accent edge at the very top — the 'folder tab' that signals
            this is the working surface and quietly carries the brand */}
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent"
          aria-hidden="true"
        />

        {/* ─── STANDING CALLOUT (the moment) ─── */}
        {agg.worst && agg.worst.unmapped > 0 ? (
          <div className="border-b border-line border-l-2 border-l-accent bg-accent-wash px-4 py-3 md:px-7">
            <div className="flex items-baseline gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-accent">
              <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
              Standing · today
            </div>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="font-display text-[18px] font-semibold tracking-[-0.02em] md:text-[22px]">
                  <span className="truncate font-mono text-[15px] text-ink-2 md:text-[18px]">
                    {agg.worst.table}
                  </span>
                  <span className="font-mono text-[15px] text-ink-3 md:text-[18px]">.</span>
                  <span className="font-mono text-[15px] text-ink md:text-[18px]">
                    {agg.worst.column}
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] text-ink-2 md:text-[13.5px]">
                  <span className="font-semibold text-ink">
                    {agg.worst.unmapped.toLocaleString()}
                  </span>{" "}
                  unmapped value{agg.worst.unmapped === 1 ? "" : "s"} across{" "}
                  <span className="font-semibold text-ink">{agg.worst.rows.toLocaleString()}</span>{" "}
                  downstream rows in{" "}
                  <em className="font-display not-italic text-ink">{agg.worst.dimension}</em>.
                </p>
              </div>
              <Link
                to={`/app/tables?open=${agg.worst.dimId}&active=${agg.worst.dimId}&mode=match`}
                className="shrink-0"
              >
                <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
                  Resolve
                </Button>
              </Link>
            </div>
          </div>
        ) : agg.columns > 0 ? (
          <div className="border-b border-line px-4 py-3 md:px-7">
            <p className="font-display text-[18px] italic text-ink-2">
              Nothing requires a decision today.
            </p>
          </div>
        ) : null}

        {/* scroll region — Standing scrolls away, Toolbar sticks at the top,
            the ledger flows underneath. The page footer below is pinned. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* ─── TOOLBAR (sticky inside the surface) ─── */}
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur-sm md:gap-3 md:px-7">
            <label className="flex min-w-0 flex-1 items-center gap-2 border-b border-line py-1 text-ink-3 focus-within:border-ink-3 md:min-w-[240px]">
              <IconSearch className="h-3.5 w-3.5" />
              <input
                ref={searchInputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setShown(PAGE);
                }}
                placeholder={`Search ${agg.columns.toLocaleString()} column${agg.columns === 1 ? "" : "s"} across ${agg.systems} system${agg.systems === 1 ? "" : "s"}…`}
                className="w-full bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
              />
              {q.trim() && (
                <button
                  type="button"
                  onClick={() => setQ("")}
                  aria-label="Clear search"
                  className="text-ink-3 transition-colors hover:text-ink"
                >
                  ×
                </button>
              )}
            </label>

            <div className="flex items-center gap-0.5 rounded-sm border border-line bg-bg p-0.5">
              {CHIPS.map((c) => (
                <button
                  key={c.k}
                  type="button"
                  onClick={() => {
                    setStatus(c.k);
                    setShown(PAGE);
                  }}
                  className={cx(
                    "rounded-sm px-2.5 py-1 text-[12px] transition-colors",
                    status === c.k ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  {c.label} <span className="font-mono text-[10.5px] text-ink-3">{c.n}</span>
                </button>
              ))}
            </div>

            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-sm border-0 bg-transparent px-1 text-[12.5px] text-ink-2 outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {SORTS.map((s) => (
                <option key={s.k} value={s.k}>
                  {s.label}
                </option>
              ))}
            </select>
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
                focusedRowKey={cursor.cursor}
                onRowClick={cursor.setCursor}
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
              <div className="flex items-center justify-between border-t border-line px-4 py-3 md:px-7">
                <span className="font-mono text-[10.5px] text-ink-3">
                  {shown} of {groups.length} systems
                </span>
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE)}
                  className="font-mono text-[11px] text-ink-2 hover:text-ink"
                >
                  Load {Math.min(PAGE, groups.length - shown)} more →
                </button>
              </div>
            )}
          </div>
        </div>
        {/* /scroll region */}

        {/* ─── FOOTER — the only at-a-glance totals on the page ─── */}
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-1 border-t border-line px-4 py-3 font-mono text-[10.5px] text-ink-3 md:flex-nowrap md:px-7">
            <span>
              {q.trim() || status !== "all"
                ? `${totalFilteredCols} of ${agg.columns} columns shown`
                : `${agg.columns} columns watched`}
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

function SchemaSection({
  group,
  open,
  onToggle,
  expanded,
  setExpanded,
  onDerive,
  focusedRowKey,
  onRowClick,
}: {
  group: SchemaGroup;
  open: boolean;
  onToggle: () => void;
  expanded: string | null;
  setExpanded: (next: string | null) => void;
  onDerive: (r: SourceInfo) => void;
  focusedRowKey?: string | null;
  onRowClick?: (key: string) => void;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      {/* schema header */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group grid w-full grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-3 bg-surface-2/60 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 md:gap-4 md:px-7"
      >
        <IconChevron
          className={cx("h-3 w-3 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
        />
        <div className="flex min-w-0 items-baseline gap-2 md:gap-3">
          <span className="truncate font-display text-[15px] font-semibold capitalize text-ink">
            {group.schema}
          </span>
          <span className="font-mono text-[10.5px] text-ink-3 tabular-nums">
            {group.totalCols} col{group.totalCols === 1 ? "" : "s"}
            <span className="hidden md:inline">umn{group.totalCols === 1 ? "" : "s"}</span>
            {group.lastScanned ? ` · ${ago(group.lastScanned)} ago` : ""}
          </span>
        </div>
        <div className="hidden items-center gap-1.5 font-mono text-[11px] text-ink-3 tabular-nums md:flex">
          <span>{Math.round(group.coverage)}%</span>
        </div>
        <div className="flex w-[56px] justify-end md:w-[72px]">
          {group.unmapped > 0 ? (
            <span className="font-display text-[13px] font-semibold tabular-nums text-accent">
              {group.unmapped.toLocaleString()}
            </span>
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
                rowKey={key}
                row={r}
                expanded={expanded === key}
                focused={focusedRowKey === key}
                onToggle={() => {
                  onRowClick?.(key);
                  setExpanded(expanded === key ? null : key);
                }}
                onDerive={() => onDerive(r)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  wired,
  filteredByStatus,
  status,
  onBrowse,
}: {
  wired: number;
  filteredByStatus: boolean;
  status: Status;
  onBrowse: () => void;
}) {
  if (wired === 0) {
    return (
      <div className="py-16 text-center">
        <div className="font-display text-[20px] italic text-ink-2">No sources wired yet.</div>
        <p className="mx-auto mt-2 max-w-[48ch] text-[13px] text-ink-3">
          A source is a warehouse column Zug Zug watches for new values. Browse your warehouse to
          wire the first one.
        </p>
        <div className="mt-5 flex justify-center">
          <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />} onClick={onBrowse}>
            Browse warehouse
          </Button>
        </div>
      </div>
    );
  }
  if (filteredByStatus && status === "clean") {
    return (
      <div className="py-12 text-center">
        <div className="font-display text-[18px] font-semibold text-ink">
          Everything here is clean. 💎
        </div>
      </div>
    );
  }
  if (filteredByStatus && status === "needs") {
    return (
      <div className="py-12 text-center">
        <div className="font-display text-[18px] font-semibold text-ink">
          Nothing needs your attention. ☮️
        </div>
      </div>
    );
  }
  return (
    <div className="py-12 text-center text-[12.5px] text-ink-3">nothing matches this filter</div>
  );
}
