import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export interface SearchResultRow {
  dbId: string;
  dbName: string;
  schema: string;
  table: string;
  columns: string[];
}

export function CatalogSearchResults(props: {
  results: SearchResultRow[] | null;
  searching: boolean;
  query: string;
  multiDb: boolean;
  selectedKey: string | null;
  onSelect: (row: SearchResultRow) => void;
  truncated?: boolean;
  /** Number of per-database searches that failed (#161). */
  failedCount?: number;
}): JSX.Element {
  const { results, searching, query, multiDb, selectedKey, onSelect, truncated, failedCount } =
    props;

  if (searching && !results) {
    return <div className="px-3 py-2 font-mono text-[10.5px] text-ink-3">searching…</div>;
  }

  const searchFailedBanner =
    failedCount && failedCount > 0 ? (
      <div
        role="alert"
        className="border-b border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[10.5px] text-danger"
      >
        {failedCount} source{failedCount === 1 ? "" : "s"} couldn’t be searched — results may be
        incomplete.
      </div>
    ) : null;

  if (results && results.length === 0) {
    return (
      <div>
        {searchFailedBanner}
        <div className="px-3 py-2 text-[12.5px] text-ink-3">No tables or columns match.</div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const rows = results ?? [];

  const matchedColumn = (row: SearchResultRow): string | null => {
    if (row.table.toLowerCase().includes(q)) return null;
    return row.columns.find((c) => c.toLowerCase().includes(q)) ?? null;
  };

  const renderRow = (row: SearchResultRow) => {
    const col = matchedColumn(row);
    const hasSubline = multiDb || col !== null;
    return (
      <>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[12.5px]" title={row.table}>
            {row.table}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-ink-3">
            {row.columns.length} cols
          </span>
        </div>
        {hasSubline && (
          <div className="font-mono text-[10.5px] text-ink-3">
            {multiDb && <span>{row.dbName}</span>}
            {multiDb && col !== null && <span> · </span>}
            {col !== null && <span>matched: {col}</span>}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchFailedBanner}
      <VirtualizedResults rows={rows} {...{ selectedKey, onSelect, truncated, renderRow }} />
    </div>
  );
}

/* A multi-DB warehouse search can yield ~1000 result buttons (backend caps each
 * DB at 100). Virtualize with dynamic measurement (rows vary by an optional
 * subline). jsdom has no layout → the virtualizer returns 0 items, so fall back
 * to rendering every row for RTL tests. The refine affordance keeps truncation
 * from being silent (#159). */
function VirtualizedResults({
  rows,
  selectedKey,
  onSelect,
  truncated,
  renderRow,
}: {
  rows: SearchResultRow[];
  selectedKey: string | null;
  onSelect: (row: SearchResultRow) => void;
  truncated?: boolean;
  renderRow: (row: SearchResultRow) => JSX.Element;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });
  const vItems = virtual.getVirtualItems();
  const useVirtual = vItems.length > 0;

  const rowClass = (key: string) =>
    [
      "w-full px-3 py-1.5 text-left",
      selectedKey === key ? "bg-accent/15 text-ink" : "text-ink hover:bg-surface-2",
    ].join(" ");

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="relative w-full"
        style={useVirtual ? { height: virtual.getTotalSize() } : undefined}
      >
        {(useVirtual ? vItems : rows.map((_, i) => ({ index: i, start: 0, key: i }))).map((vi) => {
          const row = rows[vi.index]!;
          const key = `${row.dbId}/${row.table}`;
          return (
            <button
              key={key}
              type="button"
              data-index={vi.index}
              ref={useVirtual ? virtual.measureElement : undefined}
              className={useVirtual ? `absolute left-0 top-0 ${rowClass(key)}` : rowClass(key)}
              style={useVirtual ? { transform: `translateY(${vi.start}px)` } : undefined}
              onClick={() => onSelect(row)}
            >
              {renderRow(row)}
            </button>
          );
        })}
      </div>
      {truncated && rows.length > 0 && (
        <div className="px-3 py-2 font-mono text-[10.5px] text-ink-3">
          Showing the first matches — refine your search to narrow.
        </div>
      )}
    </div>
  );
}
