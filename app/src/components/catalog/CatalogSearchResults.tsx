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
}): JSX.Element {
  const { results, searching, query, multiDb, selectedKey, onSelect } = props;

  if (searching && !results) {
    return <div className="px-3 py-2 font-mono text-[10.5px] text-ink-3">searching…</div>;
  }

  if (results && results.length === 0) {
    return <div className="px-3 py-2 text-[12.5px] text-ink-3">No tables or columns match.</div>;
  }

  const q = query.toLowerCase();

  const matchedColumn = (row: SearchResultRow): string | null => {
    if (row.table.toLowerCase().includes(q)) return null;
    return row.columns.find((c) => c.toLowerCase().includes(q)) ?? null;
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {(results ?? []).map((row) => {
        const key = `${row.dbId}/${row.table}`;
        const isSelected = selectedKey === key;
        const col = matchedColumn(row);
        const hasSubline = multiDb || col !== null;

        return (
          <button
            key={key}
            type="button"
            className={[
              "w-full px-3 py-1.5 text-left",
              isSelected ? "bg-accent/15 text-ink" : "text-ink hover:bg-surface-2",
            ].join(" ")}
            onClick={() => onSelect(row)}
          >
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
          </button>
        );
      })}
    </div>
  );
}
