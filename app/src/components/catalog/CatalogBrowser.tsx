import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconSearch } from "../Icons";
import { CatalogTree } from "./CatalogTree";
import { TableDetail } from "./TableDetail";
import { NodeOverview } from "./NodeOverview";
import { useCatalogTree } from "./useCatalogTree";
import { nodeById } from "./catalog-tree";
import { searchCatalog, useRefTables } from "../../store";
import { CatalogSearchResults, type SearchResultRow } from "./CatalogSearchResults";
import { useNavLinks } from "../../lib/use-tenant-navigate";

const TREE_WIDTH_KEY = "zz.catalog.tree-width";
const TREE_WIDTH_MIN = 240;
const TREE_WIDTH_MAX = 640;
const TREE_WIDTH_DEFAULT = 326;
const TREE_WIDTH_STEP = 16;

export function CatalogBrowser(): JSX.Element {
  const { roots, open, loadingIds, toggle } = useCatalogTree();
  const refTables = useRefTables();
  const nav = useNavLinks();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResultRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  // Number of per-database searches that failed — surfaced so a partial result
  // set isn't mistaken for "nothing else matches" (#161).
  const [failedDbs, setFailedDbs] = useState(0);
  const [searchSelected, setSearchSelected] = useState<{
    dbId: string;
    tablePath: string;
    name: string;
  } | null>(null);
  const seq = useRef(0);
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    const stored = localStorage.getItem(TREE_WIDTH_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) {
        return Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, parsed));
      }
    }
    return TREE_WIDTH_DEFAULT;
  });
  const treeWidthRef = useRef(treeWidth);
  useEffect(() => {
    treeWidthRef.current = treeWidth;
  }, [treeWidth]);

  // Debounced server search
  useEffect(() => {
    if (query.trim() === "") {
      seq.current++;
      setResults(null);
      setTruncated(false);
      setSearching(false);
      setFailedDbs(0);
      setSearchSelected(null);
      return;
    }
    setSearching(true);
    const ticket = ++seq.current;
    const t = setTimeout(() => {
      const dbs = roots[0]?.children ?? [];
      Promise.allSettled(
        dbs.map(async (d) => {
          const dbId = d.id.split("/")[1]!;
          const r = await searchCatalog({ database: dbId, q: query, limit: 100 });
          return {
            rows: r.rows.map((row) => ({
              dbId,
              dbName: d.name,
              schema: row.schema,
              table: row.table,
              columns: row.columns,
            })),
            truncated: r.total > r.rows.length,
          };
        }),
      )
        .then((settled) => {
          if (ticket !== seq.current) return;
          const rows: SearchResultRow[] = [];
          let anyTruncated = false;
          let failed = 0;
          for (const s of settled) {
            if (s.status === "fulfilled") {
              rows.push(...s.value.rows);
              if (s.value.truncated) anyTruncated = true;
            } else {
              failed++;
            }
          }
          setResults(rows);
          setTruncated(anyTruncated);
          setFailedDbs(failed);
          setSearching(false);
        })
        .catch(() => {
          if (ticket !== seq.current) return;
          // The whole search pass failed — surface it rather than showing an
          // empty, "nothing matches" result (#161).
          setResults([]);
          setFailedDbs(Math.max(1, roots[0]?.children?.length ?? 1));
          setSearching(false);
        });
    }, 220);
    return () => clearTimeout(t);
  }, [query, roots]);

  const selected = selectedId ? nodeById(roots, selectedId) : null;
  const dbId = selectedId?.split("/")[1] ?? null;

  const connectionLabel = `${roots[0]?.glyph ?? ""} ${roots[0]?.name ?? ""}`;
  const multiDb = (roots[0]?.children?.length ?? 0) > 1;

  const selectedKey = searchSelected ? `${searchSelected.dbId}/${searchSelected.tablePath}` : null;

  function handleSearchSelect(row: SearchResultRow) {
    setSearchSelected({
      dbId: row.dbId,
      tablePath: row.table,
      name: row.table,
    });
  }

  function handleDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidthRef.current;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(
        TREE_WIDTH_MIN,
        Math.min(TREE_WIDTH_MAX, startW + (ev.clientX - startX)),
      );
      setTreeWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem(TREE_WIDTH_KEY, String(treeWidthRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleDividerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? TREE_WIDTH_STEP : -TREE_WIDTH_STEP;
      const next = Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, treeWidthRef.current + delta));
      setTreeWidth(next);
      localStorage.setItem(TREE_WIDTH_KEY, String(next));
    }
  }

  const isSearching = query.trim() !== "";

  return (
    <div className="grid h-full min-h-0" style={{ gridTemplateColumns: `${treeWidth}px auto 1fr` }}>
      <aside className="flex min-h-0 flex-col bg-surface">
        <div className="border-b border-line px-3 pb-2.5 pt-3">
          <label className="flex h-8.5 items-center gap-2 rounded-sm border border-line-2 bg-surface-2 px-2.5 focus-within:border-accent">
            <IconSearch className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search tables, columns…"
              className="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <div className="mt-1.5 font-mono text-[10.5px] tracking-wide text-ink-3">
            {searching
              ? "searching…"
              : isSearching
                ? `${results?.length ?? 0} result${results?.length === 1 ? "" : "s"}`
                : "Type to search · browse to explore"}
          </div>
        </div>
        {isSearching ? (
          <CatalogSearchResults
            results={results}
            searching={searching}
            query={query}
            multiDb={multiDb}
            selectedKey={selectedKey}
            onSelect={handleSearchSelect}
            truncated={truncated}
            failedCount={failedDbs}
          />
        ) : (
          <CatalogTree
            roots={roots}
            open={open}
            loadingIds={loadingIds}
            selectedId={selectedId}
            onToggle={toggle}
            onSelect={setSelectedId}
          />
        )}
      </aside>

      {/* Draggable divider */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={treeWidth}
        aria-valuemin={TREE_WIDTH_MIN}
        aria-valuemax={TREE_WIDTH_MAX}
        aria-label="Resize tree pane"
        tabIndex={0}
        className="w-1 cursor-col-resize self-stretch bg-line hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        onPointerDown={handleDividerPointerDown}
        onKeyDown={handleDividerKeyDown}
      />

      <main className="min-h-0 overflow-auto bg-bg">
        {isSearching && searchSelected ? (
          <TableDetail
            database={searchSelected.dbId}
            tablePath={searchSelected.tablePath}
            connectionLabel={connectionLabel}
            refTables={refTables}
          />
        ) : selected?.kind === "table" && dbId ? (
          <TableDetail
            database={dbId}
            tablePath={selected.id.split("/").slice(3).join("/")}
            connectionLabel={connectionLabel}
            refTables={refTables}
          />
        ) : selected ? (
          <NodeOverview node={selected} />
        ) : roots[0] && roots[0].children.length === 0 && !isSearching ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center text-ink-3">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
              No warehouse databases
            </div>
            <div>
              No warehouse databases have been registered yet. An admin can add one in Settings →
              Warehouse.
            </div>
            <Link to={`${nav.settings}/warehouse`} className="text-[12px] text-accent">
              Go to warehouse settings
            </Link>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center text-ink-3">
            <div className="font-display text-[17px] text-ink-2">
              Pick a table to see its columns
            </div>
            <div>Or search on the left to jump straight to a table across every connection.</div>
          </div>
        )}
      </main>
    </div>
  );
}
