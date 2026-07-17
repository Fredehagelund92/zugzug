import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "./Button";
import { ComboSelect } from "./ComboSelect";
import { IconSearch, IconX, IconChevron, IconArrowRight } from "./Icons";
import { cx } from "../lib/cx";
import { searchCatalog, deriveCanonical, useCanEdit, type CatalogTable } from "../store";
import { fetchWarehouseDatabases } from "../api";
import type { MappingDimension } from "../data";

/* CatalogExplorer — a right slide-over drawer to browse/search the warehouse
   catalog (the 1000+ tables) and wire a column to a dimension. Server-side
   search + paginated "load more", so it scales regardless of catalog size;
   results live in local state (never the global cache). The explorer is scoped
   to a single registered warehouse database; if a caller passes `database={null}`
   we render a picker so the user can select one before browsing. */

const PAGE = 50;

interface DatabaseOption {
  id: string;
  databaseName: string;
  label: string | null;
  lastProbeError: string | null;
  sourceCount?: number;
  schemaCount?: number | null;
}

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

export function CatalogExplorer({
  dims,
  database,
  onDatabaseChange,
  onClose,
}: {
  dims: MappingDimension[];
  database: string | null;
  onDatabaseChange?: (id: string | null) => void;
  onClose: () => void;
}) {
  const canEdit = useCanEdit();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CatalogTable[]>([]);
  const [total, setTotal] = useState(0);
  const [wiredThisSession, setWiredThisSession] = useState(0);
  const [loading, setLoading] = useState(false);
  // True once the first search for the current database has settled. Guards the
  // empty state so "no tables" never flashes before results arrive.
  const [searched, setSearched] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseOption[]>([]);
  const [internalDb, setInternalDb] = useState<string | null>(database);
  type WireState = {
    dim: string;
    n: number | null;
    mode?: "seed" | "connect";
    matched?: number;
    unmatched?: number;
    error?: string;
  };
  const [wired, setWired] = useState<Record<string, WireState>>({}); // "table.col" → result
  const seq = useRef(0);

  const setDatabase = (id: string | null): void => {
    setInternalDb(id);
    onDatabaseChange?.(id);
  };

  // keep state in sync if the parent flips the database prop while the explorer
  // is mounted (rare — the parent typically remounts the explorer to switch dbs)
  useEffect(() => {
    setInternalDb(database);
  }, [database]);

  // load registered databases once so the picker (and lone-db autoselect) work
  useEffect(() => {
    let cancelled = false;
    fetchWarehouseDatabases()
      .then((dbs) => {
        if (cancelled) return;
        setDatabases(dbs);
        if (internalDb === null && dbs.length === 1) setDatabase(dbs[0]!.id);
      })
      .catch(() => {
        /* picker stays empty; explorer shows the "pick a database" state */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (append: boolean) => {
    if (!internalDb) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    const ticket = ++seq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await searchCatalog({
        database: internalDb,
        q,
        limit: PAGE,
        offset: append ? rows.length : 0,
      });
      if (ticket !== seq.current) return; // a newer search superseded this one
      setTotal(r.total);
      setRows((prev) => (append ? [...prev, ...r.rows] : r.rows));
    } catch (err) {
      if (ticket !== seq.current) return;
      setLoadError(err instanceof Error ? err.message : "Catalog search failed.");
      if (!append) {
        setRows([]);
        setTotal(0);
      }
    } finally {
      if (ticket === seq.current) {
        setLoading(false);
        setSearched(true);
      }
    }
  };

  // Reset the settled flag when the database changes so a switch shows the
  // loading state, not the previous database's empty/result copy.
  useEffect(() => {
    setSearched(false);
  }, [internalDb]);

  // (re)search from the top on database / query change, debounced
  useEffect(() => {
    const t = setTimeout(() => load(false), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalDb, q]);

  const wire = async (table: string, column: string, dimLabel: string) => {
    const dim = dims.find((d) => d.dimension === dimLabel);
    if (!dim) return;
    const key = `${table}.${column}`;
    setWired((w) => ({ ...w, [key]: { dim: dimLabel, n: null } })); // pending
    try {
      const { derived, mode, matched, unmatched } = await deriveCanonical(dim.id, table, column);
      setWired((w) => ({ ...w, [key]: { dim: dimLabel, n: derived, mode, matched, unmatched } }));
      setWiredThisSession((n) => n + 1);
    } catch (err) {
      setWired((w) => ({
        ...w,
        [key]: {
          dim: dimLabel,
          n: null,
          error: err instanceof Error ? err.message : "wire failed",
        },
      }));
    }
  };

  const clearWireError = (key: string) => {
    setWired((w) => {
      const next = { ...w };
      delete next[key];
      return next;
    });
  };

  const dimOptions = dims.map((d) => d.dimension);
  const activeDb = databases.find((d) => d.id === internalDb) ?? null;
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="zz-overlay fixed inset-0 z-50 bg-ink/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Wire a source"
        className="zz-drawer fixed right-0 top-0 flex h-full w-[620px] max-w-full flex-col overflow-hidden border-l border-line-2 bg-surface-elevated shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header + database picker + search */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 md:px-5 md:py-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
              Warehouse catalog
            </div>
            <h2 className="font-display text-lg font-extrabold tracking-tight text-ink">
              Wire a source
            </h2>
          </div>
          {activeDb && databases.length > 1 ? (
            <div className="relative md:ml-auto">
              <button
                type="button"
                onClick={() => setSwitcherOpen((v) => !v)}
                className="group flex items-center gap-2 rounded-sm border border-line-2 bg-surface px-2.5 py-1.5 text-left transition-colors hover:border-ink-3"
              >
                <span className="grid h-5 w-5 place-items-center rounded-[2px] bg-accent/15 font-mono text-[10px] font-bold text-accent">
                  {activeDb.databaseName.slice(0, 1).toUpperCase()}
                </span>
                <span className="flex flex-col leading-tight">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                    Database
                  </span>
                  <span className="font-mono text-[11.5px] text-ink">{activeDb.databaseName}</span>
                </span>
                <IconChevron
                  className={cx(
                    "h-3 w-3 text-ink-3 transition-transform",
                    switcherOpen && "rotate-180",
                  )}
                />
              </button>
              {switcherOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSwitcherOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 min-w-[220px] overflow-hidden rounded-sm border border-line-2 bg-surface-elevated shadow-pop">
                    {databases.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => {
                          setDatabase(d.id);
                          setSwitcherOpen(false);
                        }}
                        className={cx(
                          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover",
                          d.id === internalDb && "bg-hover",
                        )}
                      >
                        <span className="grid h-5 w-5 place-items-center rounded-[2px] bg-accent/15 font-mono text-[10px] font-bold text-accent">
                          {d.databaseName.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate font-mono text-[11.5px] text-ink">
                            {d.databaseName}
                          </span>
                          {d.label && (
                            <span className="truncate font-mono text-[10px] text-ink-3">
                              {d.label}
                            </span>
                          )}
                        </span>
                        {d.lastProbeError && (
                          <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-danger">
                            offline
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
          {internalDb && (
            <label className="flex min-w-0 flex-1 basis-full items-center gap-2 rounded-sm border border-line-2 bg-surface px-3 py-1.5 text-ink-3 focus-within:border-accent">
              <IconSearch className="h-4 w-4 shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tables, columns…"
                className="w-full bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3"
              />
            </label>
          )}
          {!internalDb && <div className="md:ml-auto" />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-11 w-11 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink md:h-8 md:w-8"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>

        {!internalDb ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8 md:px-10 md:py-10">
            <div className="mx-auto max-w-2xl">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Step 1 of 2
              </div>
              <h3 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-ink">
                Choose a database to browse
              </h3>
              <p className="mt-1.5 max-w-md font-mono text-[12px] leading-relaxed text-ink-3">
                Each registered warehouse database holds its own catalog of tables. Pick one to
                start wiring columns into dimensions.
              </p>

              {databases.length === 0 ? (
                <div className="mt-7 rounded-sm border border-dashed border-line-2 bg-surface/40 px-6 py-10 text-center">
                  <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-3">
                    Nothing registered yet
                  </div>
                  <p className="mx-auto mt-2 max-w-sm font-mono text-[12px] text-ink-2">
                    No warehouse databases have been registered yet. An admin can add one from
                    settings.
                  </p>
                  <Link
                    to="../settings/warehouse"
                    onClick={onClose}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-sm border border-line-2 bg-surface px-3 py-1.5 font-mono text-[11px] text-ink transition-colors hover:border-accent hover:text-accent"
                  >
                    Open warehouse settings
                    <IconArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              ) : (
                <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
                  {databases.map((d) => {
                    const unreachable = !!d.lastProbeError;
                    return (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => setDatabase(d.id)}
                          disabled={unreachable}
                          className={cx(
                            "group relative flex w-full items-start gap-3 rounded-sm border border-line-2 bg-surface px-4 py-3.5 text-left transition-all",
                            unreachable
                              ? "cursor-not-allowed opacity-60"
                              : "hover:-translate-y-px hover:border-accent hover:bg-surface-elevated hover:shadow-pop",
                          )}
                        >
                          <span
                            className={cx(
                              "grid h-9 w-9 shrink-0 place-items-center rounded-sm font-mono text-sm font-extrabold",
                              unreachable
                                ? "bg-line text-ink-3"
                                : "bg-accent/15 text-accent group-hover:bg-accent group-hover:text-accent-contrast",
                            )}
                          >
                            {d.databaseName.slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-mono text-[13px] font-semibold text-ink">
                                {d.databaseName}
                              </span>
                              {unreachable && (
                                <span className="shrink-0 rounded-[2px] bg-danger-soft px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-danger">
                                  unreachable
                                </span>
                              )}
                            </div>
                            {d.label && (
                              <div className="truncate font-mono text-[11px] text-ink-3">
                                {d.label}
                              </div>
                            )}
                            <div className="mt-1.5 flex items-center gap-3 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
                              {typeof d.schemaCount === "number" && (
                                <span>
                                  {d.schemaCount} schema{d.schemaCount === 1 ? "" : "s"}
                                </span>
                              )}
                              {typeof d.sourceCount === "number" && (
                                <span>{d.sourceCount} wired</span>
                              )}
                            </div>
                          </div>
                          {!unreachable && (
                            <IconArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-3 transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* results */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loadError && (
                <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-5 py-2.5 font-mono text-[11.5px] text-danger">
                  <span>Catalog search failed — {loadError}</span>
                  <Button variant="ghost" size="sm" onClick={() => load(false)}>
                    Retry
                  </Button>
                </div>
              )}
              {rows.map((t) => {
                const isOpen = open === t.table;
                return (
                  <div key={t.table} className="border-b border-line">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : t.table)}
                      className="flex w-full items-center gap-2 px-5 py-2.5 text-left transition-colors hover:bg-hover"
                    >
                      <IconChevron
                        className={cx(
                          "h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform",
                          isOpen && "rotate-180",
                        )}
                      />
                      <span className="truncate font-mono text-[12.5px] text-ink">{t.table}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">
                        {t.columns.length} cols
                      </span>
                    </button>
                    {isOpen && (
                      <div className="space-y-1 bg-surface-2/40 px-5 py-2 pl-10">
                        {t.columns.map((c) => {
                          const key = `${t.table}.${c}`;
                          return (
                            <div
                              key={c}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-0.5 md:grid md:grid-cols-[1fr_180px] md:gap-3"
                            >
                              <span className="truncate font-mono text-[11.5px] text-ink-2">
                                {c}
                              </span>
                              {wired[key]?.error ? (
                                <span
                                  className="flex items-center justify-end gap-2 font-mono text-[10.5px] text-danger"
                                  title={wired[key].error}
                                >
                                  <span className="truncate">connect failed</span>
                                  <button
                                    type="button"
                                    onClick={() => wire(t.table, c, wired[key].dim)}
                                    className="rounded-sm border border-danger/40 px-1.5 py-0.5 text-danger transition-colors hover:bg-danger-soft"
                                  >
                                    Retry
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => clearWireError(key)}
                                    aria-label="Dismiss connect error"
                                    className="text-ink-3 transition-colors hover:text-ink"
                                  >
                                    <IconX className="h-3 w-3" />
                                  </button>
                                </span>
                              ) : wired[key] ? (
                                <span className="flex items-center justify-end gap-1.5 font-mono text-[10.5px] text-ok">
                                  <IconArrowRight className="h-3 w-3" />
                                  {wired[key].n === null
                                    ? `connecting ${wired[key].dim}…`
                                    : `Connected ${c} to ${wired[key].dim} · ${outcomeText({ mode: wired[key].mode as "seed" | "connect", derived: wired[key].n ?? undefined, matched: wired[key].matched, unmatched: wired[key].unmatched })}`}
                                </span>
                              ) : (
                                <ComboSelect
                                  options={dimOptions}
                                  value={null}
                                  placeholder="connect to table…"
                                  onPick={canEdit ? (d) => wire(t.table, c, d) : undefined}
                                  disabled={!canEdit}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {(!searched || loading) && rows.length === 0 && (
                <div className="px-5 py-16 text-center font-mono text-[12px] text-ink-3">
                  Loading catalog…
                </div>
              )}

              {searched && !loading && rows.length === 0 && (
                <div className="px-5 py-16 text-center font-mono text-[12px] text-ink-3">
                  {q
                    ? "no tables match"
                    : "warehouse not attached — set ATTACH_WAREHOUSE=true"}
                </div>
              )}

              <div className="flex items-center justify-between px-5 py-3">
                <span className="font-mono text-[11px] text-ink-3">
                  {loading ? "searching…" : `${rows.length} of ${total} tables`}
                  {wiredThisSession > 0 && (
                    <span className="text-ok"> · {wiredThisSession} wired just now</span>
                  )}
                </span>
                {rows.length < total && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={loading}
                    onClick={() => load(true)}
                  >
                    Load more
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
