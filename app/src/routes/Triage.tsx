import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePageTitle } from "../hooks/usePageTitle";
import { Link, useSearchParams } from "react-router-dom";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { useDebouncedValue } from "../lib/use-debounced-value";
import { Button } from "../components/Button";
import { NoTablesYet } from "../components/NoTablesYet";
import { PageHeader } from "../components/PageHeader";
import { IconArrowRight, IconSearch, IconX, IconWand } from "../components/Icons";
import { cx } from "../lib/cx";
import { toast } from "../components/Toast";
import type { MappingRefTable } from "../data";
import {
  useRefTables,
  useDrafts,
  saveDraft,
  discardDraft,
  commit,
  dkey,
  useWorkspaceInfo,
  useCanEdit,
  useStoreLoading,
  useCurrentUser,
  fetchPublishState,
  ApiCodeError,
} from "../store";
import type { Draft, WorkspaceInfo } from "../store";
import { UndoStackProvider, useUndoStack, Chip } from "../components/datagrid";
import { useCreateTableModal } from "../lib/create-table-modal";
import type { AiHint } from "../lib/use-ai-hint";
import { ComboSelect, type ComboSelectHandle } from "../components/ComboSelect";
import { useRefTableValuesPage, type ScanValueRow } from "../lib/use-ref-table-values-page";
import { summarizeOutcomes, type CommitOutcome } from "../lib/commit-outcomes";
import { PublishPreviewDialog, type PublishGroup } from "../components/PublishPreviewDialog";
import { AwaitingReview } from "../components/AwaitingReview";
import { EmptyState as EmptyStateCard } from "../components/EmptyState";
import { apiFetch } from "../api";

/* Triage — per-refTable sectioned inbox. Each ranked refTable gets a section header; only
   the *active* section lazy-fetches its scan_value page via useRefTableValuesPage.
   Switching sections re-keys the hook. Search (?q=) filters server-side; the
   ?filter= URL key roundtrips new/all/mapped. Per-section Rescan button calls
   POST /api/tables/:id/scan, then refetches. */

type Filter = "new" | "all" | "mapped";
type RStatus = "mapped" | "new" | "skipped" | "rejected";

// Keyboard shortcuts surfaced in the toolbar as keycaps (desktop only). "Ranked
// by impact" lives in the page lede, so it's intentionally not repeated here.
const KBD_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓", "move"],
  ["↵", "choose"],
  ["S", "skip"],
  ["G", "suggest"],
  ["⌘↵", "publish"],
];

const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
function flashRow(selector: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.classList.remove("zz-row-flash");
    void el.offsetWidth;
    el.classList.add("zz-row-flash");
    window.setTimeout(() => el.classList.remove("zz-row-flash"), 1700);
  });
}

function TriageLoader() {
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-4 md:px-5 md:pb-5">
      <div className="mb-3 shrink-0 animate-pulse space-y-2">
        <div className="h-2.5 w-16 rounded-sm bg-surface-3" />
        <div className="h-6 w-48 rounded-sm bg-surface-3" />
      </div>
      <div className="flex min-h-0 flex-1 animate-pulse flex-col rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          {[80, 48, 48].map((w, i) => (
            <div key={i} className="h-5 rounded-sm bg-surface-3" style={{ width: w }} />
          ))}
        </div>
        <div className="flex-1 divide-y divide-line overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="h-3 w-20 rounded-sm bg-surface-3" />
              <div className="h-3 w-24 rounded-sm bg-surface-3" />
              <div className="ml-auto flex gap-2">
                <div className="h-5 w-14 rounded-sm bg-surface-3" />
                <div className="h-5 w-10 rounded-sm bg-surface-3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Triage() {
  usePageTitle("Review");
  const refTables = useRefTables();
  const loading = useStoreLoading();
  const create = useCreateTableModal();
  const canEdit = useCanEdit();
  if (loading) return <TriageLoader />;
  if (refTables.length === 0)
    return <NoTablesYet from="triage" onCreateRequested={canEdit ? create.open : undefined} />;
  return (
    <UndoStackProvider scopeKey="triage">
      <TriageInner />
    </UndoStackProvider>
  );
}

function TriageInner() {
  const refTables = useRefTables();
  const allDrafts = useDrafts();
  const undo = useUndoStack();
  const wsInfo = useWorkspaceInfo();
  const canEdit = useCanEdit();
  const me = useCurrentUser();

  // URL ?filter= and ?q= state — both round-trip.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = ((): Filter => {
    // Review is the "to map" queue; "mapped" is the per-table peek. ("all" retired.)
    return searchParams.get("filter") === "mapped" ? "mapped" : "new";
  })();
  const [filter, setFilterBase] = useState<Filter>(initialFilter);
  const [searchText, setSearchTextBase] = useState<string>(searchParams.get("q") ?? "");

  const setFilter = useCallback(
    (f: Filter) => {
      setFilterBase(f);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (f !== "new") next.set("filter", f);
          else next.delete("filter");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const setSearchText = useCallback(
    (q: string) => {
      setSearchTextBase(q);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (q) next.set("q", q);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [cursor, setCursor] = useState<{ refTableId: string; raw: string } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const reportDraftError = useCallback((action: string, err: unknown) => {
    setDraftError(
      err instanceof Error ? `Couldn't ${action}: ${err.message}` : `Couldn't ${action}.`,
    );
  }, []);

  const refTableById = useMemo(() => new Map(refTables.map((d) => [d.id, d])), [refTables]);

  // Tables with unmapped values, ranked by impact (newCount × log10(rows)) — the
  // rail's "to map" group. Tables with nothing left form the "clean" group.
  const toMap = useMemo(
    () =>
      [...refTables]
        .filter((d) => d.counts.newCount > 0)
        .map((d) => ({ d, score: d.counts.newCount * Math.log10(Math.max(10, d.rows)) }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.d),
    [refTables],
  );
  const cleanTables = useMemo(() => refTables.filter((d) => d.counts.newCount === 0), [refTables]);

  // Drafts other people mapped, waiting on my sign-off — the rail's "Approve" item.
  const awaitingCount = useMemo(
    () =>
      Object.values(allDrafts).filter((d) => d.status === "mapped" && d.user.id !== me?.id).length,
    [allDrafts, me?.id],
  );

  // Which pane the main area shows: a specific table, or the approve inbox.
  const [view, setView] = useState<{ kind: "table"; id: string } | { kind: "approve" }>(() => {
    const first = toMap[0] ?? refTables[0];
    return first ? { kind: "table", id: first.id } : { kind: "approve" };
  });
  // On phones the rail and detail can't sit side by side — drill down instead:
  // the rail is the first screen, selecting a table slides to its detail. On
  // md+ both panes are always visible (Tailwind md: overrides), so this flag is
  // a no-op there.
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const openTable = useCallback((id: string) => {
    setView({ kind: "table", id });
    setMobileShowDetail(true);
  }, []);
  const openApprove = useCallback(() => {
    setView({ kind: "approve" });
    setMobileShowDetail(true);
  }, []);
  // Keep the selected table valid as data changes.
  useEffect(() => {
    if (view.kind === "table" && !refTableById.has(view.id)) {
      const next = toMap[0] ?? refTables[0];
      if (next) setView({ kind: "table", id: next.id });
    }
  }, [view, refTableById, toMap, refTables]);

  const activeDim = view.kind === "table" ? (refTableById.get(view.id) ?? null) : null;
  // Debounce the query that re-keys the fetch hook so typing doesn't fire a
  // request + setItems([]) per keystroke; the input itself stays immediate (#158).
  const debouncedSearch = useDebouncedValue(searchText, 250);
  const valuesPage = useRefTableValuesPage({
    refTableId: activeDim?.id ?? null,
    filter,
    q: debouncedSearch || undefined,
  });

  // Focus-refetch: when the user returns to the tab, reload the active section
  // so other curators' edits show up.
  useEffect(() => {
    const onFocus = () => valuesPage.refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [valuesPage]);

  // ── action handlers (per refTable) ────────────────────────────────────────────
  const keyForLabelIn = (refTableId: string, label: string) => {
    const d = refTableById.get(refTableId);
    return (
      d?.record.find((c) => c.label === label)?.key ??
      label.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    );
  };
  const stageMapCross = (refTableId: string, raw: string, label: string) => {
    const prev = allDrafts[dkey(refTableId, raw)];
    undo.push({
      label: `match "${raw}" → ${label}`,
      surface: "Review",
      apply: () => saveDraft(refTableId, raw, "mapped", label, keyForLabelIn(refTableId, label)),
      inverse: () =>
        prev && prev.status !== "rejected"
          ? saveDraft(refTableId, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(refTableId, raw),
    });
    return saveDraft(refTableId, raw, "mapped", label, keyForLabelIn(refTableId, label));
  };
  const skipCross = (refTableId: string, raw: string) => {
    if (allDrafts[dkey(refTableId, raw)]?.status === "rejected") return;
    const prev = allDrafts[dkey(refTableId, raw)];
    undo.push({
      label: `skip "${raw}"`,
      surface: "Review",
      apply: () => saveDraft(refTableId, raw, "skipped", null, null),
      inverse: () =>
        prev && prev.status !== "rejected"
          ? saveDraft(refTableId, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(refTableId, raw),
    });
    saveDraft(refTableId, raw, "skipped", null, null).catch((err) =>
      reportDraftError(`skip "${raw}"`, err),
    );
    flashRow(`[data-row-key="${attrEsc(`${refTableId}::${raw}`)}"]`);
    advanceCrossNext(refTableId, raw);
  };
  const pickCross = (refTableId: string, raw: string, label: string) => {
    if (allDrafts[dkey(refTableId, raw)]?.status === "rejected") return;
    stageMapCross(refTableId, raw, label).catch((err) =>
      reportDraftError(`map "${raw}" → ${label}`, err),
    );
    flashRow(`[data-row-key="${attrEsc(`${refTableId}::${raw}`)}"]`);
    advanceCrossNext(refTableId, raw);
  };
  // Re-stage a rejected draft: call saveDraft which clears rejected_reason/rejected_by
  // on the server (the ON CONFLICT branch resets those columns to NULL).
  const restageCross = (refTableId: string, raw: string) => {
    const prev = allDrafts[dkey(refTableId, raw)];
    if (!prev || prev.status !== "rejected") return;
    void Promise.resolve(
      saveDraft(
        refTableId,
        raw,
        prev.targetLabel ? "mapped" : "skipped",
        prev.targetLabel,
        prev.targetKey,
      ),
    ).catch((err) => reportDraftError(`re-stage "${raw}"`, err));
  };
  const discardCross = (refTableId: string, raw: string) => {
    const prev = allDrafts[dkey(refTableId, raw)];
    if (!prev) return;
    undo.push({
      label: `discard "${raw}"`,
      surface: "Review",
      apply: () => discardDraft(refTableId, raw),
      // Rejected drafts cannot be re-saved via saveDraft; discard is the safe fallback.
      inverse: () =>
        prev.status !== "rejected"
          ? saveDraft(refTableId, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(refTableId, raw),
    });
    discardDraft(refTableId, raw).catch((err) => reportDraftError(`discard "${raw}"`, err));
  };
  // Advance within the active section's loaded items, wrapping to the next
  // unmapped raw value.
  const advanceCrossNext = useCallback(
    (_fromRefTableId: string | null, fromRaw: string | null) => {
      const rows = valuesPage.items;
      if (rows.length === 0 || !activeDim) return;
      const idx = fromRaw ? rows.findIndex((r) => r.raw === fromRaw) : -1;
      for (let i = 1; i <= rows.length; i++) {
        const j = ((idx < 0 ? -1 : idx) + i + rows.length) % rows.length;
        const r = rows[j];
        const draft = allDrafts[dkey(activeDim.id, r.raw)];
        const rawStatus = draft ? draft.status : r.isMapped ? "mapped" : "new";
        // Rejected drafts are skipped for cursor advance — the row is visible and
        // actionable (Re-stage / Discard), but not a "new" item to navigate through.
        const status: RStatus = rawStatus === "rejected" ? "skipped" : rawStatus;
        if (status === "new") {
          setCursor({ refTableId: activeDim.id, raw: r.raw });
          return;
        }
      }
    },
    [valuesPage.items, activeDim, allDrafts],
  );

  // staged drafts across ALL refTables — drives the commit footer
  // Cannot inspect refTable values here (they're not loaded eagerly anymore); accept
  // any "mapped" draft as staged. The server reconciles on commit.
  const stagedAllDrafts = useMemo(
    () => Object.values(allDrafts).filter((d) => d.status === "mapped"),
    [allDrafts],
  );
  const approveAndCommitAll = async (groups: PublishGroup[]) => {
    setCommitError(null);
    if (groups.length === 0) return;
    setCommitting(true);
    try {
      const outcomes: CommitOutcome[] = [];
      for (const g of groups) {
        try {
          const res = await commit(
            g.refTableId,
            g.drafts.map((d) => d.raw),
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
          const msg = err instanceof Error ? err.message : "unknown error";
          outcomes.push({
            refTableId: g.refTableId,
            refTableName: g.refTableName,
            committed: 0,
            rowsRecovered: 0,
            error: isSecondPublisher
              ? "These drafts need a second publisher — another editor has to press Publish (workspace setting: Four eyes on publish)."
              : msg,
          });
        }
      }
      const summary = summarizeOutcomes(outcomes);
      if (summary.ok) {
        if (summary.committed > 0) toast(summary.message);
      } else {
        setCommitError(summary.message);
      }
    } finally {
      setCommitting(false);
    }
  };

  const [preview, setPreview] = useState<PublishGroup[] | null>(null);

  const openPublishPreview = async () => {
    const refTableIds = [...new Set(stagedAllDrafts.map((d) => d.refTableId))];
    if (refTableIds.length === 0) return;
    try {
      const states = await Promise.all(refTableIds.map((id) => fetchPublishState(id)));
      setPreview(
        refTableIds.map((id, i) => ({
          refTableId: id,
          refTableName: refTables.find((d) => d.id === id)?.refTable ?? id,
          nextVersion: states[i].version + 1,
          drafts: stagedAllDrafts.filter((d) => d.refTableId === id),
          changedKeys: states[i].changedKeys,
        })),
      );
    } catch (err) {
      setCommitError(
        err instanceof Error ? err.message : "Could not load the publish preview — try again.",
      );
    }
  };

  const triggerRescan = useCallback(async (refTableId: string) => {
    const r = await apiFetch(`/tables/${encodeURIComponent(refTableId)}/scan`, {
      method: "POST",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }, []);
  const [rescanning, setRescanning] = useState(false);

  // ── render ───────────────────────────────────────────────────────────────
  const totalNew = useMemo(() => toMap.reduce((n, d) => n + d.counts.newCount, 0), [toMap]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-4 md:px-5 md:pb-5">
        <div className="mb-3 shrink-0">
          <PageHeader
            kicker="WORKFLOW"
            title={
              <>
                Review{" "}
                <span className="font-mono text-[14px] text-ink-3">
                  · {totalNew} to map across {toMap.length} table
                  {toMap.length === 1 ? "" : "s"}
                </span>
              </>
            }
            lede="Pick a table on the left, choose the record each value belongs to, then publish."
          />
        </div>

        <div
          className="zz-rise flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface md:flex-row"
          style={{ animationDelay: "150ms" }}
        >
          {/* Left rail — desktop: always visible. Mobile: the first screen,
              hidden once a table is opened (drill-down). */}
          <div
            className={cx(
              "w-full flex-col overflow-y-auto bg-surface md:w-60 md:shrink-0 md:border-r md:border-line",
              mobileShowDetail ? "hidden md:flex" : "flex",
            )}
          >
            <TableRail
              toMap={toMap}
              clean={cleanTables}
              totalToMap={totalNew}
              activeId={view.kind === "table" ? view.id : null}
              approveCount={awaitingCount}
              approveActive={view.kind === "approve"}
              onSelectTable={openTable}
              onSelectApprove={openApprove}
            />
          </div>

          {/* Main pane — desktop: always. Mobile: only once a table is opened. */}
          <div
            className={cx("min-w-0 flex-1 flex-col", mobileShowDetail ? "flex" : "hidden md:flex")}
          >
            {/* Mobile-only back to the table list. */}
            <button
              type="button"
              onClick={() => setMobileShowDetail(false)}
              className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2.5 text-left font-mono text-[12px] text-ink-2 transition-colors hover:text-ink md:hidden"
            >
              ‹ All tables
            </button>

            {view.kind === "table" && activeDim && (
              <div className="flex shrink-0 items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2.5 md:px-4">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-sm border border-line-2 bg-bg px-2.5 py-1.5 text-ink-3 transition-colors focus-within:border-accent md:max-w-md">
                  <IconSearch className="h-3.5 w-3.5 shrink-0" />
                  <input
                    type="search"
                    placeholder="Search values…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    className="w-full min-w-0 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:appearance-none"
                  />
                  {searchText && (
                    <button
                      type="button"
                      onClick={() => setSearchText("")}
                      aria-label="Clear search"
                      className="shrink-0 text-ink-3 transition-colors hover:text-ink"
                    >
                      <IconX className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="ml-auto hidden shrink-0 items-center gap-2.5 lg:flex">
                  {KBD_HINTS.map(([keys, label]) => (
                    <span key={label} className="flex items-center gap-1 text-ink-3">
                      <kbd className="rounded-sm border border-line bg-surface-2 px-1 py-0.5 font-mono text-[10px] leading-none text-ink-2">
                        {keys}
                      </kbd>
                      <span className="font-mono text-[10px] uppercase tracking-wider">
                        {label}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
              {view.kind === "approve" ? (
                <div className="p-3">
                  <AwaitingReview />
                </div>
              ) : toMap.length === 0 && awaitingCount === 0 && filter !== "mapped" ? (
                // Nothing to map anywhere and nothing to approve — the settled state.
                <div className="p-3">
                  <EmptyState filter="new" onSwitchToNew={() => setFilter("new")} />
                </div>
              ) : activeDim ? (
                <MapPane
                  key={activeDim.id}
                  refTable={activeDim}
                  page={valuesPage}
                  drafts={allDrafts}
                  canEdit={canEdit}
                  cursor={cursor}
                  setCursor={setCursor}
                  filter={filter}
                  setFilter={setFilter}
                  onSkip={(raw) => skipCross(activeDim.id, raw)}
                  onPick={(raw, label) => pickCross(activeDim.id, raw, label)}
                  onRestage={(raw) => restageCross(activeDim.id, raw)}
                  onCommitAll={() => void openPublishPreview()}
                  rescanning={rescanning}
                  onRescan={async () => {
                    setRescanning(true);
                    try {
                      await triggerRescan(activeDim.id);
                      valuesPage.refetch();
                      toast("Re-scan complete");
                    } catch (err) {
                      toast(
                        err instanceof Error ? `Re-scan failed: ${err.message}` : "Re-scan failed",
                        "error",
                      );
                    } finally {
                      setRescanning(false);
                    }
                  }}
                />
              ) : (
                <div className="p-3">
                  <EmptyState filter={filter} onSwitchToNew={() => setFilter("new")} />
                </div>
              )}
            </div>

            <CrossRefTableFooter
              refTableById={refTableById}
              stagedDrafts={stagedAllDrafts}
              discard={discardCross}
              commitAll={() => void openPublishPreview()}
              committing={committing}
              commitError={commitError}
              setCommitError={setCommitError}
              draftError={draftError}
              setDraftError={setDraftError}
              undo={undo}
              wsInfo={wsInfo}
              canEdit={canEdit}
            />
          </div>
        </div>
      </div>
      {preview && (
        <PublishPreviewDialog
          open
          groups={preview}
          publishing={committing}
          onDiscardDraft={(d) => {
            void discardDraft(d.refTableId, d.raw);
            setPreview((p) => {
              const next =
                p
                  ?.map((g) =>
                    g.refTableId === d.refTableId
                      ? { ...g, drafts: g.drafts.filter((x) => x.raw !== d.raw) }
                      : g,
                  )
                  .filter((g) => g.drafts.length > 0 || g.changedKeys.length > 0) ?? null;
              return next && next.length > 0 ? next : null;
            });
          }}
          onConfirm={() => {
            const groups = preview ?? [];
            void approveAndCommitAll(groups).then(() => setPreview(null));
          }}
          onCancel={() => setPreview(null)}
        />
      )}
    </>
  );
}

function EmptyState({ filter, onSwitchToNew }: { filter: Filter; onSwitchToNew: () => void }) {
  const nav = useNavLinks();
  if (filter === "new")
    return (
      <EmptyStateCard
        glyph="🎉"
        title="Nothing left to review."
        secondary={
          <Link to={nav.tables} className="text-accent hover:underline">
            Curate records in Tables
          </Link>
        }
      />
    );
  if (filter === "mapped")
    return (
      <EmptyStateCard
        glyph="🗂️"
        title="Nothing has been mapped yet."
        secondary={
          <button onClick={onSwitchToNew} className="text-accent hover:underline">
            View needs review →
          </button>
        }
      />
    );
  return <EmptyStateCard glyph="📋" title="No tables yet." />;
}

// ── TableRail — the progress ledger you work from ─────────────────────────────
function railProgress(d: MappingRefTable): number {
  const total = Math.max(1, d.counts.totalDistinct);
  return Math.round(((total - d.counts.newCount) / total) * 100);
}

function RailRow({
  name,
  count,
  progress,
  active,
  clean,
  onClick,
}: {
  name: string;
  count: number;
  progress: number;
  active: boolean;
  clean?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cx(
        "block w-full border-l-2 px-3.5 py-2.5 text-left transition-colors",
        active
          ? "border-accent bg-surface-2"
          : "border-transparent hover:border-line-2 hover:bg-hover",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cx(
            "min-w-0 truncate font-display text-[13px]",
            clean ? "font-medium text-ink-2" : "font-semibold text-ink",
          )}
        >
          {name}
        </span>
        <span
          className={cx(
            "shrink-0 font-mono text-[11px] font-semibold tabular-nums",
            clean ? "text-ok" : "text-accent",
          )}
        >
          {clean ? "✓" : count}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-pill bg-surface-3">
        <span
          className="block h-full rounded-pill bg-ok transition-[width]"
          style={{ width: `${progress}%` }}
        />
      </div>
    </button>
  );
}

interface TableRailProps {
  toMap: MappingRefTable[];
  clean: MappingRefTable[];
  totalToMap: number;
  activeId: string | null;
  approveCount: number;
  approveActive: boolean;
  onSelectTable: (id: string) => void;
  onSelectApprove: () => void;
}

function TableRail(p: TableRailProps) {
  return (
    <div className="flex min-h-full w-full flex-col">
      <div className="px-3.5 pb-1.5 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        To map · {p.totalToMap} left
      </div>
      {p.toMap.length === 0 ? (
        <div className="px-3.5 py-2 font-mono text-[11px] text-ink-3">All caught up 🎉</div>
      ) : (
        p.toMap.map((d) => (
          <RailRow
            key={d.id}
            name={d.refTable}
            count={d.counts.newCount}
            progress={railProgress(d)}
            active={p.activeId === d.id}
            onClick={() => p.onSelectTable(d.id)}
          />
        ))
      )}

      {p.clean.length > 0 && (
        <>
          <div className="px-3.5 pb-1.5 pt-4 font-mono text-[10px] uppercase tracking-wider text-ink-3">
            Clean · nothing to do
          </div>
          {p.clean.map((d) => (
            <RailRow
              key={d.id}
              name={d.refTable}
              count={0}
              progress={100}
              clean
              active={p.activeId === d.id}
              onClick={() => p.onSelectTable(d.id)}
            />
          ))}
        </>
      )}

      {p.approveCount > 0 && (
        <div className="mt-auto border-t border-line pt-1">
          <button
            type="button"
            onClick={p.onSelectApprove}
            aria-current={p.approveActive}
            className={cx(
              "flex w-full items-center justify-between gap-2 border-l-2 px-3.5 py-3 text-left transition-colors",
              p.approveActive
                ? "border-accent bg-surface-2"
                : "border-transparent hover:border-line-2 hover:bg-hover",
            )}
          >
            <span className="truncate font-display text-[13px] font-semibold text-ink">
              Approve teammates’ work
            </span>
            <span className="shrink-0 rounded-pill bg-accent-soft px-1.5 font-mono text-[11px] font-semibold text-accent tabular-nums">
              {p.approveCount}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── MapPane — the selected table's values (header + list + infinite scroll) ────
interface MapPaneProps {
  refTable: MappingRefTable;
  page: ReturnType<typeof useRefTableValuesPage>;
  drafts: Record<string, Draft>;
  canEdit: boolean;
  cursor: { refTableId: string; raw: string } | null;
  setCursor: (c: { refTableId: string; raw: string } | null) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
  onSkip: (raw: string) => void;
  onPick: (raw: string, label: string) => void;
  onRestage: (raw: string) => void;
  onCommitAll: () => void;
  rescanning: boolean;
  onRescan: () => void;
}

function MapPane(p: MapPaneProps) {
  const { refTable } = p;
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Infinite scroll — sentinel at the bottom of the loaded list calls loadMore.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) p.page.loadMore();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [p.page]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
            {p.filter === "mapped" ? "Already mapped" : "Map these values"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-display text-[16px] font-semibold text-ink">
              {refTable.refTable}
            </span>
            {p.filter === "mapped" ? (
              // Review/fix an already-mapped value, then get back to the queue.
              <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                <button
                  type="button"
                  onClick={() => p.setFilter("new")}
                  className="text-accent transition-colors hover:underline"
                >
                  ‹ {refTable.counts.newCount} to map
                </button>
                <span className="text-ink-3">· showing {refTable.counts.mappedCount} mapped</span>
              </span>
            ) : (
              <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                <span className="text-ink-3">
                  {refTable.counts.newCount} to map ·{" "}
                  {refTable.counts.unmappedRowsTotal.toLocaleString()} rows
                </span>
                {refTable.counts.mappedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => p.setFilter("mapped")}
                    className="text-ink-3 transition-colors hover:text-ink"
                    title="Review or fix values you've already mapped"
                  >
                    · {refTable.counts.mappedCount} mapped ✓
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
        {refTable.counts.scannedAt && p.canEdit && (
          <Button variant="ghost" size="sm" loading={p.rescanning} onClick={p.onRescan}>
            Re-scan
          </Button>
        )}
      </div>
      <RefTableSectionBody
        refTable={refTable}
        page={p.page}
        drafts={p.drafts}
        canEdit={p.canEdit}
        cursor={p.cursor}
        setCursor={p.setCursor}
        onSkip={p.onSkip}
        onPick={p.onPick}
        onRestage={p.onRestage}
        onCommitAll={p.onCommitAll}
        sentinelRef={sentinelRef}
      />
    </>
  );
}

// ── on-demand AI suggestion — offers, never decides ───────────────────────────
type OfferState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "offer"; hint: AiHint }
  | { kind: "none" }
  | { kind: "error" };

interface SuggestHandle {
  suggest: () => void;
}

const SuggestOffer = forwardRef<
  SuggestHandle,
  { refTableId: string; raw: string; onUse: (label: string) => void }
>(function SuggestOffer({ refTableId, raw, onUse }, ref) {
  const [state, setState] = useState<OfferState>({ kind: "idle" });

  const fetchHint = async () => {
    setState({ kind: "loading" });
    try {
      const qs = new URLSearchParams({ refTableId, raw });
      const res = await apiFetch(`/triage/ai-hint?${qs.toString()}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const hint = (await res.json()) as AiHint;
      setState(hint.suggestion ? { kind: "offer", hint } : { kind: "none" });
    } catch {
      setState({ kind: "error" });
    }
  };

  // Keyboard "G" on the row opens the same on-demand suggestion.
  useImperativeHandle(ref, () => ({ suggest: () => void fetchHint() }));

  if (state.kind === "idle" || state.kind === "error") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void fetchHint();
        }}
        className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 font-mono text-[11px] text-ink-3 transition-colors hover:bg-hover hover:text-accent"
      >
        <IconWand className="h-3.5 w-3.5" />
        {state.kind === "error" ? "Try AI again" : "Suggest with AI"}
      </button>
    );
  }

  if (state.kind === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5 px-1.5 py-1 font-mono text-[11px] text-ink-3">
        <IconWand className="h-3.5 w-3.5 animate-pulse" />
        Thinking…
      </span>
    );
  }

  if (state.kind === "none") {
    return (
      <span className="inline-flex items-center gap-2 px-1.5 py-1 font-mono text-[11px] text-ink-3">
        AI isn’t sure on this one — your call.
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setState({ kind: "idle" });
          }}
          className="text-ink-3 underline decoration-dotted hover:text-ink"
        >
          dismiss
        </button>
      </span>
    );
  }

  // offer
  const { hint } = state;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1 font-mono text-[11px] text-ink-2">
      <IconWand className="h-3.5 w-3.5 shrink-0 text-accent" />
      <span>
        AI suggests <span className="font-display font-medium text-ink">{hint.suggestion}</span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUse(hint.suggestion!);
        }}
        className="rounded-sm bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-ink transition-opacity hover:opacity-90"
      >
        Use it
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setState({ kind: "idle" });
        }}
        className="text-ink-3 underline decoration-dotted hover:text-ink"
      >
        dismiss
      </button>
      {hint.reasoning && (
        <span
          title={hint.reasoning}
          className="inline-grid h-3.5 w-3.5 cursor-help place-items-center rounded-full bg-surface-3 text-[8px] text-ink-3"
        >
          ?
        </span>
      )}
    </span>
  );
});

interface RefTableSectionBodyProps {
  refTable: MappingRefTable;
  page: ReturnType<typeof useRefTableValuesPage>;
  drafts: Record<string, Draft>;
  canEdit: boolean;
  cursor: { refTableId: string; raw: string } | null;
  setCursor: (c: { refTableId: string; raw: string } | null) => void;
  onSkip: (raw: string) => void;
  onPick: (raw: string, label: string) => void;
  onRestage: (raw: string) => void;
  onCommitAll: () => void;
  sentinelRef: React.MutableRefObject<HTMLDivElement | null>;
}

export function RefTableSectionBody(p: RefTableSectionBodyProps) {
  const options = useMemo(() => p.refTable.record.map((c) => c.label), [p.refTable.record]);
  // Handles to each row's record picker + suggestion, so the keyboard can drive
  // the row: Enter/M opens the picker, G asks AI for a suggestion.
  const comboRefs = useRef<Map<string, ComboSelectHandle | null>>(new Map());
  const suggestRefs = useRef<Map<string, SuggestHandle | null>>(new Map());
  const me = useCurrentUser();

  const rowStatus = (
    r: ScanValueRow,
  ): { status: RStatus; target: string | null; rejectedReason: string | null } => {
    const draft = p.drafts[dkey(p.refTable.id, r.raw)];
    if (draft)
      return {
        status: draft.status,
        target: draft.targetLabel,
        rejectedReason: draft.rejectedReason,
      };
    return {
      status: r.isMapped ? "mapped" : "new",
      target: r.mappedLabel,
      rejectedReason: null,
    };
  };

  const focus = (raw: string) => p.setCursor({ refTableId: p.refTable.id, raw });

  // Arrow keys have to move DOM focus too, not just the cursor: the keydown
  // handler lives on each row, so leaving focus behind means every further press
  // recomputes from the old row and the selection sticks after one move (#199).
  // The row's own onFocus sets the cursor, so this also scrolls it into view.
  const moveTo = (raw: string) => {
    focus(raw);
    document
      .querySelector<HTMLLIElement>(`[data-row-key="${CSS.escape(`${p.refTable.id}::${raw}`)}"]`)
      ?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>, raw: string) => {
    if (p.canEdit && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      p.onCommitAll();
      return;
    }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!plain) return;
    const k = e.key.toLowerCase();
    // Keyboard actions are blocked on rejected rows — the only valid actions
    // there are Re-stage (button) and Discard (button).
    const isRejected = p.drafts[dkey(p.refTable.id, raw)]?.status === "rejected";
    if (p.canEdit && k === "s" && !isRejected) {
      e.preventDefault();
      p.onSkip(raw);
    } else if (p.canEdit && (k === "m" || k === "enter") && !isRejected) {
      // Open this row's record picker — choosing is the primary action.
      e.preventDefault();
      comboRefs.current.get(raw)?.open();
    } else if (p.canEdit && k === "g" && !isRejected) {
      // Ask AI for a suggestion on this row — on demand, never automatic.
      e.preventDefault();
      suggestRefs.current.get(raw)?.suggest();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = p.page.items.findIndex((x) => x.raw === raw);
      const next = p.page.items[Math.min(p.page.items.length - 1, idx + 1)];
      if (next) moveTo(next.raw);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const idx = p.page.items.findIndex((x) => x.raw === raw);
      const prev = p.page.items[Math.max(0, idx - 1)];
      if (prev) moveTo(prev.raw);
    }
  };

  if (p.page.error) {
    return (
      <div className="border-t border-line px-4 py-6 text-center font-mono text-[12px] text-danger">
        Failed to load values: {p.page.error}{" "}
        <button onClick={() => p.page.refetch()} className="text-accent hover:underline">
          retry
        </button>
      </div>
    );
  }

  if (!p.page.loading && p.page.items.length === 0) {
    return (
      <div className="border-t border-line px-4 py-6 text-center font-mono text-[12px] text-ink-3">
        no values in this view
      </div>
    );
  }

  return (
    <div className="border-t border-line">
      <ul className="divide-y divide-line">
        {p.page.items.map((r) => {
          const { status, target, rejectedReason } = rowStatus(r);
          const isCursor =
            p.cursor && p.cursor.refTableId === p.refTable.id && p.cursor.raw === r.raw;
          return (
            <li
              key={r.raw}
              tabIndex={0}
              role="row"
              data-row-key={`${p.refTable.id}::${r.raw}`}
              onFocus={() => focus(r.raw)}
              onClick={() => focus(r.raw)}
              onKeyDown={(e) => onKeyDown(e, r.raw)}
              className={cx(
                "flex flex-col gap-1 border-l-2 px-4 py-2.5 outline-none transition-colors",
                // Same selected treatment as Map values (MapValueRow) — a
                // full-strength wash plus an accent bar, so the current row
                // reads at a glance (#200).
                isCursor ? "border-l-accent bg-accent-wash" : "border-l-transparent hover:bg-hover",
              )}
            >
              {/* Desktop: fixed 3-column grid (value | picker | status) so every
                  "Choose record" control lines up. Mobile: stack vertically with
                  a full-width picker. */}
              <div className="flex flex-col gap-2 md:grid md:grid-cols-[minmax(0,1fr)_15rem_5.5rem] md:items-center md:gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[13px] text-ink">{r.raw}</span>
                  <span className="block truncate font-mono text-[10px] text-ink-3 tabular-nums">
                    {r.totalRows.toLocaleString()} rows
                    {r.occurrences[0] && ` · ${r.occurrences[0].table}.${r.occurrences[0].column}`}
                    {r.occurrences.length > 1 && ` +${r.occurrences.length - 1}`}
                  </span>
                </span>

                {/* col 2 — the record picker (or the sent-back note) */}
                {status === "rejected" ? (
                  <span className="min-w-0">
                    <span
                      className="inline-block max-w-full truncate rounded-sm bg-danger-soft px-1.5 py-0.5 font-mono text-[10px] text-danger"
                      title={rejectedReason ?? undefined}
                    >
                      Sent back
                      {rejectedReason
                        ? `: ${rejectedReason.slice(0, 60)}${rejectedReason.length > 60 ? "…" : ""}`
                        : ""}
                    </span>
                  </span>
                ) : p.canEdit ? (
                  <ComboSelect
                    ref={(h) => {
                      comboRefs.current.set(r.raw, h);
                    }}
                    options={options}
                    value={target}
                    placeholder="Choose record"
                    ariaLabel={`Choose record for ${r.raw}`}
                    onPick={(t) => p.onPick(r.raw, t)}
                  />
                ) : (
                  <span className="truncate font-display text-[13px] text-ink">
                    {target ?? <span className="font-mono text-[12px] text-ink-3">—</span>}
                  </span>
                )}

                {/* col 3 — status / skip / re-stage, right-aligned */}
                <span className="flex items-center justify-end gap-2">
                  {status === "rejected" ? (
                    p.canEdit &&
                    p.drafts[dkey(p.refTable.id, r.raw)]?.user.id === me?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onRestage(r.raw);
                        }}
                      >
                        Re-stage
                      </Button>
                    )
                  ) : status === "mapped" ? (
                    <Chip label="Mapped" bucket="chip-1" dot />
                  ) : status === "skipped" ? (
                    <Chip label="Skipped" bucket="chip-5" />
                  ) : status === "new" && p.canEdit ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        p.onSkip(r.raw);
                      }}
                      className="rounded-sm px-1.5 py-1 font-mono text-[11px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                    >
                      Skip
                    </button>
                  ) : null}
                </span>
              </div>
              {status === "new" && p.canEdit && (
                <div className="pl-1 pt-0.5">
                  <SuggestOffer
                    ref={(h) => {
                      suggestRefs.current.set(r.raw, h);
                    }}
                    refTableId={p.refTable.id}
                    raw={r.raw}
                    onUse={(label) => p.onPick(r.raw, label)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div ref={p.sentinelRef} />
      {p.page.loading && (
        <div className="px-4 py-3 text-center font-mono text-[11px] text-ink-3">loading…</div>
      )}
      {!p.page.hasMore && p.page.items.length > 0 && (
        <div className="px-4 py-3 text-center font-mono text-[10px] text-ink-3">end of list</div>
      )}
    </div>
  );
}

// ── footer ───────────────────────────────────────────────────────────────────
function ErrorBanner({
  message,
  onDismiss,
  retry,
}: {
  message: string;
  onDismiss: () => void;
  retry?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
      <span>{message}</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        {retry && (
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

interface FooterProps {
  refTableById: Map<string, MappingRefTable>;
  stagedDrafts: Draft[];
  discard: (refTableId: string, raw: string) => void;
  commitAll: () => void;
  committing: boolean;
  commitError: string | null;
  setCommitError: (e: string | null) => void;
  draftError: string | null;
  setDraftError: (e: string | null) => void;
  undo: ReturnType<typeof useUndoStack>;
  wsInfo: WorkspaceInfo | null;
  canEdit: boolean;
}

function CrossRefTableFooter(p: FooterProps) {
  const [review, setReview] = useState(false);
  const stagedCount = p.stagedDrafts.length;
  const grouped = useMemo(() => {
    const byDim = new Map<string, Draft[]>();
    for (const d of p.stagedDrafts) {
      const arr = byDim.get(d.refTableId) ?? [];
      arr.push(d);
      byDim.set(d.refTableId, arr);
    }
    const out: Array<{
      refTableId: string;
      refTableName: string;
      groups: Array<{ target: string; drafts: Draft[] }>;
    }> = [];
    for (const [refTableId, drafts] of byDim) {
      const refTable = p.refTableById.get(refTableId);
      const byTarget = new Map<string, Draft[]>();
      for (const d of drafts) {
        const t = d.targetLabel ?? "—";
        const arr = byTarget.get(t) ?? [];
        arr.push(d);
        byTarget.set(t, arr);
      }
      out.push({
        refTableId,
        refTableName: refTable?.refTable ?? refTableId,
        groups: [...byTarget.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([target, drafts]) => ({ target, drafts })),
      });
    }
    return out.sort((a, b) => {
      const aN = a.groups.reduce((n, g) => n + g.drafts.length, 0);
      const bN = b.groups.reduce((n, g) => n + g.drafts.length, 0);
      return bN - aN;
    });
  }, [p.stagedDrafts, p.refTableById]);

  return (
    <div className="sticky bottom-0 z-10 border-t border-line bg-surface">
      {(p.commitError || p.draftError) && (
        <ErrorBanner
          message={(p.commitError ?? p.draftError)!}
          onDismiss={p.commitError ? () => p.setCommitError(null) : () => p.setDraftError(null)}
          retry={p.commitError && p.canEdit ? () => p.commitAll() : undefined}
        />
      )}
      {review && stagedCount > 0 && (
        <div className="border-b border-line">
          <div className="px-4 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">
            Ready to publish · {stagedCount} across {grouped.length} table
            {grouped.length === 1 ? "" : "s"}
          </div>
          <div className="mt-1 max-h-72 overflow-y-auto">
            {grouped.map((g) => (
              <div key={g.refTableId} className="border-t border-line first:border-t-0">
                <div className="flex items-center gap-2 px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-2">
                  <Chip label={g.refTableName} bucket="chip-3" />
                  <span className="tabular-nums">
                    {g.groups.reduce((n, x) => n + x.drafts.length, 0)} drafts
                  </span>
                </div>
                {g.groups.map((tg) => (
                  <div key={tg.target} className="px-4 pb-1.5">
                    <div className="flex items-center gap-2 font-mono text-[11px]">
                      <IconArrowRight className="h-3 w-3 shrink-0 text-ink-3" />
                      <span className="truncate text-accent">{tg.target}</span>
                      <span className="text-ink-3 tabular-nums">({tg.drafts.length})</span>
                    </div>
                    <ul className="mt-1 divide-y divide-line">
                      {tg.drafts.map((d) => (
                        <li
                          key={`${d.refTableId}::${d.raw}`}
                          className="zz-rise flex items-center gap-3 py-1 pl-5 font-mono text-[11px]"
                          style={{ animationDuration: "var(--dur-slide)" }}
                        >
                          <span
                            className="grid h-5 w-5 shrink-0 place-items-center rounded-pill bg-surface-3 text-[9px] text-ink-2"
                            title={d.user.name}
                          >
                            {d.user.initials}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-ink">{d.raw}</span>
                          {d.source === "ai" && (
                            <span className="flex shrink-0 items-center gap-1">
                              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold text-ink-2">
                                AI
                              </span>
                              {d.confidence && (
                                <span
                                  className={cx(
                                    "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                                    d.confidence === "high" && "bg-committed-soft text-committed",
                                    d.confidence === "medium" && "bg-staged-soft text-staged",
                                    d.confidence === "low" && "bg-surface-2 text-ink-3",
                                  )}
                                  title={d.reasoning ?? undefined}
                                >
                                  {d.confidence.charAt(0).toUpperCase() + d.confidence.slice(1)}
                                </span>
                              )}
                              {d.reasoning && (
                                <span
                                  title={d.reasoning}
                                  className="inline-grid h-3.5 w-3.5 cursor-help place-items-center rounded-full bg-surface-3 text-[8px] text-ink-3"
                                >
                                  ?
                                </span>
                              )}
                            </span>
                          )}
                          <span className="shrink-0 text-ink-2 tabular-nums">{d.at}</span>
                          {p.canEdit && (
                            <button
                              type="button"
                              onClick={() => p.discard(d.refTableId, d.raw)}
                              title="Discard this draft"
                              aria-label="Discard draft"
                              className="shrink-0 text-ink-3 transition-colors hover:text-danger"
                            >
                              <IconX className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <span className="font-mono text-[11px] text-ink-2">
          {stagedCount > 0 ? (
            <>
              {stagedCount} to publish across {grouped.length} table
              {grouped.length === 1 ? "" : "s"}
            </>
          ) : (
            <span className="hidden md:inline">
              Nothing to publish yet — map a few values above.
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!p.undo.canUndo}
            onClick={() => void p.undo.undo()}
            title={p.undo.topLabel ?? undefined}
          >
            ↶ Undo
            {p.undo.topLabel && (
              <span className="ml-1.5 hidden max-w-[140px] truncate align-bottom text-[11px] text-ink-3 md:inline-block">
                {p.undo.topLabel}
              </span>
            )}
            {p.undo.topSurface && (
              <span className="ml-1.5 hidden font-mono text-[10px] text-ink-3 md:inline">
                ({p.undo.topSurface})
              </span>
            )}
            <span className="ml-2 hidden font-mono text-[10px] opacity-60 md:inline">⌘Z</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={stagedCount === 0}
            onClick={() => setReview((s) => !s)}
          >
            {review ? "Hide preview" : `Preview ${stagedCount}`}
          </Button>
          <Button
            size="sm"
            disabled={stagedCount === 0 || !p.canEdit}
            loading={p.committing}
            onClick={() => p.commitAll()}
          >
            {p.wsInfo?.writable ? "Publish to warehouse" : "Publish"}
            <span className="ml-2 hidden font-mono text-[10px] opacity-60 md:inline">⌘↵</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
