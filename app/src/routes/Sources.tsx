import { useEffect, useMemo, useState } from "react";
import { usePageTitle } from "../hooks/usePageTitle";
import { Link, useNavigate } from "react-router-dom";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { Button } from "../components/Button";
import { EmptyState as SetupCard } from "../components/EmptyState";
import { CatalogExplorer } from "../components/CatalogExplorer";
import { PageHeader } from "../components/PageHeader";
import { SourceRow } from "../components/sources/SourceRow";
import { ago } from "../components/sources/utils";
import { IconWand, IconArrowRight, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import {
  useDimensions,
  useSources,
  scanSources,
  deriveCanonical,
  removeSource,
  useCanEdit,
  useStoreLoading,
  type SourceInfo,
} from "../store";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { toast } from "../components/Toast";

/* Sources — a calm connection surface. The wired warehouse columns, grouped by
   system so a user with 100 schemas navigates by collapsing not scrolling, plus
   a single review pointer to the most-affected table. No monitoring dashboard. */

/* schemas auto-expand when there are this many or fewer wired; beyond that,
   only the schema containing the most-affected source opens by default. */
const AUTO_EXPAND_MAX_SCHEMAS = 6;

interface SchemaGroup {
  schema: string;
  columns: SourceInfo[];
  totalCols: number;
  unmapped: number;
  lastScanned: string | null;
}

function SourcesLoader() {
  return (
    <div className="flex h-full min-h-0 flex-col px-2 pb-3 pt-3 md:px-5 md:pb-5 md:pt-4">
      <div className="mb-3 shrink-0 animate-pulse space-y-2">
        <div className="h-2.5 w-14 rounded-sm bg-surface-3" />
        <div className="h-5 w-72 rounded-sm bg-surface-3" />
      </div>
      <div className="flex-1 animate-pulse overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          {[64, 48, 48, 64].map((w, i) => (
            <div key={i} className="h-5 rounded-sm bg-surface-3" style={{ width: w }} />
          ))}
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2 px-4 py-3">
              <div className="h-3.5 w-24 rounded-sm bg-surface-3" />
              {Array.from({ length: 2 }).map((_, j) => (
                <div key={j} className="flex items-center gap-3 pl-4">
                  <div className="h-3 w-36 rounded-sm bg-surface-3" />
                  <div className="ml-auto h-3 w-16 rounded-sm bg-surface-3" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Sources() {
  usePageTitle("Sources");
  const sources = useSources();
  const dims = useDimensions();
  const canEdit = useCanEdit();
  const nav = useNavLinks();
  const loading = useStoreLoading();

  const [catalog, setCatalog] = useState(false);
  // CatalogExplorer owns the database picker; we just remember the last pick
  // so a returning user lands on the same db without having to reselect it.
  const [catalogDb, setCatalogDb] = useState<string | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openInit, setOpenInit] = useState(false);

  const scanAction = useAsyncAction(async () => {
    try {
      const n = await scanSources();
      toast(`Scanned ${n} value${n === 1 ? "" : "s"}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't scan.", "error");
    }
  });

  const outcomeText = (result: {
    mode: "seed" | "connect";
    derived?: number;
    matched?: number;
    unmatched?: number;
  }): string => {
    if (result.mode === "seed") {
      if ((result.derived ?? 0) > 0) {
        return `${result.derived} record${result.derived === 1 ? "" : "s"} created`;
      }
      return "no values yet";
    }
    const m = result.matched ?? 0;
    const u = result.unmatched ?? 0;
    if (m > 0 && u > 0) {
      return `${m} matched, ${u} to review`;
    }
    if (m > 0) {
      return `${m} matched, all done`;
    }
    if (u > 0) {
      return `${u} to review`;
    }
    return "no new values";
  };

  const deriveAction = useAsyncAction(async (s: SourceInfo) => {
    try {
      const result = await deriveCanonical(s.dimId, s.table, s.column);
      toast(`Re-scanned ${s.table}.${s.column} · ${outcomeText(result)}`);
    } catch (e) {
      toast(
        e instanceof Error
          ? `Couldn't re-scan ${s.table}.${s.column}: ${e.message}`
          : `Couldn't re-scan ${s.table}.${s.column}.`,
        "error",
      );
      throw e;
    }
  });

  const removeAction = useAsyncAction(async (s: SourceInfo) => {
    if (
      !window.confirm(
        `Remove ${s.table}.${s.column} from ${s.dimension}? This unwires the column; it won't delete any records.`,
      )
    )
      return;
    try {
      await removeSource(s.dimId, s.table, s.column);
      toast(`Removed ${s.table}.${s.column}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove source.", "error");
    }
  });

  /* ---- aggregates (header + review pointer only) ---- */
  const agg = useMemo(() => {
    let unmapped = 0;
    let worst: SourceInfo | null = null;
    let worstScore = 0;
    for (const s of sources) {
      unmapped += s.unmapped;
      const score = s.unmapped > 0 ? s.unmapped * Math.log10(Math.max(10, s.rows)) : 0;
      if (score > worstScore) {
        worstScore = score;
        worst = s;
      }
    }
    const systems = new Set(sources.map((s) => s.table.split(".")[0])).size;
    return { columns: sources.length, systems, unmapped, worst };
  }, [sources]);

  /* ---- group by schema ---- */
  const groups = useMemo<SchemaGroup[]>(() => {
    const map = new Map<string, SchemaGroup>();
    for (const s of sources) {
      const k = s.table.split(".")[0];
      const g =
        map.get(k) ??
        ({ schema: k, columns: [], totalCols: 0, unmapped: 0, lastScanned: null } as SchemaGroup);
      g.columns.push(s);
      g.totalCols++;
      g.unmapped += s.unmapped;
      if (s.scannedAt && (!g.lastScanned || new Date(s.scannedAt) > new Date(g.lastScanned)))
        g.lastScanned = s.scannedAt;
      map.set(k, g);
    }
    const list = [...map.values()];
    list.sort((a, b) => a.schema.localeCompare(b.schema));
    return list;
  }, [sources]);

  /* ---- initial open-schemas: auto-expand small workspaces, fold large ones ---- */
  useEffect(() => {
    if (openInit) return;
    if (sources.length === 0) {
      setOpenInit(true);
      return;
    }
    const allSchemas = new Set(sources.map((s) => s.table.split(".")[0]));
    if (allSchemas.size <= AUTO_EXPAND_MAX_SCHEMAS) {
      setOpenSchemas(allSchemas);
    } else if (agg.worst) {
      setOpenSchemas(new Set([agg.worst.table.split(".")[0]]));
    }
    setOpenInit(true);
  }, [sources, agg.worst, openInit]);

  const toggleSchema = (k: string) => {
    setOpenSchemas((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const lede =
    agg.columns === 0
      ? "No sources connected yet."
      : `${agg.columns.toLocaleString()} column${agg.columns === 1 ? "" : "s"} connected across ${agg.systems} system${agg.systems === 1 ? "" : "s"}`;

  if (loading) return <SourcesLoader />;

  return (
    <div className="flex flex-col px-2 pb-3 md:px-5 md:pb-5">
      {catalog && (
        <CatalogExplorer
          dims={dims}
          database={catalogDb}
          onDatabaseChange={setCatalogDb}
          onClose={() => setCatalog(false)}
        />
      )}

      {/* ─────────── HEADER (above the surface, on the canvas) ───────────
          Sticky so it stays put while the page scrolls at the window edge.
          Carries the .zz-canvas background (fixed-attachment, so its grid
          lines up with the canvas) to occlude the surface sliding under it. */}
      <div className="sticky top-0 z-10 zz-canvas pb-3 pt-3 md:pt-4">
        <PageHeader
          kicker="Warehouse"
          title="Sources"
          lede={lede}
          action={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                icon={
                  scanAction.isPending ? (
                    <span
                      aria-hidden
                      className="block h-3.5 w-3.5 animate-spin rounded-pill border-2 border-line-2 border-t-accent"
                    />
                  ) : (
                    <IconWand className="h-3.5 w-3.5" />
                  )
                }
                onClick={() => void scanAction.run()}
                disabled={scanAction.isPending || !canEdit}
              >
                {scanAction.isPending ? "Scanning…" : "Scan all"}
              </Button>
              <Button
                size="sm"
                icon={<IconArrowRight className="h-3.5 w-3.5" />}
                onClick={() => setCatalog(true)}
                disabled={!canEdit}
              >
                Add source
              </Button>
            </div>
          }
        />
      </div>

      {/* ─────────── CONNECTION SURFACE (paper) ─────────── */}
      <section
        className="zz-rise relative flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
        style={{ animationDelay: "60ms" }}
      >
        {/* a thin accent edge at the very top — the 'folder tab' that signals
            this is the working surface and quietly carries the brand */}
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent"
          aria-hidden="true"
        />

        <div className="flex flex-col">
          {groups.length === 0 ? (
            <div className="p-3">
              <SetupCard
                title="No sources connected yet"
                glyph={
                  <span className="text-2xl" aria-hidden>
                    🔌
                  </span>
                }
                body="Pick a warehouse column from the catalog — Zug Zug will scan it for values."
                action={<Button onClick={() => setCatalog(true)}>Browse catalog</Button>}
                secondary={<BrowseWarehouse settingsBase={nav.settings} />}
              />
            </div>
          ) : (
            <>
              {/* ─── REVIEW POINTER (above the fold when unmapped values exist) ─── */}
              {agg.unmapped > 0 && agg.worst && (
                <div className="flex items-center gap-2 border-b border-line bg-accent/5 px-6 py-3 text-[12.5px] text-ink-2">
                  <span className="zz-live h-1.5 w-1.5 shrink-0 rounded-pill bg-accent" />
                  {agg.unmapped.toLocaleString()} values await a decision —{" "}
                  <Link
                    to={nav.table(agg.worst.dimId, "match")}
                    className="font-semibold text-accent hover:underline"
                  >
                    Review
                  </Link>
                </div>
              )}

              {groups.map((g) => (
                <SchemaSection
                  key={g.schema}
                  group={g}
                  open={openSchemas.has(g.schema)}
                  onToggle={() => toggleSchema(g.schema)}
                  canEdit={canEdit}
                  busy={deriveAction.isPending}
                  mapHref={(r) => nav.table(r.dimId, "match")}
                  onDerive={(r) => void deriveAction.run(r)}
                  onRemove={(r) => void removeAction.run(r)}
                />
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/* ===================================================================== */
/*                         Sub-components                                  */
/* ===================================================================== */

function BrowseWarehouse({ settingsBase }: { settingsBase: string }) {
  const navigate = useNavigate();
  return (
    <Button variant="secondary" onClick={() => navigate(`${settingsBase}/warehouse`)}>
      Warehouse settings
    </Button>
  );
}

function SchemaSection({
  group,
  open,
  onToggle,
  canEdit,
  busy,
  mapHref,
  onDerive,
  onRemove,
}: {
  group: SchemaGroup;
  open: boolean;
  onToggle: () => void;
  canEdit?: boolean;
  busy?: boolean;
  mapHref: (r: SourceInfo) => string;
  onDerive: (r: SourceInfo) => void;
  onRemove: (r: SourceInfo) => void;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      {/* system header */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 bg-surface-2/60 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 md:gap-4 md:px-7"
      >
        <IconChevron
          className={cx("h-3 w-3 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
        />
        <div className="flex min-w-0 items-baseline gap-2 md:gap-3">
          <span className="truncate font-display text-[15px] font-semibold capitalize text-ink">
            {group.schema}
          </span>
          <span className="font-mono text-[10.5px] text-ink-3 tabular-nums">
            {group.totalCols} column{group.totalCols === 1 ? "" : "s"}
            {group.lastScanned ? ` · scanned ${ago(group.lastScanned)} ago` : ""}
          </span>
        </div>
        {group.unmapped > 0 && (
          <span className="font-display text-[13px] font-semibold tabular-nums text-accent">
            {group.unmapped.toLocaleString()}
          </span>
        )}
      </button>

      {/* columns under the system */}
      {open && (
        <div>
          {group.columns.map((r) => (
            <SourceRow
              key={`${r.dimId}::${r.table}::${r.column}`}
              row={r}
              mapValuesHref={mapHref(r)}
              canEdit={canEdit}
              busy={busy}
              onDerive={() => onDerive(r)}
              onRemove={() => onRemove(r)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
