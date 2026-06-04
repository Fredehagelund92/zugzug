import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { ComboSelect } from "./ComboSelect";
import { IconSearch, IconX, IconChevron, IconArrowRight } from "./Icons";
import { cx } from "../lib/cx";
import { searchCatalog, deriveCanonical, type CatalogTable } from "../store";
import type { MappingDimension } from "../data";

/* CatalogExplorer — browse/search the warehouse catalog (the 1000+ tables) and
   wire a column to a dimension. Server-side search + schema facets + paginated
   "load more", so it scales regardless of catalog size; results live in local
   state (never the global cache). */

const PAGE = 50;

export function CatalogExplorer({ dims, onClose }: { dims: MappingDimension[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [schema, setSchema] = useState<string | null>(null);
  const [rows, setRows] = useState<CatalogTable[]>([]);
  const [total, setTotal] = useState(0);
  const [schemas, setSchemas] = useState<{ schema: string; tables: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [wired, setWired] = useState<Record<string, { dim: string; n: number | null }>>({}); // "table.col" → result
  const seq = useRef(0);

  const load = async (append: boolean) => {
    const ticket = ++seq.current;
    setLoading(true);
    const r = await searchCatalog({ q, schema: schema ?? undefined, limit: PAGE, offset: append ? rows.length : 0 });
    if (ticket !== seq.current) return; // a newer search superseded this one
    setTotal(r.total);
    setSchemas(r.schemas);
    setRows((prev) => (append ? [...prev, ...r.rows] : r.rows));
    setLoading(false);
  };

  // (re)search from the top on query / schema change, debounced
  useEffect(() => {
    const t = setTimeout(() => load(false), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, schema]);

  const wire = async (table: string, column: string, dimLabel: string) => {
    const dim = dims.find((d) => d.dimension === dimLabel);
    if (!dim) return;
    const key = `${table}.${column}`;
    setWired((w) => ({ ...w, [key]: { dim: dimLabel, n: null } })); // pending
    const n = await deriveCanonical(dim.id, table, column);          // wire + seed canonical
    setWired((w) => ({ ...w, [key]: { dim: dimLabel, n } }));
  };

  const dimOptions = dims.map((d) => d.dimension);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 p-4 backdrop-blur-sm sm:p-8" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* header + search */}
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Warehouse catalog</div>
            <h2 className="font-display text-lg font-extrabold tracking-tight text-ink">Wire a source</h2>
          </div>
          <label className="ml-auto flex w-full max-w-sm items-center gap-2 rounded-sm border border-line-2 bg-surface px-3 py-1.5 text-ink-3 focus-within:border-accent">
            <IconSearch className="h-4 w-4" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tables, columns…"
              className="w-full bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3" />
          </label>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"><IconX className="h-4 w-4" /></button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr]">
          {/* schema facets */}
          <div className="overflow-y-auto border-r border-line bg-surface/40 py-2">
            <button type="button" onClick={() => setSchema(null)}
              className={cx("flex w-full items-center justify-between px-4 py-1.5 text-left font-mono text-[11px] transition-colors", schema === null ? "text-accent" : "text-ink-3 hover:text-ink-2")}>
              <span>all systems</span><span className="opacity-60">{total}</span>
            </button>
            {schemas.map((s) => (
              <button key={s.schema} type="button" onClick={() => setSchema(s.schema === schema ? null : s.schema)}
                className={cx("flex w-full items-center justify-between gap-2 px-4 py-1.5 text-left font-mono text-[11px] transition-colors", s.schema === schema ? "text-accent" : "text-ink-3 hover:text-ink-2")}>
                <span className="truncate">{s.schema}</span><span className="shrink-0 opacity-60">{s.tables}</span>
              </button>
            ))}
          </div>

          {/* results */}
          <div className="min-h-0 overflow-y-auto">
            {rows.map((t) => {
              const isOpen = open === t.table;
              return (
                <div key={t.table} className="border-b border-line">
                  <button type="button" onClick={() => setOpen(isOpen ? null : t.table)}
                    className="flex w-full items-center gap-2 px-5 py-2.5 text-left transition-colors hover:bg-hover">
                    <IconChevron className={cx("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", isOpen && "rotate-180")} />
                    <span className="truncate font-mono text-[12.5px] text-ink">{t.table}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{t.columns.length} cols</span>
                  </button>
                  {isOpen && (
                    <div className="space-y-1 bg-surface-2/40 px-5 py-2 pl-10">
                      {t.columns.map((c) => {
                        const key = `${t.table}.${c}`;
                        return (
                          <div key={c} className="grid grid-cols-[1fr_180px] items-center gap-3 py-0.5">
                            <span className="truncate font-mono text-[11.5px] text-ink-2">{c}</span>
                            {wired[key] ? (
                              <span className="flex items-center justify-end gap-1.5 font-mono text-[10.5px] text-ok"><IconArrowRight className="h-3 w-3" />{wired[key].n === null ? `seeding ${wired[key].dim}…` : `${wired[key].dim} · seeded ${wired[key].n}`}</span>
                            ) : (
                              <ComboSelect options={dimOptions} value={null} placeholder="add to table…" onPick={(d) => wire(t.table, c, d)} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {!loading && rows.length === 0 && (
              <div className="px-5 py-16 text-center font-mono text-[12px] text-ink-3">{q || schema ? "no tables match" : "warehouse not attached — set ATTACH_WAREHOUSE=true"}</div>
            )}

            <div className="flex items-center justify-between px-5 py-3">
              <span className="font-mono text-[11px] text-ink-3">{loading ? "searching…" : `${rows.length} of ${total} tables`}</span>
              {rows.length < total && (
                <Button variant="secondary" size="sm" disabled={loading} onClick={() => load(true)}>Load more</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
