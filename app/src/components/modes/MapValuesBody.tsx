import { useMemo, useState } from "react";
import type { MappingDimension } from "../../data";
import { ClusterMapperCard } from "./ClusterMapperCard";
import { MatchModeBody } from "./MatchModeBody";
import { useDrafts, listDrafts, commit, useCanEdit } from "../../store";
import { toast } from "../Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Button } from "../Button";
import { cx } from "../../lib/cx";

type View = "focused" | "grid";

/* MapValuesBody — the Map values tab. Default is the focused cluster card
   (ClusterMapperCard) with a publish bar; the Grid toggle drops to the existing
   MatchModeBody power view (bulk / paste). Both stage into the
   same drafts, so the publish bar works from either. */
export function MapValuesBody({ dim, isActive }: { dim: MappingDimension; isActive: boolean }) {
  const [view, setView] = useState<View>("focused");
  const drafts = useDrafts();
  const canEdit = useCanEdit();

  const staged = useMemo(
    () => listDrafts(dim.id).filter((d) => d.status === "mapped").length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, dim.id],
  );

  const publish = useAsyncAction(async () => {
    if (staged === 0) return;
    try {
      const res = await commit(dim.id);
      toast(
        `Published ${res.committed} change${res.committed === 1 ? "" : "s"} to ${dim.dimension}`,
      );
    } catch (e) {
      toast(e instanceof Error ? `Publish failed — ${e.message}` : "Publish failed.", "error");
      throw e;
    }
  });

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* mapper-head: kicker + view toggle */}
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 pt-3 pb-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
          map values · {dim.dimension}
        </span>
        <div className="rounded-sm ml-auto inline-flex border border-line">
          {(["focused", "grid"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cx(
                "px-3 py-1 font-mono text-[11px]",
                view === v ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {v === "focused" ? "Focused" : "Grid"}
            </button>
          ))}
        </div>
      </div>

      {view === "focused" ? (
        <p className="border-b border-line bg-surface px-4 py-2 text-[12px] leading-snug text-ink-3">
          Zugzug groups the look-alikes, so one decision maps a whole family of spellings. The
          closest record is pre-highlighted — <span className="text-ink-2">Enter</span> maps the
          group and jumps to the next. <span className="font-mono">↑↓</span> to choose, type to
          search, <span className="font-mono">Tab</span> takes the suggested record.
        </p>
      ) : (
        <p className="border-b border-line bg-surface px-4 py-2 font-mono text-[11px] text-ink-3">
          Grid keeps the same staged drafts and publish bar — a spreadsheet with range-select and
          copy/paste. This is the power surface.
        </p>
      )}

      {view === "focused" ? (
        <>
          <ClusterMapperCard dim={dim} />
          <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-line bg-surface px-4 py-3">
            <span className="font-mono text-[11px] text-ink-2">
              {staged > 0 ? (
                <>
                  <span className="font-semibold text-ink">
                    {staged} staged change{staged === 1 ? "" : "s"}
                  </span>{" "}
                  ready to publish to {dim.dimension}
                </>
              ) : (
                <>nothing staged yet — map values above</>
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
        </>
      ) : (
        <MatchModeBody dim={dim} isActive={isActive} />
      )}
    </div>
  );
}
