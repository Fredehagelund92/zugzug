import { useEffect, useRef } from "react";
import type { MappingDimension } from "../../data";
import { useClusterMapper } from "../../lib/use-cluster-mapper";
import { useCandidatePicker } from "../../lib/use-candidate-picker";
import { Button } from "../Button";
import { IconSearch } from "../Icons";
import { cx } from "../../lib/cx";

/* ClusterMapperCard — the focused "map one family at a time" card. Renders the
   useClusterMapper controller: the current cluster, a keyboard-driven candidate
   list with the mapped-sibling suggestion pre-highlighted, coverage, and
   map/skip/undo. Styled with the app's Squared tokens. */
export function ClusterMapperCard({ dim }: { dim: MappingDimension }) {
  const m = useClusterMapper(dim);

  // Swallow a second synchronous map/skip before the cluster advances.
  const acting = useRef(false);
  useEffect(() => {
    acting.current = false;
  }, [m.current?.key, m.done]);
  const mapGuarded = (k: string, l: string) => {
    if (acting.current) return;
    acting.current = true;
    m.mapCluster(k, l);
  };
  const skipGuarded = () => {
    if (acting.current) return;
    acting.current = true;
    m.skipCluster();
  };

  const picker = useCandidatePicker({
    candidates: m.candidates,
    suggestion: m.suggestion,
    onMap: mapGuarded,
    onUndo: m.undo,
    onQueryReset: () => m.setQuery(""),
  });

  if (m.loading) {
    return <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">loading…</div>;
  }
  if (m.error) {
    return (
      <div className="px-4 py-12 text-center font-mono text-[12px] text-danger">
        Couldn&apos;t load values: {m.error}{" "}
        <button type="button" onClick={m.refetch} className="text-accent hover:underline">
          retry
        </button>
      </div>
    );
  }
  if (m.done || !m.current) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="font-display text-[18px] font-semibold text-ink">
          {dim.dimension} is all mapped 🎉
        </div>
        <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">
          {m.coverage.pct}% of at-risk rows resolved · {m.staged} staged
        </div>
      </div>
    );
  }

  const c = m.current;
  const shown = c.members.slice(0, 6);
  return (
    <div
      className="flex flex-1 flex-col min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={picker.onKeyDown}
      aria-label="Map values"
    >
      {/* header: progress + coverage */}
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">mapping</span>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          <span className="text-ink">{m.position.index + 1}</span> of {m.position.total}
        </span>
        <div className="h-1 w-28 overflow-hidden rounded-pill bg-surface-2">
          <div className="h-full bg-committed" style={{ width: `${m.coverage.pct}%` }} />
        </div>
        <span className="font-mono text-[11px] text-committed">{m.coverage.pct}%</span>
      </div>

      {m.truncated && (
        <div className="border-b border-line bg-warn-soft px-4 py-1.5 font-mono text-[11px] text-warn">
          Showing the highest-impact groups; a long tail of rare values remains.
        </div>
      )}

      {/* cluster: rep + member chips */}
      <div className="px-5 pt-5">
        <div className="flex items-end justify-between gap-4">
          <div className="break-all font-mono text-[26px] font-semibold leading-none tracking-[-0.01em] text-ink">
            {c.rep}
          </div>
          <div className="text-right font-mono text-[11px] text-ink-3">
            <span className="block text-[15px] font-semibold text-ink-2">{c.rows.toLocaleString("en-US")}</span>
            rows affected
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {shown.map((mem) => (
            <span key={mem.raw} className="rounded-sm border border-line bg-surface px-2 py-0.5 font-mono text-[12px] text-ink">
              {mem.raw}
            </span>
          ))}
          {c.members.length > shown.length && (
            <span className="rounded-sm border border-dashed border-line px-2 py-0.5 font-mono text-[12px] text-ink-3">
              +{c.members.length - shown.length} more
            </span>
          )}
        </div>
      </div>

      {/* search */}
      <label className="mx-5 mt-4 flex items-center gap-2 border border-line-2 bg-surface">
        <span className="pl-3 text-ink-3">
          <IconSearch className="h-4 w-4" />
        </span>
        <input
          value={m.query}
          onChange={(e) => m.setQuery(e.target.value)}
          placeholder="Search records…"
          className="min-h-[36px] flex-1 bg-transparent px-1 font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
          aria-label="Search records"
        />
        <span className="pr-3 font-mono text-[10px] text-ink-3">↑↓ · ⏎ map</span>
      </label>

      {/* candidate list */}
      <div className="mt-3 flex-1 overflow-y-auto" role="listbox" aria-label="Records">
        {m.candidates.map((cand, i) => {
          const activeCls = i === picker.active ? "border-l-accent bg-surface-2" : "border-l-transparent";
          const label = cand.kind === "create" ? `Create “${cand.label}” as a new record` : cand.label;
          const isSuggested = cand.kind === "record" && m.suggestion?.key === cand.key;
          return (
            <button
              key={cand.kind === "create" ? "__create" : cand.key}
              type="button"
              role="option"
              aria-selected={i === picker.active}
              onClick={() => picker.commit(cand)}
              className={cx(
                "flex w-full items-center gap-3 border-l-2 px-5 py-2.5 text-left hover:bg-hover",
                activeCls,
              )}
            >
              <span className={cx("font-display text-[15px] font-semibold", cand.kind === "create" ? "text-accent" : "text-ink")}>
                {cand.kind === "create" ? "＋ " : ""}
                {label}
              </span>
              {cand.kind === "record" && <span className="font-mono text-[11px] text-ink-3">{cand.key}</span>}
              <span className="ml-auto flex items-center gap-2">
                {isSuggested && (
                  <span className="rounded-pill bg-accent-wash px-2 py-0.5 font-mono text-[9.5px] uppercase text-accent">
                    Suggested
                  </span>
                )}
                {i === picker.active && (
                  <span className="bg-accent px-1.5 font-mono text-[10px] text-accent-ink">⏎</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* footer: staged + undo + skip */}
      <div className="flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
        <span className="font-mono text-[11px] text-ink-3">
          <span className="text-ink-2">{m.staged}</span> staged · Tab takes the suggestion
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={m.undo}>
            ↶ Undo
          </Button>
          <Button variant="secondary" size="sm" onClick={skipGuarded}>
            Skip <span className="ml-1 font-mono text-[10px] opacity-60">→</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
