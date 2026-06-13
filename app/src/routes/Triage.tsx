import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { Button } from "../components/Button";
import { NoTablesYet } from "../components/NoTablesYet";
import { PageHeader } from "../components/PageHeader";
import { IconArrowRight, IconX } from "../components/Icons";
import { cx } from "../lib/cx";
import { toast } from "../components/Toast";
import { valueRows } from "../data";
import { GetSuggestionButton } from "../components/GetSuggestionButton";
import type { MappingDimension } from "../data";
import {
  useDimensions,
  useDrafts,
  saveDraft,
  discardDraft,
  commit,
  dkey,
  useWorkspaceInfo,
  useCanEdit,
} from "../store";
import type { Draft, WorkspaceInfo } from "../store";
import { UndoStackProvider, useUndoStack, DataGrid, Chip } from "../components/datagrid";
import { crossDimColumns } from "../components/modes/match-columns";
import { useCreateTableModal } from "../lib/create-table-modal";
import { useAiHint, type AiHint } from "../lib/use-ai-hint";
import { TriageReasoningStrip } from "../components/TriageReasoningStrip";

/* Triage — cross-dimension inbox lifted out of Mapping.tsx (the all-dim view).
   Surfaces every unmapped source value across every table, ranked by blast
   radius (unmapped × log10(rows) per dim, then by confidence asc). Each
   accept/skip/pick lands as a per-user DRAFT in Postgres; ⌘↵ batch-commits
   the entire queue to DuckDB across all touched dims. The "Triage" surface
   tag on every undo entry lets ⌘Z preview which surface it will land on. */

type RStatus = "mapped" | "new" | "skipped";
type Filter = "new" | "all" | "mapped";
type CrossRow = {
  dimId: string;
  dimName: string;
  dimRows: number;
  raw: string;
  suggestion: string | null;
  confidence: number;
  status: RStatus;
  target: string | null;
};

// Escape a string for use inside a double-quoted CSS attribute selector.
const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// Brief accent-wash on a row after the user acted on it (Accept/Skip/Pick).
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

export function Triage() {
  const dims = useDimensions();
  const create = useCreateTableModal();
  if (dims.length === 0) return <NoTablesYet from="triage" onCreateRequested={create.open} />;
  return (
    <UndoStackProvider scopeKey="triage">
      <TriageInner />
    </UndoStackProvider>
  );
}

function TriageInner() {
  const dims = useDimensions();
  const allDrafts = useDrafts();
  const undo = useUndoStack();
  const wsInfo = useWorkspaceInfo();
  const canEdit = useCanEdit();

  // URL ?filter= state — round-trips; "new" is the default and is omitted.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = ((): Filter => {
    const v = searchParams.get("filter");
    return v === "new" || v === "all" || v === "mapped" ? v : "new";
  })();
  const [filter, setFilterBase] = useState<Filter>(initialFilter);
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

  const [cursor, setCursor] = useState<{ dimId: string; raw: string } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const reportDraftError = useCallback((action: string, err: unknown) => {
    setDraftError(
      err instanceof Error ? `Couldn't ${action}: ${err.message}` : `Couldn't ${action}.`,
    );
  }, []);

  const aiHint = useAiHint(cursor?.dimId ?? "", cursor?.raw ?? "", cursor !== null);

  // every value across every dimension, normalized into one queue ranked
  // by impact (unmapped × log10(rows) per-dim, then by confidence ascending).
  const dimById = useMemo(() => new Map(dims.map((d) => [d.id, d])), [dims]);
  const crossDimRows = useMemo<CrossRow[]>(() => {
    const dimScore = new Map<string, number>();
    for (const d of dims) {
      let unmapped = 0;
      for (const v of d.values) {
        const draft = allDrafts[dkey(d.id, v.value)];
        const status = draft ? draft.status : v.current ? "mapped" : "new";
        if (status === "new") unmapped++;
      }
      dimScore.set(d.id, unmapped * Math.log10(Math.max(10, d.rows)));
    }
    const out: CrossRow[] = [];
    for (const d of dims) {
      for (const v of d.values) {
        const draft = allDrafts[dkey(d.id, v.value)];
        const status: RStatus = draft ? draft.status : v.current ? "mapped" : "new";
        out.push({
          dimId: d.id,
          dimName: d.dimension,
          dimRows: d.rows,
          raw: v.value,
          suggestion: v.suggestion ?? null,
          confidence: v.confidence ?? 0,
          status,
          target: draft ? draft.targetLabel : v.current,
        });
      }
    }
    out.sort((a, b) => {
      const sa = dimScore.get(a.dimId) ?? 0;
      const sb = dimScore.get(b.dimId) ?? 0;
      if (sa !== sb) return sb - sa;
      return (a.confidence || 0) - (b.confidence || 0); // lower confidence first within a dim
    });
    return out;
  }, [dims, allDrafts]);

  const visibleCross = useMemo(
    () => crossDimRows.filter((r) => filter === "all" || r.status === filter),
    [crossDimRows, filter],
  );
  const crossCounts = useMemo(() => {
    const c = { all: crossDimRows.length, new: 0, mapped: 0, skipped: 0 };
    for (const r of crossDimRows) c[r.status]++;
    return c;
  }, [crossDimRows]);

  // ── cross-dimension handlers ─────────────────────────────────────────────
  const keyForLabelIn = (dimId: string, label: string) => {
    const d = dimById.get(dimId);
    return (
      d?.canonical.find((c) => c.label === label)?.key ??
      label.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    );
  };
  const stageMapCross = (dimId: string, raw: string, label: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    undo.push({
      label: `match "${raw}" → ${label}`,
      surface: "Review",
      apply: () => saveDraft(dimId, raw, "mapped", label, keyForLabelIn(dimId, label)),
      inverse: () =>
        prev
          ? saveDraft(dimId, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dimId, raw),
    });
    return saveDraft(dimId, raw, "mapped", label, keyForLabelIn(dimId, label));
  };
  const acceptCross = (dimId: string, raw: string) => {
    const d = dimById.get(dimId);
    const v = d?.values.find((x) => x.value === raw);
    const suggestion = v?.suggestion ?? aiHint.hint?.suggestion;
    if (!suggestion) {
      toast(`No suggestion to accept for "${raw}".`, "error");
      return;
    }
    stageMapCross(dimId, raw, suggestion).catch((err) => reportDraftError(`accept "${raw}"`, err));
    flashRow(`[data-row-key="${attrEsc(`${dimId}::${raw}`)}"]`);
    advanceCrossNext(dimId, raw);
  };
  const skipCross = (dimId: string, raw: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    undo.push({
      label: `skip "${raw}"`,
      surface: "Review",
      apply: () => saveDraft(dimId, raw, "skipped", null, null),
      inverse: () =>
        prev
          ? saveDraft(dimId, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dimId, raw),
    });
    saveDraft(dimId, raw, "skipped", null, null).catch((err) =>
      reportDraftError(`skip "${raw}"`, err),
    );
    flashRow(`[data-row-key="${attrEsc(`${dimId}::${raw}`)}"]`);
    advanceCrossNext(dimId, raw);
  };
  const pickCross = (dimId: string, raw: string, label: string) => {
    stageMapCross(dimId, raw, label).catch((err) =>
      reportDraftError(`map "${raw}" → ${label}`, err),
    );
    flashRow(`[data-row-key="${attrEsc(`${dimId}::${raw}`)}"]`);
    advanceCrossNext(dimId, raw);
  };
  // Drop a single staged draft from the review panel — undo-able.
  const discardCross = (dimId: string, raw: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    if (!prev) return;
    undo.push({
      label: `discard "${raw}"`,
      surface: "Review",
      apply: () => discardDraft(dimId, raw),
      inverse: () => saveDraft(dimId, raw, prev.status, prev.targetLabel, prev.targetKey),
    });
    discardDraft(dimId, raw).catch((err) => reportDraftError(`discard "${raw}"`, err));
  };
  const advanceCrossNext = useCallback(
    (fromDimId: string | null, fromRaw: string | null) => {
      const rows = visibleCross;
      if (rows.length === 0) return;
      const fromKey = fromDimId && fromRaw ? `${fromDimId}::${fromRaw}` : null;
      const idx = fromKey ? rows.findIndex((r) => `${r.dimId}::${r.raw}` === fromKey) : -1;
      for (let i = 1; i <= rows.length; i++) {
        const j = ((idx < 0 ? -1 : idx) + i + rows.length) % rows.length;
        if (rows[j].status === "new") {
          setCursor({ dimId: rows[j].dimId, raw: rows[j].raw });
          return;
        }
      }
    },
    [visibleCross, setCursor],
  );

  // staged drafts across ALL dimensions — drives the commit footer
  const stagedAllDrafts = useMemo(
    () =>
      Object.values(allDrafts).filter((d) => {
        if (d.status !== "mapped") return false;
        const dim = dimById.get(d.dimId);
        const v = dim?.values.find((x) => x.value === d.raw);
        return !!(v && !v.current);
      }),
    [allDrafts, dimById],
  );
  const approveAndCommitAll = async () => {
    setCommitError(null);
    const dimIds = [...new Set(stagedAllDrafts.map((d) => d.dimId))];
    if (dimIds.length === 0) return;
    setCommitting(true);
    // Optimistic flash — predict count + warehouse rows before the server roundtrip
    // so the success moment lands on click. Reverted on failure.
    const predictedRows = stagedAllDrafts.reduce((n, d) => {
      const v = dimById.get(d.dimId)?.values.find((x) => x.value === d.raw);
      return n + (v ? valueRows(v) : 0);
    }, 0);
    const n0 = stagedAllDrafts.length;
    toast(
      `${n0} change${n0 === 1 ? "" : "s"} published · ${predictedRows.toLocaleString()} rows recovered`,
    );
    try {
      let total = 0,
        totalRows = 0;
      for (const id of dimIds) {
        const res = await commit(id);
        total += res.committed;
        totalRows += res.rowsRecovered;
      }
      if (total === 0) {
        // nothing was actually committed — clear the optimistic flash
        return;
      }
      toast(
        `✓ ${total} change${total === 1 ? "" : "s"} published · ${totalRows.toLocaleString()} rows recovered`,
      );
    } catch (err) {
      setCommitError(
        err instanceof Error
          ? err.message
          : "Publish failed across dimensions — check your connection and try again.",
      );
    } finally {
      setCommitting(false);
    }
  };

  // header count metadata — number of distinct tables that still have unmapped work
  const dimsWithWork = useMemo(
    () => new Set(visibleCross.filter((r) => r.status === "new").map((r) => r.dimId)).size,
    [visibleCross],
  );

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-4 md:px-5 md:pb-5">
      <div className="mb-3 shrink-0">
        <PageHeader
          kicker="WORKFLOW"
          title={
            <>
              Review{" "}
              <span className="font-mono text-[14px] text-ink-3">
                · {crossCounts.new} across {dimsWithWork} table{dimsWithWork === 1 ? "" : "s"}
              </span>
            </>
          }
          lede="Sorted by blast radius. Press ⌘↵ to publish."
        />
      </div>

      <CrossDimInbox
        rows={visibleCross}
        counts={crossCounts}
        filter={filter}
        setFilter={setFilter}
        cursor={cursor}
        setCursor={setCursor}
        accept={acceptCross}
        skip={skipCross}
        pick={pickCross}
        advanceNext={advanceCrossNext}
        dimById={dimById}
        stagedDrafts={stagedAllDrafts}
        discard={discardCross}
        commitAll={approveAndCommitAll}
        committing={committing}
        commitError={commitError}
        setCommitError={setCommitError}
        draftError={draftError}
        setDraftError={setDraftError}
        undo={undo}
        aiHint={aiHint}
        wsInfo={wsInfo}
        canEdit={canEdit}
      />
    </div>
  );
}

interface CrossDimInboxProps {
  rows: CrossRow[];
  counts: { all: number; new: number; mapped: number; skipped: number };
  filter: Filter;
  setFilter: (f: Filter) => void;
  cursor: { dimId: string; raw: string } | null;
  setCursor: (c: { dimId: string; raw: string } | null) => void;
  accept: (dimId: string, raw: string) => void;
  skip: (dimId: string, raw: string) => void;
  pick: (dimId: string, raw: string, label: string) => void;
  advanceNext: (fromDimId: string | null, fromRaw: string | null) => void;
  dimById: Map<string, MappingDimension>;
  stagedDrafts: Draft[];
  discard: (dimId: string, raw: string) => void;
  commitAll: () => void;
  committing: boolean;
  commitError: string | null;
  setCommitError: (e: string | null) => void;
  draftError: string | null;
  setDraftError: (e: string | null) => void;
  undo: ReturnType<typeof useUndoStack>;
  aiHint: { hint: AiHint | null; loading: boolean; error: boolean };
  wsInfo: WorkspaceInfo | null;
  canEdit: boolean;
}

function CrossDimInbox(p: CrossDimInboxProps) {
  const FILTERS: { k: Filter; label: string; n: number }[] = [
    { k: "new", label: "Needs review", n: p.counts.new },
    { k: "all", label: "All", n: p.counts.all },
    { k: "mapped", label: "Mapped", n: p.counts.mapped },
  ];
  const nav = useNavLinks();

  // Per-dim option list — DataGrid asks for it per-row via the factory closure
  const columns = useMemo(
    () =>
      crossDimColumns({
        optionsFor: (dimId) => p.dimById.get(dimId)?.canonical.map((c) => c.label) ?? [],
        canEdit: p.canEdit,
      }),
    [p.dimById, p.canEdit],
  );

  // Bridge DataGrid's internal cursor to p.cursor so the parent's useAiHint
  // (keyed off the focused row's dimId+raw) still fires on arrow navigation.
  const onCursorChange = useCallback(
    (c: { rowKey: string; field: string } | null) => {
      if (!c) {
        p.setCursor(null);
        return;
      }
      const [dimId, ...rest] = c.rowKey.split("::");
      // raw values can contain "::"; rejoin everything after the first delim.
      if (!dimId) return;
      p.setCursor({ dimId, raw: rest.join("::") });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.setCursor],
  );

  return (
    <div
      className="zz-rise flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface"
      style={{ animationDelay: "150ms" }}
    >
      {/* toolbar — sticky filter chips */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.k}
              type="button"
              onClick={() => p.setFilter(f.k)}
              className={cx(
                "min-h-[44px] rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors md:min-h-0",
                p.filter === f.k
                  ? "bg-accent-wash text-accent"
                  : "text-ink-3 hover:bg-hover hover:text-ink-2",
              )}
            >
              {f.label} <span className="opacity-60">{f.n}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto hidden font-mono text-[10px] uppercase tracking-wider text-ink-3 md:inline">
          ranked by impact · ↑↓ navigate · A accept · ↵/M pick · S skip · N next · ⌘↵ publish
        </span>
      </div>

      {/* scroll region — DataGrid owns its own virtualization + sticky header;
          CrossDimFooter pins to the panel bottom. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {p.rows.length === 0 ? (
          <>
            {p.filter === "new" && (
              <div className="px-4 py-12 text-center">
                <div className="font-display text-[18px] font-semibold text-ink">
                  Nothing to review today. 🎯
                </div>
                <p className="mx-auto mt-2 max-w-[44ch] text-[12.5px] text-ink-3">
                  Curate records in{" "}
                  <Link to={nav.tables} className="text-accent hover:underline">
                    Tables
                  </Link>
                  , or{" "}
                  <Link to={nav.sources} className="text-accent hover:underline">
                    wire more sources
                  </Link>
                  .
                </p>
              </div>
            )}
            {p.filter === "mapped" && (
              <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
                Nothing has been mapped yet.{" "}
                <button onClick={() => p.setFilter("new")} className="text-accent hover:underline">
                  View needs review →
                </button>
              </div>
            )}
            {p.filter === "all" && (
              <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
                no values in this view
              </div>
            )}
          </>
        ) : (
          <DataGrid<CrossRow>
            rows={p.rows}
            rowKey={(r) => `${r.dimId}::${r.raw}`}
            columns={columns}
            getValue={(r, field) => (r as unknown as Record<string, unknown>)[field]}
            onCursorChange={onCursorChange}
            onCommit={
              p.canEdit
                ? async (rowKey, field, value) => {
                    if (field !== "target" || typeof value !== "string" || !value) return;
                    const [dimId, ...rest] = rowKey.split("::");
                    if (!dimId) return;
                    p.pick(dimId, rest.join("::"), value);
                  }
                : undefined
            }
            onCellKeyDown={(e, ctx) => {
              if (p.canEdit && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                p.commitAll();
                return;
              }
              const rk = ctx.cursor?.rowKey;
              if (!rk) return;
              const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
              if (!plain) return;
              const [dimId, ...rest] = rk.split("::");
              if (!dimId) return;
              const raw = rest.join("::");
              const k = e.key.toLowerCase();
              if (p.canEdit && k === "a") {
                e.preventDefault();
                p.accept(dimId, raw);
              } else if (p.canEdit && k === "s") {
                e.preventDefault();
                p.skip(dimId, raw);
              } else if (p.canEdit && k === "m") {
                e.preventDefault();
                ctx.startEdit();
              } else if (k === "n") {
                e.preventDefault();
                p.advanceNext(dimId, raw);
              }
            }}
            renderRowDetail={(r) => {
              const key = `${r.dimId}::${r.raw}`;
              const isCursor = p.cursor && `${p.cursor.dimId}::${p.cursor.raw}` === key;
              if (!isCursor || r.target) return null;
              return (
                <div className="flex flex-col gap-2">
                  <TriageReasoningStrip hint={p.aiHint.hint} loading={p.aiHint.loading} />
                  {r.status === "new" && !r.suggestion && p.canEdit && (
                    <GetSuggestionButton dimensionId={r.dimId} rawValue={r.raw} />
                  )}
                </div>
              );
            }}
            empty={
              <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
                no values in this view
              </div>
            }
          />
        )}
      </div>
      {/* /scroll region */}

      <CrossDimFooter p={p} />
    </div>
  );
}

// Footer + expandable review panel. Split out so the review panel state is
// scoped tightly and the cross-dim grid body stays readable.
function CrossDimFooter({ p }: { p: CrossDimInboxProps }) {
  const [review, setReview] = useState(false);
  const stagedCount = p.stagedDrafts.length;
  // Group staged drafts by dim → target so the reviewer can scan what's about
  // to land, sorted by dim with most-staged first. Within a dim, group by the
  // canonical target so duplicates collapse into a single "→ X (N)" line.
  const grouped = useMemo(() => {
    const byDim = new Map<string, Draft[]>();
    for (const d of p.stagedDrafts) {
      const arr = byDim.get(d.dimId) ?? [];
      arr.push(d);
      byDim.set(d.dimId, arr);
    }
    const out: Array<{
      dimId: string;
      dimName: string;
      groups: Array<{ target: string; drafts: Draft[] }>;
    }> = [];
    for (const [dimId, drafts] of byDim) {
      const dim = p.dimById.get(dimId);
      const byTarget = new Map<string, Draft[]>();
      for (const d of drafts) {
        const t = d.targetLabel ?? "—";
        const arr = byTarget.get(t) ?? [];
        arr.push(d);
        byTarget.set(t, arr);
      }
      out.push({
        dimId,
        dimName: dim?.dimension ?? dimId,
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
  }, [p.stagedDrafts, p.dimById]);

  return (
    <div className="sticky bottom-0 z-10 border-t border-line bg-surface">
      {p.draftError && (
        <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
          <span>{p.draftError}</span>
          <Button variant="ghost" size="sm" onClick={() => p.setDraftError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {p.commitError && (
        <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
          <span>Commit failed — {p.commitError}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => p.setCommitError(null)}>
              Dismiss
            </Button>
            {p.canEdit && (
              <Button size="sm" onClick={() => p.commitAll()}>
                Retry
              </Button>
            )}
          </div>
        </div>
      )}
      {review && stagedCount > 0 && (
        <div className="border-b border-line">
          <div className="px-4 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">
            Staged for review · {stagedCount} across {grouped.length} dim
            {grouped.length === 1 ? "" : "s"}
          </div>
          <div className="mt-1 max-h-72 overflow-y-auto">
            {grouped.map((g) => (
              <div key={g.dimId} className="border-t border-line first:border-t-0">
                <div className="flex items-center gap-2 px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-2">
                  <Chip label={g.dimName} bucket="chip-3" />
                  <span className="tabular-nums">
                    {g.groups.reduce((n, x) => n + x.drafts.length, 0)} staged
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
                          key={`${d.dimId}::${d.raw}`}
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
                              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold text-blue-700">
                                AI
                              </span>
                              {d.confidence && (
                                <span
                                  className={cx(
                                    "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                                    d.confidence === "high" && "bg-green-100 text-green-700",
                                    d.confidence === "medium" && "bg-yellow-100 text-yellow-700",
                                    d.confidence === "low" && "bg-red-100 text-red-700",
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
                              onClick={() => p.discard(d.dimId, d.raw)}
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
              {stagedCount} change{stagedCount === 1 ? "" : "s"} staged across {grouped.length} dim
              {grouped.length === 1 ? "" : "s"}, ready to publish
            </>
          ) : (
            <span className="hidden md:inline">
              nothing to publish yet — accept or merge values above to stage them
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
            {review ? "Hide" : `Review ${stagedCount}`}
          </Button>
          <div className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              disabled={stagedCount === 0 || !p.canEdit}
              loading={p.committing}
              onClick={() => p.commitAll()}
            >
              {p.wsInfo?.writable ? "Publish to warehouse" : "Publish"}
              <span className="ml-2 hidden font-mono text-[10px] opacity-60 md:inline">⌘↵</span>
            </Button>
            {p.wsInfo && !p.wsInfo.writable && p.stagedDrafts[0] && (
              <a
                href={`/api/dimensions/${p.stagedDrafts[0].dimId}/snapshot.parquet`}
                download
                className="text-xs text-ink-3 hover:underline"
              >
                Download snapshot →
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
