import { CatalogBrowser } from "../components/catalog/CatalogBrowser";

export function Catalog() {
  return (
    <div className="grid h-[calc(100vh-56px)] grid-rows-[auto_1fr]">
      <header className="flex items-center gap-4 border-b border-line px-5 py-3.5">
        <div className="flex flex-col leading-none">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-3">
            Data · Warehouse
          </span>
          <h1 className="mt-1.5 font-display text-[19px] font-semibold tracking-tight text-ink">
            Catalog
          </h1>
        </div>
      </header>

      <CatalogBrowser />
    </div>
  );
}
