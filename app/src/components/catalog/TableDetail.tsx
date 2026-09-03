import { useEffect, useState } from "react";
import { ComboSelect } from "../ComboSelect";
import { IconCheck, IconX } from "../Icons";
import { cx } from "../../lib/cx";
import { focusRing } from "../../lib/focus-ring";
import {
  deriveRecord,
  fetchColumnValues,
  fetchColumns,
  removeSource,
  useCanEdit,
  type CatalogColumn,
} from "../../store";
import type { MappingRefTable } from "../../data";

type WireState = {
  refTable: string;
  refTableId: string;
  n: number | null;
  mode?: "seed" | "connect";
  matched?: number;
  unmatched?: number;
  error?: string;
};

export function TableDetail({
  database,
  tablePath,
  connectionLabel,
  refTables,
}: {
  database: string;
  tablePath: string;
  connectionLabel: string;
  refTables: MappingRefTable[];
}) {
  const canEdit = useCanEdit();
  const [cols, setCols] = useState<CatalogColumn[] | null>(null);
  const [colsError, setColsError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [wired, setWired] = useState<Record<string, WireState>>({});
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCols(null);
    setColsError(null);
    setValues({});
    setWired({});
    fetchColumns(database, tablePath)
      .then((c) => {
        if (!cancelled) setCols(c);
      })
      .catch((err: unknown) => {
        // An unreachable table is not an empty one — say which happened.
        if (cancelled) return;
        setColsError(err instanceof Error ? err.message : "Couldn't read this table.");
        setCols([]);
      });
    return () => {
      cancelled = true;
    };
  }, [database, tablePath, reload]);

  const peek = async (col: string) => {
    if (values[col]) return;
    const v = await fetchColumnValues(database, tablePath, col, 5).catch(() => []);
    setValues((s) => ({ ...s, [col]: v }));
  };

  const wire = async (column: string, refTableLabel: string) => {
    const refTable = refTables.find((d) => d.refTable === refTableLabel);
    if (!refTable) return;
    setWired((w) => ({
      ...w,
      [column]: { refTable: refTableLabel, refTableId: refTable.id, n: null },
    }));
    try {
      // `database` is the warehouse_database the tree browsed — send it, or the
      // server registers the column against the first database it finds.
      const { derived, mode, matched, unmatched } = await deriveRecord(
        refTable.id,
        tablePath,
        column,
        undefined,
        { databaseId: database },
      );
      setWired((w) => ({
        ...w,
        [column]: {
          refTable: refTableLabel,
          refTableId: refTable.id,
          n: derived,
          mode,
          matched,
          unmatched,
        },
      }));
    } catch (err) {
      setWired((w) => ({
        ...w,
        [column]: {
          refTable: refTableLabel,
          refTableId: refTable.id,
          n: null,
          error: err instanceof Error ? err.message : "wire failed",
        },
      }));
    }
  };

  /** The ✕ on a wired chip used to drop local state only, leaving the column
   *  registered and scanned. Unwire it for real, then clear the chip. */
  const unwire = async (column: string, w: WireState) => {
    try {
      await removeSource(w.refTableId, tablePath, column, database);
      setWired((s) => {
        const next = { ...s };
        delete next[column];
        return next;
      });
    } catch (err) {
      setWired((s) => ({
        ...s,
        [column]: { ...w, error: err instanceof Error ? err.message : "remove failed" },
      }));
    }
  };

  const refTableOptions = refTables.map((d) => d.refTable);
  const mappedCount = cols?.filter((c) => wired[c.name] && !wired[c.name].error).length ?? 0;
  const schema = tablePath.split(".")[0];
  const table = tablePath.split(".").slice(1).join(".");

  return (
    <div>
      <div className="sticky top-0 z-[5] border-b border-line bg-surface/90 px-6 pb-3.5 pt-4 backdrop-blur">
        <div className="mb-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-3">
          <span>{schema}</span>
          <span className="opacity-60">›</span>
          <span className="text-ink-2">{table}</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-display text-[22px] font-semibold tracking-tight text-ink">
            {table}
          </h2>
          <span className="rounded-pill border border-line px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-3">
            Table
          </span>
        </div>
        <div className="mt-3 flex items-center gap-3.5 text-[12px] text-ink-2">
          <span>
            <span className="font-semibold text-ink">{cols?.length ?? "…"}</span> columns
          </span>
          <span>
            <span className="font-semibold text-ink">{mappedCount}</span> mapped
          </span>
          <span className="text-ink-2">{connectionLabel}</span>
          <button
            type="button"
            role="switch"
            aria-checked={onlyUnmapped}
            onClick={() => setOnlyUnmapped((v) => !v)}
            // Tabbing here and then clicking leaves the ring on, because clicking
            // an already-focused element fires no new focus event for
            // :focus-visible to re-evaluate. That's correct — the control really
            // does still have keyboard focus — so don't blur it away; blurring
            // drops focus to <body> and the next Space press does nothing. Just
            // use the soft shared ring the other hand-rolled controls use (#196).
            className={cx(
              "ml-auto flex items-center gap-2 rounded-sm text-[12px] text-ink-2",
              focusRing,
            )}
          >
            <span
              className={cx(
                "relative h-[18px] w-8 rounded-pill transition-colors",
                onlyUnmapped ? "bg-accent" : "bg-surface-3",
              )}
            >
              {/* left-0 is load-bearing: without it the knob falls back to its
                  static position, which the button's inherited text-align:center
                  puts at the track's midpoint (16px). That offset every
                  translate-x by half the track — the knob sat on the right edge
                  when off and slid clean off the track when on. Transition the
                  background too, or the knob snaps from dark to white on the
                  first frame while it's still sliding (#196). */}
              <span
                className={cx(
                  "absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full",
                  "transition-[translate,background-color]",
                  onlyUnmapped ? "translate-x-[16px] bg-surface" : "translate-x-0.5 bg-ink-2",
                )}
              />
            </span>
            Only unmapped
          </button>
        </div>
      </div>

      <div className="px-4 pb-16 pt-2">
        {cols?.map((c) => {
          const w = wired[c.name];
          if (onlyUnmapped && w && !w.error) return null;
          return (
            <div
              key={c.name}
              className="flex items-center gap-3.5 border-b border-line px-3 py-2.5 hover:bg-surface"
            >
              <span className="w-[170px] shrink-0 font-mono text-[13px] text-ink">{c.name}</span>
              <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-wide text-ink-3">
                {c.type || "—"}
              </span>
              <span className="flex min-h-[22px] flex-1 flex-wrap items-center gap-1.5">
                {values[c.name] ? (
                  <>
                    {values[c.name].slice(0, 4).map((v) => (
                      <span
                        key={v}
                        title={v}
                        className="max-w-[220px] truncate rounded-sm bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2"
                      >
                        {v}
                      </span>
                    ))}
                    {values[c.name].length > 4 && (
                      <span className="font-mono text-[11px] text-ink-3">
                        +{values[c.name].length - 4} more
                      </span>
                    )}
                    {values[c.name].length === 0 && (
                      <span className="font-mono text-[11px] text-ink-3">no values</span>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => peek(c.name)}
                    className="rounded-pill border border-dashed border-line-2 px-2.5 py-0.5 font-mono text-[11px] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink-2"
                  >
                    peek values
                  </button>
                )}
              </span>
              <span className="shrink-0">
                {w?.error ? (
                  <button
                    type="button"
                    onClick={() => wire(c.name, w.refTable)}
                    className="rounded-sm border border-danger/40 px-2 py-1 font-mono text-[11px] text-danger hover:bg-danger-soft"
                  >
                    Retry
                  </button>
                ) : w ? (
                  <span className="flex items-center gap-2 rounded-sm bg-accent/15 px-2.5 py-1 text-[11.5px] text-ink">
                    {w.n !== null && <IconCheck className="h-3 w-3 text-accent" />}
                    {w.n === null ? `Connecting ${w.refTable}…` : w.refTable}
                    {w.n !== null && (
                      <button
                        type="button"
                        aria-label="Disconnect this column"
                        onClick={() => void unwire(c.name, w)}
                        className="text-ink-3 hover:text-ink"
                      >
                        <IconX className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ) : (
                  <ComboSelect
                    options={refTableOptions}
                    value={null}
                    placeholder="connect…"
                    onPick={canEdit ? (d) => wire(c.name, d) : undefined}
                    disabled={!canEdit}
                  />
                )}
              </span>
            </div>
          );
        })}
        {cols === null && (
          <div className="px-3 py-16 text-center font-mono text-[12px] text-ink-3">
            Loading columns…
          </div>
        )}
        {colsError !== null ? (
          <div className="flex flex-col items-center gap-3 px-3 py-16 text-center">
            <div className="font-mono text-[12px] text-danger">
              Couldn’t read this table — {colsError}
            </div>
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              className="rounded-sm border border-line-2 px-2.5 py-1 font-mono text-[11px] text-ink-2 hover:border-ink-3 hover:text-ink"
            >
              Try again
            </button>
          </div>
        ) : (
          cols?.length === 0 && (
            <div className="px-3 py-16 text-center font-mono text-[12px] text-ink-3">
              No columns.
            </div>
          )
        )}
      </div>
    </div>
  );
}
