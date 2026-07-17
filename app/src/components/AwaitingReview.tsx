import { useState, useMemo } from "react";
import {
  useDrafts,
  useDimensions,
  useCanEdit,
  useCurrentUser,
  rejectDrafts,
  commit,
  fetchPublishState,
  ApiCodeError,
} from "../store";
import type { Draft } from "../store";
import { Checkbox } from "./Checkbox";
import { Button } from "./Button";
import { PublishPreviewDialog, type PublishGroup } from "./PublishPreviewDialog";
import { toast } from "./Toast";
import { cx } from "../lib/cx";
import { summarizeOutcomes, type CommitOutcome } from "../lib/commit-outcomes";

const SYSTEM_USER_ID = "u_system";
const COLLAPSE_THRESHOLD = 20;

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface AuthorGroup {
  authorId: string;
  authorName: string;
  drafts: Draft[];
}

interface TableGroup {
  dimId: string;
  dimName: string;
  authorGroups: AuthorGroup[];
  totalDrafts: number;
}

export function AwaitingReview() {
  const allDrafts = useDrafts();
  const dims = useDimensions();
  const canEdit = useCanEdit();
  const me = useCurrentUser();

  // selection: Set of "dimId::raw" keys
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // reject UI state
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectLoading, setRejectLoading] = useState(false);
  // publish preview
  const [preview, setPreview] = useState<PublishGroup[] | null>(null);
  const [publishing, setPublishing] = useState(false);
  // per-table collapse state (expanded when <= threshold)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const myId = me?.id ?? null;

  // Collect only others' "mapped" drafts
  const othersMappedDrafts = useMemo(
    () => Object.values(allDrafts).filter((d) => d.status === "mapped" && d.user.id !== myId),
    [allDrafts, myId],
  );

  // Group by table → author
  const tableGroups = useMemo((): TableGroup[] => {
    const dimMap = new Map(dims.map((d) => [d.id, d.dimension]));
    const byDim = new Map<string, Draft[]>();
    for (const d of othersMappedDrafts) {
      const arr = byDim.get(d.dimId) ?? [];
      arr.push(d);
      byDim.set(d.dimId, arr);
    }
    const groups: TableGroup[] = [];
    for (const [dimId, drafts] of byDim) {
      const byAuthor = new Map<string, { name: string; drafts: Draft[] }>();
      for (const d of drafts) {
        const entry = byAuthor.get(d.user.id) ?? { name: d.user.name, drafts: [] };
        entry.drafts.push(d);
        byAuthor.set(d.user.id, entry);
      }
      const authorGroups: AuthorGroup[] = [...byAuthor.entries()].map(
        ([authorId, { name, drafts: ds }]) => ({
          authorId,
          authorName: authorId === SYSTEM_USER_ID ? "System (rescan)" : name,
          drafts: ds,
        }),
      );
      groups.push({
        dimId,
        dimName: dimMap.get(dimId) ?? dimId,
        authorGroups,
        totalDrafts: drafts.length,
      });
    }
    return groups.sort((a, b) => b.totalDrafts - a.totalDrafts);
  }, [othersMappedDrafts, dims]);

  if (!myId) return null;
  if (tableGroups.length === 0) return null;

  const totalCount = othersMappedDrafts.length;

  // Selection helpers
  const selKey = (d: Draft) => `${d.dimId}::${d.raw}`;
  const tableKeys = (tg: TableGroup) => tg.authorGroups.flatMap((ag) => ag.drafts.map(selKey));

  const tableSelState = (tg: TableGroup): "on" | "off" | "mixed" => {
    const keys = tableKeys(tg);
    const onCount = keys.filter((k) => selected.has(k)).length;
    if (onCount === 0) return "off";
    if (onCount === keys.length) return "on";
    return "mixed";
  };

  const toggleTable = (tg: TableGroup) => {
    const keys = tableKeys(tg);
    const allOn = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
  };

  const toggleRow = (d: Draft) => {
    const k = selKey(d);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const selectedDrafts = othersMappedDrafts.filter((d) => selected.has(selKey(d)));

  // Publish selected
  const handlePublishSelected = async () => {
    if (selectedDrafts.length === 0) return;
    const dimIds = [...new Set(selectedDrafts.map((d) => d.dimId))];
    try {
      const states = await Promise.all(dimIds.map((id) => fetchPublishState(id)));
      setPreview(
        dimIds.map((id, i) => ({
          dimId: id,
          dimName: dims.find((d) => d.id === id)?.dimension ?? id,
          nextVersion: states[i].version + 1,
          drafts: selectedDrafts.filter((d) => d.dimId === id),
          changedKeys: states[i].changedKeys,
        })),
      );
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load publish preview — try again.",
        "error",
      );
    }
  };

  const confirmPublish = async () => {
    if (!preview) return;
    setPublishing(true);
    try {
      const outcomes: CommitOutcome[] = [];
      for (const g of preview) {
        try {
          const res = await commit(
            g.dimId,
            g.drafts.map((d) => d.raw),
          );
          outcomes.push({
            dimId: g.dimId,
            dimName: g.dimName,
            committed: res.committed,
            rowsRecovered: res.rowsRecovered,
            error: null,
          });
        } catch (err) {
          const isSecondPublisher =
            err instanceof ApiCodeError && err.code === "SECOND_PUBLISHER_REQUIRED";
          outcomes.push({
            dimId: g.dimId,
            dimName: g.dimName,
            committed: 0,
            rowsRecovered: 0,
            error: isSecondPublisher
              ? "These drafts need a second publisher."
              : err instanceof Error
                ? err.message
                : "unknown error",
          });
        }
      }
      const summary = summarizeOutcomes(outcomes);
      if (summary.ok) {
        if (summary.committed > 0) toast(summary.message);
        setSelected(new Set());
      } else {
        toast(summary.message, "error");
      }
    } finally {
      setPublishing(false);
      setPreview(null);
    }
  };

  // Reject selected
  const handleRejectSelected = async () => {
    if (selectedDrafts.length === 0 || !rejectReason.trim()) return;
    setRejectLoading(true);
    const byDim = new Map<string, { dimName: string; raws: string[] }>();
    for (const d of selectedDrafts) {
      const entry = byDim.get(d.dimId) ?? {
        dimName: tableGroups.find((tg) => tg.dimId === d.dimId)?.dimName ?? d.dimId,
        raws: [],
      };
      entry.raws.push(d.raw);
      byDim.set(d.dimId, entry);
    }
    const outcomes: Array<{ dimName: string; rejected: boolean; error: string | null }> = [];
    for (const [dimId, { dimName, raws }] of byDim) {
      try {
        await rejectDrafts(dimId, raws, rejectReason.trim());
        outcomes.push({ dimName, rejected: true, error: null });
      } catch (err) {
        outcomes.push({
          dimName,
          rejected: false,
          error: err instanceof Error ? err.message : "unknown error",
        });
      }
    }
    setRejectLoading(false);
    const failed = outcomes.filter((o) => !o.rejected);
    const succeededCount = outcomes.filter((o) => o.rejected).length;
    if (failed.length === 0) {
      // Full success — clear all state
      setRejecting(false);
      setSelected(new Set());
      setRejectReason("");
      const total = selectedDrafts.length;
      toast(`${total} draft${total === 1 ? "" : "s"} rejected`);
    } else {
      // Partial failure: keep failed tables' rows selected, keep reason input open
      const failedDimIds = new Set(
        [...byDim.entries()]
          .filter(([, { dimName }]) => failed.some((f) => f.dimName === dimName))
          .map(([dimId]) => dimId),
      );
      setSelected((prev) => {
        const next = new Set<string>();
        for (const k of prev) {
          const dimId = k.split("::")[0];
          if (failedDimIds.has(dimId)) next.add(k);
        }
        return next;
      });
      // Keep rejecting open so reason input remains visible
      const names = failed.map((f) => `${f.dimName} failed (${f.error})`).join("; ");
      toast(
        succeededCount > 0
          ? `Rejected ${succeededCount} table${succeededCount === 1 ? "" : "s"}, but ${names}`
          : `Reject failed — ${names}`,
        "error",
      );
    }
  };

  const isCollapsed = (dimId: string, total: number) => {
    if (dimId in collapsed) return collapsed[dimId];
    return total > COLLAPSE_THRESHOLD;
  };

  const toggleCollapse = (dimId: string, total: number) => {
    setCollapsed((prev) => ({ ...prev, [dimId]: !isCollapsed(dimId, total) }));
  };

  return (
    <div className="mb-4 rounded-lg border border-line bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Awaiting review · {totalCount}
        </span>
        {canEdit && selectedDrafts.length > 0 && (
          <div className="flex items-center gap-2">
            {!rejecting ? (
              <>
                <Button size="sm" onClick={() => void handlePublishSelected()}>
                  Publish selected
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRejecting(true)}>
                  Reject selected
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason (required)"
                  aria-label="Reason (required)"
                  className="rounded-sm border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink"
                />
                <Button
                  size="sm"
                  disabled={!rejectReason.trim()}
                  loading={rejectLoading}
                  onClick={() => void handleRejectSelected()}
                >
                  Reject selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRejecting(false);
                    setRejectReason("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Table groups */}
      <div className="divide-y divide-line">
        {tableGroups.map((tg) => {
          const collapsed_ = isCollapsed(tg.dimId, tg.totalDrafts);
          const allDraftsInTable = tg.authorGroups.flatMap((ag) => ag.drafts);
          const visibleDrafts = collapsed_
            ? allDraftsInTable.slice(0, COLLAPSE_THRESHOLD)
            : allDraftsInTable;
          const hiddenCount = tg.totalDrafts - COLLAPSE_THRESHOLD;

          return (
            <div key={tg.dimId}>
              {/* Table header row */}
              <div className="flex items-center gap-3 bg-surface-2 px-4 py-2">
                {canEdit && (
                  <Checkbox
                    state={tableSelState(tg)}
                    onClick={() => toggleTable(tg)}
                    aria-label={`Select all in ${tg.dimName}`}
                  />
                )}
                <span className="flex-1 font-mono text-[11px] font-semibold text-ink-2">
                  {tg.dimName}
                  <span className="ml-2 font-normal text-ink-3">
                    · {tg.totalDrafts} record{tg.totalDrafts === 1 ? "" : "s"}
                  </span>
                </span>
                {tg.totalDrafts > COLLAPSE_THRESHOLD && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(tg.dimId, tg.totalDrafts)}
                    className="font-mono text-[10px] text-ink-3 hover:text-ink-2"
                  >
                    {collapsed_ ? `show all ${tg.totalDrafts}` : "collapse"}
                  </button>
                )}
              </div>

              {/* Author groups + rows */}
              {tg.authorGroups.map((ag) => {
                const visibleForAuthor = visibleDrafts.filter((d) => d.user.id === ag.authorId);
                if (visibleForAuthor.length === 0) return null;
                return (
                  <div key={ag.authorId}>
                    <div className="px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-3">
                      {ag.authorName}
                    </div>
                    <ul className="divide-y divide-line">
                      {visibleForAuthor.map((d) => {
                        const k = selKey(d);
                        const isSelected = selected.has(k);
                        return (
                          <li
                            key={k}
                            className={cx(
                              "flex items-center gap-3 px-4 py-2 transition-colors",
                              isSelected ? "bg-accent-wash/20" : "hover:bg-hover",
                            )}
                          >
                            {canEdit && (
                              <Checkbox
                                state={isSelected ? "on" : "off"}
                                onClick={() => toggleRow(d)}
                                aria-label={`Select ${d.raw}`}
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-[13px] text-ink">
                                {d.raw}
                              </span>
                              <span className="block font-mono text-[10px] text-ink-3">
                                source value
                              </span>
                            </span>
                            <span className="w-40 truncate font-display text-[13px] text-ink">
                              {d.targetLabel ?? <span className="text-ink-3">—</span>}
                            </span>
                            <span className="w-28 font-mono text-[10px] text-ink-3">
                              {d.source === "ai" ? `AI · ${d.confidence ?? "?"}` : ag.authorName}
                            </span>
                            <span className="w-16 shrink-0 text-right font-mono text-[10px] text-ink-3">
                              {relativeTime(d.at)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}

              {/* "and N more" affordance */}
              {collapsed_ && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => toggleCollapse(tg.dimId, tg.totalDrafts)}
                  className="w-full px-4 py-2 text-left font-mono text-[11px] text-ink-3 hover:text-ink-2"
                >
                  and {hiddenCount} more…
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Publish preview dialog */}
      {preview && (
        <PublishPreviewDialog
          open
          groups={preview}
          publishing={publishing}
          onConfirm={() => void confirmPublish()}
          onCancel={() => setPreview(null)}
        />
      )}
    </div>
  );
}
