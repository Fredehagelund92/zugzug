import { useMemo, useState } from "react";
import { IconSearch } from "../Icons";
import { CatalogTree } from "./CatalogTree";
import { TableDetail } from "./TableDetail";
import { NodeOverview } from "./NodeOverview";
import { useCatalogTree } from "./useCatalogTree";
import { filterTree, nodeById } from "./catalog-tree";
import { useDimensions } from "../../store";

export function CatalogBrowser(): JSX.Element {
  const { roots, open, loadingIds, toggle } = useCatalogTree();
  const dims = useDimensions();
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const view = useMemo(() => filterTree(roots, filter), [roots, filter]);
  const shownRoots = filter ? view.roots : roots;
  const shownOpen = filter ? new Set([...open, ...view.openIds]) : open;

  const selected = selectedId ? nodeById(roots, selectedId) : null;
  const dbId = selectedId?.split("/")[1] ?? null;

  const connectionLabel = `${roots[0]?.glyph ?? ""} ${roots[0]?.name ?? ""}`;

  return (
    <div className="grid h-full min-h-0 grid-cols-[326px_1fr]">
      <aside className="flex min-h-0 flex-col border-r border-line bg-surface">
        <div className="border-b border-line px-3 pb-2.5 pt-3">
          <label className="flex h-8.5 items-center gap-2 rounded-sm border border-line-2 bg-surface-2 px-2.5 focus-within:border-accent">
            <IconSearch className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Filter schemas, tables, columns…"
              className="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <div className="mt-1.5 font-mono text-[10.5px] tracking-wide text-ink-3">
            {filter
              ? `${view.matchCount} match${view.matchCount === 1 ? "" : "es"}`
              : "Type to jump · browse to explore"}
          </div>
        </div>
        <CatalogTree
          roots={shownRoots}
          open={shownOpen}
          loadingIds={loadingIds}
          selectedId={selectedId}
          onToggle={toggle}
          onSelect={setSelectedId}
        />
      </aside>

      <main className="min-h-0 overflow-auto bg-bg">
        {selected?.kind === "table" && dbId ? (
          <TableDetail
            database={dbId}
            tablePath={selected.id.split("/").slice(3).join("/")}
            connectionLabel={connectionLabel}
            dims={dims}
          />
        ) : selected ? (
          <NodeOverview node={selected} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center text-ink-3">
            <div className="font-display text-[17px] text-ink-2">
              Pick a table to see its columns
            </div>
            <div>Or filter on the left to jump straight to a column across every connection.</div>
          </div>
        )}
      </main>
    </div>
  );
}
