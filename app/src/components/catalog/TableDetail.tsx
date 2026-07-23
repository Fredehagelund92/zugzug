import { useEffect, useState } from "react";
import { ComboSelect } from "../ComboSelect";
import { IconCheck, IconX } from "../Icons";
import { cx } from "../../lib/cx";
import {
  deriveCanonical,
  fetchColumnValues,
  fetchColumns,
  useCanEdit,
  type CatalogColumn,
} from "../../store";
import type { MappingDimension } from "../../data";

type WireState = {
  dim: string;
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
  dims,
}: {
  database: string;
  tablePath: string;
  connectionLabel: string;
  dims: MappingDimension[];
}) {
  const canEdit = useCanEdit();
  const [cols, setCols] = useState<CatalogColumn[] | null>(null);
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [wired, setWired] = useState<Record<string, WireState>>({});
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCols(null);
    setValues({});
    setWired({});
    fetchColumns(database, tablePath)
      .then((c) => {
        if (!cancelled) setCols(c);
      })
      .catch(() => {
        if (!cancelled) setCols([]);
      });
    return () => {
      cancelled = true;
    };
  }, [database, tablePath]);

  const peek = async (col: string) => {
    if (values[col]) return;
    const v = await fetchColumnValues(database, tablePath, col, 5).catch(() => []);
    setValues((s) => ({ ...s, [col]: v }));
  };

  const wire = async (column: string, dimLabel: string) => {
    const dim = dims.find((d) => d.dimension === dimLabel);
    if (!dim) return;
    setWired((w) => ({ ...w, [column]: { dim: dimLabel, n: null } }));
    try {
      const { derived, mode, matched, unmatched } = await deriveCanonical(
        dim.id,
        tablePath,
        column,
      );
      setWired((w) => ({
        ...w,
        [column]: { dim: dimLabel, n: derived, mode, matched, unmatched },
      }));
    } catch (err) {
      setWired((w) => ({
        ...w,
        [column]: {
          dim: dimLabel,
          n: null,
          error: err instanceof Error ? err.message : "wire failed",
        },
      }));
    }
  };

  const dimOptions = dims.map((d) => d.dimension);
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
            onClick={() => setOnlyUnmapped((v) => !v)}
            className="ml-auto flex items-center gap-2 text-[12px] text-ink-2"
          >
            <span
              className={cx(
                "relative h-[18px] w-8 rounded-pill transition-colors",
                onlyUnmapped ? "bg-accent" : "bg-surface-3",
              )}
            >
              <span
                className={cx(
                  "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-transform",
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
                        className="rounded-sm bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2"
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
                    onClick={() => wire(c.name, w.dim)}
                    className="rounded-sm border border-danger/40 px-2 py-1 font-mono text-[11px] text-danger hover:bg-danger-soft"
                  >
                    Retry
                  </button>
                ) : w ? (
                  <span className="flex items-center gap-2 rounded-sm bg-accent/15 px-2.5 py-1 text-[11.5px] text-ink">
                    <IconCheck className="h-3 w-3 text-accent" />
                    {w.n === null ? `Connecting ${w.dim}…` : w.dim}
                    {w.n !== null && (
                      <button
                        type="button"
                        aria-label="Remove mapping"
                        onClick={() =>
                          setWired((s) => {
                            const n = { ...s };
                            delete n[c.name];
                            return n;
                          })
                        }
                        className="text-ink-3 hover:text-ink"
                      >
                        <IconX className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ) : (
                  <ComboSelect
                    options={dimOptions}
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
        {cols?.length === 0 && (
          <div className="px-3 py-16 text-center font-mono text-[12px] text-ink-3">No columns.</div>
        )}
      </div>
    </div>
  );
}
