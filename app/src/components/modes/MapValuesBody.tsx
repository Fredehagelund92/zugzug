import { useMemo, useRef, useState } from "react";
import type { MappingRefTable } from "../../data";
import type { ComboSelectHandle } from "../ComboSelect";
import { MapValueRow } from "./MapValueRow";
import { SourcesFeedStrip } from "./SourcesFeedStrip";
import { MatchModeBody } from "./MatchModeBody";
import { useRefTableClusters } from "../../lib/use-ref-table-clusters";
import { useDrafts, listDrafts, commit, useCanEdit, saveDraft } from "../../store";
import { toast } from "../Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Button } from "../Button";
import { cx } from "../../lib/cx";

/* MapValuesBody — the Map values tab: one calm worklist for a single table.
   Every source value that needs a record is one row (value · record picker ·
   status), mirroring the Review queue. Mapping a row stages one draft per
   look-alike spelling in its cluster, so one decision covers the whole family.
   "Open as grid" drops to the MatchModeBody power surface for bulk paste. */
export function MapValuesBody({
  refTable,
  isActive,
}: {
  refTable: MappingRefTable;
  isActive: boolean;
}) {
  const [view, setView] = useState<"list" | "grid">("list");
  const [filter, setFilter] = useState<"new" | "mapped">("new");
  const [cursor, setCursor] = useState(0);
  const drafts = useDrafts();
  const canEdit = useCanEdit();

  const feed = useRefTableClusters({
    refTableId: refTable.id,
    filter,
    enabled: isActive && view === "list",
  });

  const recordLabels = useMemo(() => refTable.record.map((r) => r.label), [refTable.record]);
  const comboRefs = useRef<(ComboSelectHandle | null)[]>([]);

  const staged = useMemo(
    () => listDrafts(refTable.id).filter((d) => d.status === "mapped").length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, refTable.id],
  );

  const publish = useAsyncAction(async () => {
    if (staged === 0) return;
    try {
      const res = await commit(refTable.id);
      toast(
        `Published ${res.committed} change${res.committed === 1 ? "" : "s"} to ${refTable.refTable}`,
      );
    } catch (e) {
      toast(e instanceof Error ? `Publish failed — ${e.message}` : "Publish failed.", "error");
      throw e;
    }
  });

  if (view === "grid") {
    return (
      <div className="flex flex-1 flex-col min-h-0 bg-surface">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 pt-3 pb-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
            map values · {refTable.refTable} · grid
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setView("list")}>
            ← Back to list
          </Button>
        </div>
        <MatchModeBody refTable={refTable} isActive={isActive} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-surface">
      {/* header: kicker · count · sources strip · filter · grid escape hatch */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 pt-3 pb-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
          map values · {refTable.refTable}
        </span>
        <span className="font-mono text-[11px] text-ink">
          <span className="font-semibold text-accent">{feed.clusters.length}</span>{" "}
          {filter === "new" ? "to map" : "mapped"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <SourcesFeedStrip refTable={refTable} />
          <div className="inline-flex rounded-sm border border-line">
            {(["new", "mapped"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFilter(f);
                  setCursor(0);
                }}
                className={cx(
                  "px-2.5 py-1 font-mono text-[11px]",
                  filter === f ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {f === "new" ? "To map" : "Mapped"}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setView("grid")}>
            Open as grid
          </Button>
        </div>
      </div>

      {/* keyboard hint */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-1.5 font-mono text-[10.5px] text-ink-3">
        <span>
          <span className="text-ink-2">↑↓</span> move
        </span>
        <span>
          <span className="text-ink-2">⏎</span> pick a record
        </span>
        <span>
          <span className="text-ink-2">S</span> skip
        </span>
        <span>
          <span className="text-ink-2">⌘⏎</span> publish
        </span>
      </div>

      {/* body */}
      {feed.loading ? (
        <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">loading…</div>
      ) : feed.error ? (
        <div className="px-4 py-12 text-center font-mono text-[12px] text-danger">
          Couldn&apos;t load values: {feed.error}{" "}
          <button type="button" onClick={feed.refetch} className="text-accent hover:underline">
            retry
          </button>
        </div>
      ) : feed.clusters.length === 0 ? (
        <div className="bg-surface px-4 py-10 text-center">
          <div className="font-display text-[18px] font-semibold text-ink">
            {filter === "new" ? `${refTable.refTable} is all mapped 🎉` : "Nothing mapped yet"}
          </div>
        </div>
      ) : (
        <ul
          className="flex-1 overflow-y-auto outline-none"
          tabIndex={0}
          role="list"
          aria-label="Values to map"
          onKeyDown={(e) => {
            const t = e.target as HTMLElement;
            if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
            const n = feed.clusters.length;
            if (n === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, n - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              comboRefs.current[cursor]?.open();
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (staged > 0 && canEdit) void publish.run();
            } else if ((e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              const c = feed.clusters[cursor];
              if (!c) return;
              for (const mem of c.members) {
                void saveDraft(refTable.id, mem.raw, "skipped", null, null);
              }
            }
          }}
        >
          {feed.clusters.map((c, i) => (
            <MapValueRow
              key={c.key}
              cluster={c}
              refTable={refTable}
              recordLabels={recordLabels}
              isCursor={i === cursor}
              onFocus={() => setCursor(i)}
              comboRef={(el) => {
                comboRefs.current[i] = el;
              }}
            />
          ))}
        </ul>
      )}

      {/* publish bar */}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
        <span className="font-mono text-[11px] text-ink-2">
          {staged > 0 ? (
            <>
              <span className="font-semibold text-ink">
                {staged} draft{staged === 1 ? "" : "s"}
              </span>{" "}
              ready to publish to {refTable.refTable}
            </>
          ) : (
            <>no drafts yet — map values above</>
          )}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={staged === 0 || !canEdit}
          onClick={() => void publish.run()}
        >
          Publish {staged} change{staged === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
