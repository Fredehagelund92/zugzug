import { useState, useMemo, useCallback, memo } from "react";
import {
  akey,
  useDrafts,
  useRefTables,
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
import { focusRing } from "../lib/focus-ring";
import { summarizeOutcomes, type CommitOutcome } from "../lib/commit-outcomes";

const SYSTEM_USER_ID = "u_system";

/** Turn a REQUIRED_FIELDS_EMPTY error into a message that names the records and
 *  fields still needing a value, so the publisher knows exactly what to fix. */
function requiredEmptyMessage(err: ApiCodeError): string {
  const violations =
    (err.details?.violations as Array<{ label: string; fieldLabel: string }> | undefined) ?? [];
  if (violations.length === 0) return "Some records need a required value before you can publish.";
  const fields = [...new Set(violations.map((v) => v.fieldLabel))].join(", ");
  const records = [...new Set(violations.map((v) => v.label))];
  const shown = records.slice(0, 3).join(", ");
  const rest = records.length > 3 ? ` +${records.length - 3} more` : "";
  return `${shown}${rest} need ${fields} before you can publish.`;
}
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
  refTableId: string;
  refTableName: string;
  authorGroups: AuthorGroup[];
  totalDrafts: number;
}

/** One review row, memoized on its own props (#158). Selection lives in a Set
 *  on the parent; toggling one checkbox previously re-rendered every row because
 *  each recomputed `selected.has(k)`. With React.memo + a stable `onToggle`, only
 *  the toggled row (whose `isSelected` actually changed) re-renders. */
const DraftRow = memo(function DraftRow({
  draft,
  isSelected,
  canEdit,
  authorName,
  onToggle,
}: {
  draft: Draft;
  isSelected: boolean;
  canEdit: boolean;
  authorName: string;
  onToggle: (d: Draft) => void;
}) {
  return (
    <li
      className={cx(
        "flex items-center gap-3 px-4 py-2 transition-colors",
        isSelected ? "bg-accent-wash/20" : "hover:bg-hover",
      )}
    >
      {canEdit && (
        <Checkbox
          state={isSelected ? "on" : "off"}
          onClick={() => onToggle(draft)}
          aria-label={`Select ${draft.raw}`}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px] text-ink">{draft.raw}</span>
        <span className="block font-mono text-[10px] text-ink-3">source value</span>
      </span>
      <span className="w-40 truncate font-display text-[13px] text-ink">
        {draft.targetLabel ?? <span className="text-ink-3">—</span>}
      </span>
      <span className="w-28 font-mono text-[10px] text-ink-3">
        {draft.source === "ai" ? `AI · ${draft.confidence ?? "?"}` : authorName}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[10px] text-ink-3">
        {relativeTime(draft.createdAt)}
      </span>
    </li>
  );
});

export function AwaitingReview() {
  const allDrafts = useDrafts();
  const refTables = useRefTables();
  const canEdit = useCanEdit();
  const me = useCurrentUser();

  // selection: Set of akey(refTableId, raw, authorId) — a row per author, so
  // acting on Mia's draft for "usa" must never touch Bob's.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // reject UI state
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectLoading, setRejectLoading] = useState(false);
  // publish preview
  const [preview, setPreview] = useState<PublishGroup[] | null>(null);
  const [publishing, setPublishing] = useState(false);
  // Guards the Approve & publish button while its preview fetch is in flight so
  // rapid clicks can't queue multiple publish flows (#161).
  const [previewLoading, setPreviewLoading] = useState(false);
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
    const refTableMap = new Map(refTables.map((d) => [d.id, d.refTable]));
    const byDim = new Map<string, Draft[]>();
    for (const d of othersMappedDrafts) {
      const arr = byDim.get(d.refTableId) ?? [];
      arr.push(d);
      byDim.set(d.refTableId, arr);
    }
    const groups: TableGroup[] = [];
    for (const [refTableId, drafts] of byDim) {
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
        refTableId,
        refTableName: refTableMap.get(refTableId) ?? refTableId,
        authorGroups,
        totalDrafts: drafts.length,
      });
    }
    return groups.sort((a, b) => b.totalDrafts - a.totalDrafts);
  }, [othersMappedDrafts, refTables]);

  // Stable identity so the memoized DraftRow's props don't change every render.
  // Declared before the early returns so hook order stays constant (#158).
  const toggleRow = useCallback((d: Draft) => {
    const k = akey(d.refTableId, d.raw, d.user.id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  if (!myId) return null;
  if (tableGroups.length === 0) return null;

  const totalCount = othersMappedDrafts.length;

  // Selection helpers
  const selKey = (d: Draft) => akey(d.refTableId, d.raw, d.user.id);
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

  const selectedDrafts = othersMappedDrafts.filter((d) => selected.has(selKey(d)));

  // Publish selected
  const handlePublishSelected = async () => {
    if (selectedDrafts.length === 0 || previewLoading) return;
    setPreviewLoading(true);
    const refTableIds = [...new Set(selectedDrafts.map((d) => d.refTableId))];
    try {
      const states = await Promise.all(refTableIds.map((id) => fetchPublishState(id)));
      setPreview(
        refTableIds.map((id, i) => ({
          refTableId: id,
          refTableName: refTables.find((d) => d.id === id)?.refTable ?? id,
          nextVersion: states[i].version + 1,
          drafts: selectedDrafts.filter((d) => d.refTableId === id),
          changedKeys: states[i].changedKeys,
        })),
      );
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load publish preview — try again.",
        "error",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmPublish = async () => {
    if (!preview) return;
    setPublishing(true);
    try {
      const outcomes: CommitOutcome[] = [];
      for (const g of preview) {
        try {
          // Scope to the exact drafts on screen: publishing Mia's row must
          // apply Mia's target, not whichever draft for that value is newest.
          const res = await commit(
            g.refTableId,
            g.drafts.map((d) => ({ raw: d.raw, userId: d.user.id })),
          );
          outcomes.push({
            refTableId: g.refTableId,
            refTableName: g.refTableName,
            committed: res.committed,
            rowsRecovered: res.rowsRecovered,
            error: null,
          });
        } catch (err) {
          const isSecondPublisher =
            err instanceof ApiCodeError && err.code === "SECOND_PUBLISHER_REQUIRED";
          const isRequiredEmpty =
            err instanceof ApiCodeError && err.code === "REQUIRED_FIELDS_EMPTY";
          outcomes.push({
            refTableId: g.refTableId,
            refTableName: g.refTableName,
            committed: 0,
            rowsRecovered: 0,
            error: isRequiredEmpty
              ? requiredEmptyMessage(err)
              : isSecondPublisher
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
    const byDim = new Map<
      string,
      { refTableName: string; keys: Array<{ raw: string; userId: string }> }
    >();
    for (const d of selectedDrafts) {
      const entry = byDim.get(d.refTableId) ?? {
        refTableName:
          tableGroups.find((tg) => tg.refTableId === d.refTableId)?.refTableName ?? d.refTableId,
        keys: [],
      };
      entry.keys.push({ raw: d.raw, userId: d.user.id });
      byDim.set(d.refTableId, entry);
    }
    const outcomes: Array<{ refTableName: string; rejected: boolean; error: string | null }> = [];
    for (const [refTableId, { refTableName, keys }] of byDim) {
      try {
        await rejectDrafts(refTableId, keys, rejectReason.trim());
        outcomes.push({ refTableName, rejected: true, error: null });
      } catch (err) {
        outcomes.push({
          refTableName,
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
      const failedRefTableIds = new Set(
        [...byDim.entries()]
          .filter(([, { refTableName }]) => failed.some((f) => f.refTableName === refTableName))
          .map(([refTableId]) => refTableId),
      );
      setSelected((prev) => {
        const next = new Set<string>();
        for (const d of selectedDrafts) {
          const k = selKey(d);
          if (prev.has(k) && failedRefTableIds.has(d.refTableId)) next.add(k);
        }
        return next;
      });
      // Keep rejecting open so reason input remains visible
      const names = failed.map((f) => `${f.refTableName} failed (${f.error})`).join("; ");
      toast(
        succeededCount > 0
          ? `Rejected ${succeededCount} table${succeededCount === 1 ? "" : "s"}, but ${names}`
          : `Reject failed — ${names}`,
        "error",
      );
    }
  };

  const isCollapsed = (refTableId: string, total: number) => {
    if (refTableId in collapsed) return collapsed[refTableId];
    return total > COLLAPSE_THRESHOLD;
  };

  const toggleCollapse = (refTableId: string, total: number) => {
    setCollapsed((prev) => ({ ...prev, [refTableId]: !isCollapsed(refTableId, total) }));
  };

  return (
    <div className="mb-4 rounded-lg border border-line bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
            Approve teammates’ work
          </div>
          <div className="mt-0.5 text-[12px] text-ink-2">
            Sign off on values your teammates mapped, or send one back with a note.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {canEdit && selectedDrafts.length > 0 ? (
            !rejecting ? (
              <>
                <Button
                  size="sm"
                  loading={previewLoading}
                  onClick={() => void handlePublishSelected()}
                >
                  Approve &amp; publish
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRejecting(true)}>
                  Send back
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
                  Send back
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
            )
          ) : (
            <span className="whitespace-nowrap font-mono text-[11px] text-ink-3 tabular-nums">
              {totalCount} waiting
            </span>
          )}
        </div>
      </div>

      {/* Table groups */}
      <div className="divide-y divide-line">
        {tableGroups.map((tg) => {
          const collapsed_ = isCollapsed(tg.refTableId, tg.totalDrafts);
          const allDraftsInTable = tg.authorGroups.flatMap((ag) => ag.drafts);
          const visibleDrafts = collapsed_
            ? allDraftsInTable.slice(0, COLLAPSE_THRESHOLD)
            : allDraftsInTable;
          const hiddenCount = tg.totalDrafts - COLLAPSE_THRESHOLD;
          // Bucket the visible drafts by author once (O(visible)) so each author
          // group is a Map lookup, not a fresh filter over visibleDrafts (#158).
          const visibleByAuthor = new Map<string, Draft[]>();
          for (const d of visibleDrafts) {
            const arr = visibleByAuthor.get(d.user.id) ?? [];
            arr.push(d);
            visibleByAuthor.set(d.user.id, arr);
          }

          return (
            <div key={tg.refTableId}>
              {/* Table header row */}
              <div className="flex items-center gap-3 bg-surface-2 px-4 py-2">
                {canEdit && (
                  <Checkbox
                    state={tableSelState(tg)}
                    onClick={() => toggleTable(tg)}
                    aria-label={`Select all in ${tg.refTableName}`}
                  />
                )}
                <span className="flex-1 font-mono text-[11px] font-semibold text-ink-2">
                  {tg.refTableName}
                  <span className="ml-2 font-normal text-ink-3">
                    · {tg.totalDrafts} draft{tg.totalDrafts === 1 ? "" : "s"}
                  </span>
                </span>
                {tg.totalDrafts > COLLAPSE_THRESHOLD && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(tg.refTableId, tg.totalDrafts)}
                    className={cx(
                      "rounded-sm font-mono text-[10px] text-ink-3 hover:text-ink-2",
                      focusRing,
                    )}
                  >
                    {collapsed_ ? `show all ${tg.totalDrafts}` : "collapse"}
                  </button>
                )}
              </div>

              {/* Author groups + rows */}
              {tg.authorGroups.map((ag) => {
                const visibleForAuthor = visibleByAuthor.get(ag.authorId) ?? [];
                if (visibleForAuthor.length === 0) return null;
                return (
                  <div key={ag.authorId}>
                    <div className="px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-3">
                      {ag.authorName}
                    </div>
                    <ul className="divide-y divide-line">
                      {visibleForAuthor.map((d) => (
                        <DraftRow
                          key={selKey(d)}
                          draft={d}
                          isSelected={selected.has(selKey(d))}
                          canEdit={canEdit}
                          authorName={ag.authorName}
                          onToggle={toggleRow}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}

              {/* "and N more" affordance */}
              {collapsed_ && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => toggleCollapse(tg.refTableId, tg.totalDrafts)}
                  className={cx(
                    "w-full px-4 py-2 text-left font-mono text-[11px] text-ink-3 hover:text-ink-2",
                    focusRing,
                  )}
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
