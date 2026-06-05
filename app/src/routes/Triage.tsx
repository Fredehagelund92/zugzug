import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/Button";
import { ComboSelect } from "../components/ComboSelect";
import { NoTablesYet } from "../components/NoTablesYet";
import { PageHeader } from "../components/PageHeader";
import { IconArrowRight, IconX } from "../components/Icons";
import { cx } from "../lib/cx";
import { valueRows } from "../data";
import type { MappingDimension } from "../data";
import {
  useDimensions,
  useDrafts,
  saveDraft,
  discardDraft,
  commit,
  dkey,
} from "../store";
import type { Draft } from "../store";
import { UndoStackProvider, useUndoStack, Chip } from "../components/datagrid";
import { useCreateTableModal } from "../lib/create-table-modal";

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

const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger/30");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");
const COLS_CROSS =
  "grid grid-cols-[120px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px] items-center gap-3";

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
  const [flash, setFlash] = useState<{ n: number; rows: number } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

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
      surface: "Triage",
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
    const r = d?.values.find((v) => v.value === raw);
    if (!r || !r.suggestion) return;
    void stageMapCross(dimId, raw, r.suggestion);
    flashRow(`[data-row-key="${attrEsc(`${dimId}::${raw}`)}"]`);
    advanceCrossNext(dimId, raw);
  };
  const skipCross = (dimId: string, raw: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    undo.push({
      label: `skip "${raw}"`,
      surface: "Triage",
      apply: () => saveDraft(dimId, raw, "skipped", null, null),
      inverse: () =>
        prev
          ? saveDraft(dimId, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dimId, raw),
    });
    void saveDraft(dimId, raw, "skipped", null, null);
    flashRow(`[data-row-key="${attrEsc(`${dimId}::${raw}`)}"]`);
    advanceCrossNext(dimId, raw);
  };
  const pickCross = (dimId: string, raw: string, label: string) => {
    void stageMapCross(dimId, raw, label);
    flashRow(`[data-row-key="${attrEsc(`${dimId}::${raw}`)}"]`);
    advanceCrossNext(dimId, raw);
  };
  // Drop a single staged draft from the review panel — undo-able.
  const discardCross = (dimId: string, raw: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    if (!prev) return;
    undo.push({
      label: `discard "${raw}"`,
      surface: "Triage",
      apply: () => discardDraft(dimId, raw),
      inverse: () => saveDraft(dimId, raw, prev.status, prev.targetLabel, prev.targetKey),
    });
    void discardDraft(dimId, raw);
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
    // Optimistic flash — predict count + warehouse rows before the server roundtrip
    // so the success moment lands on click. Reverted on failure.
    const predictedRows = stagedAllDrafts.reduce((n, d) => {
      const v = dimById.get(d.dimId)?.values.find((x) => x.value === d.raw);
      return n + (v ? valueRows(v) : 0);
    }, 0);
    setFlash({ n: stagedAllDrafts.length, rows: predictedRows });
    try {
      let total = 0,
        totalRows = 0;
      for (const id of dimIds) {
        const res = await commit(id);
        total += res.committed;
        totalRows += res.rowsRecovered;
      }
      if (total === 0) {
        setFlash(null);
        return;
      }
      setFlash({ n: total, rows: totalRows });
      setTimeout(() => setFlash(null), 2800);
    } catch (err) {
      setFlash(null);
      setCommitError(
        err instanceof Error
          ? err.message
          : "Commit failed across dimensions — check your connection and try again.",
      );
    }
  };

  // header count metadata — number of distinct tables that still have unmapped work
  const dimsWithWork = useMemo(
    () => new Set(visibleCross.filter((r) => r.status === "new").map((r) => r.dimId)).size,
    [visibleCross],
  );

  return (
    <div className="flex h-full min-h-0 flex-col px-5 pb-5 pt-4">
      <div className="mb-4 shrink-0">
        <PageHeader
          kicker="WORKFLOW"
          title={
            <>
              Triage{" "}
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
        commitError={commitError}
        setCommitError={setCommitError}
        flash={flash}
        undo={undo}
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
  commitError: string | null;
  setCommitError: (e: string | null) => void;
  flash: { n: number; rows: number } | null;
  undo: ReturnType<typeof useUndoStack>;
}

function CrossDimInbox(p: CrossDimInboxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const FILTERS: { k: Filter; label: string; n: number }[] = [
    { k: "new", label: "Needs review", n: p.counts.new },
    { k: "all", label: "All", n: p.counts.all },
    { k: "mapped", label: "Mapped", n: p.counts.mapped },
  ];
  const curKey = p.cursor ? `${p.cursor.dimId}::${p.cursor.raw}` : null;
  const curIdx = curKey ? p.rows.findIndex((r) => `${r.dimId}::${r.raw}` === curKey) : -1;

  const move = (delta: 1 | -1) => {
    if (p.rows.length === 0) return;
    const next = curIdx < 0 ? 0 : Math.max(0, Math.min(p.rows.length - 1, curIdx + delta));
    const r = p.rows[next];
    p.setCursor({ dimId: r.dimId, raw: r.raw });
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="zz-rise flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "j") {
          e.preventDefault();
          move(1);
          return;
        }
        if (e.key === "ArrowUp" || e.key === "k") {
          e.preventDefault();
          move(-1);
          return;
        }
        if (!p.cursor) return;
        if (e.key === "a" || e.key === "A") {
          e.preventDefault();
          p.accept(p.cursor.dimId, p.cursor.raw);
          return;
        }
        if (e.key === "s" || e.key === "S") {
          e.preventDefault();
          p.skip(p.cursor.dimId, p.cursor.raw);
          return;
        }
        if (e.key === "n" || e.key === "N") {
          e.preventDefault();
          p.advanceNext(p.cursor.dimId, p.cursor.raw);
          return;
        }
        // M opens the focused row's ComboSelect for manual pick — matches the
        // single-dim workbench's M binding. We find the row via data-row-key
        // and click its picker trigger (the one with aria-haspopup="listbox").
        if (e.key === "m" || e.key === "M") {
          e.preventDefault();
          const rowEl = containerRef.current?.querySelector<HTMLElement>(
            `[data-row-key="${curKey}"]`,
          );
          rowEl?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.click();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          p.commitAll();
          return;
        }
      }}
      style={{ animationDelay: "150ms" }}
    >
      {/* toolbar — sticky filter chips */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.k}
              type="button"
              onClick={() => p.setFilter(f.k)}
              className={cx(
                "rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors",
                p.filter === f.k
                  ? "bg-accent-wash text-accent"
                  : "text-ink-3 hover:bg-hover hover:text-ink-2",
              )}
            >
              {f.label} <span className="opacity-60">{f.n}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-ink-3">
          ranked by impact · J/K navigate · A accept · M pick · S skip · N next · ⌘↵ publish
        </span>
      </div>

      {/* scroll region — column header sticks to its top, rows flow, footer
          (CrossDimFooter below) is pinned at the panel bottom. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">

      {/* column header */}
      <div
        className={cx(
          COLS_CROSS,
          "sticky top-0 z-10 border-b border-line bg-surface px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3 backdrop-blur-sm",
        )}
      >
        <span>Dimension</span>
        <span>Source value</span>
        <span />
        <span>Record</span>
        <span>Confidence</span>
        <span>Status</span>
      </div>

      {/* rows */}
      {p.rows.length === 0 ? (
        <>
          {p.filter === "new" && (
            <div className="px-4 py-12 text-center">
              <div className="font-display text-[20px] text-ok">Nothing to triage today.</div>
              <p className="mx-auto mt-2 max-w-[44ch] text-[12.5px] text-ink-3">
                Curate records in{" "}
                <Link to="/app/tables" className="text-accent hover:underline">
                  Tables
                </Link>
                , or{" "}
                <Link to="/app/sources" className="text-accent hover:underline">
                  wire more sources
                </Link>
                .
              </p>
            </div>
          )}
          {p.filter === "mapped" && (
            <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
              Nothing has been mapped yet.{" "}
              <button
                onClick={() => p.setFilter("new")}
                className="text-accent hover:underline"
              >
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
        p.rows.slice(0, 500).map((r) => {
          const key = `${r.dimId}::${r.raw}`;
          const focused = curKey === key;
          const dim = p.dimById.get(r.dimId);
          const options = dim?.canonical.map((c) => c.label) ?? [];
          const external = dim?.keyKind === "external_id";
          return (
            <div
              key={key}
              data-row-key={key}
              className={cx(
                COLS_CROSS,
                "border-b border-line px-4 py-2.5 transition-colors hover:bg-hover",
                focused && "ring-1 ring-accent/60 bg-accent-wash/40",
              )}
              onClick={() => p.setCursor({ dimId: r.dimId, raw: r.raw })}
            >
              <span>
                <Chip label={r.dimName} bucket="chip-3" />
              </span>
              <div className="min-w-0">
                <div className="truncate font-mono text-[13px] text-ink">{r.raw}</div>
                <div className="font-mono text-[10px] text-ink-2 tabular-nums">
                  {r.dimRows.toLocaleString()} rows in warehouse
                </div>
              </div>
              <IconArrowRight className="h-4 w-4 text-ink-3" />
              <ComboSelect
                options={options}
                value={r.target}
                suggestion={r.suggestion ?? undefined}
                allowCreate={!external}
                onPick={(t) => p.pick(r.dimId, r.raw, t)}
              />
              <div>
                {r.confidence > 0 ? (
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-8 overflow-hidden rounded-pill bg-surface-2">
                      <div
                        className={cx("h-full rounded-pill", confBar(r.confidence))}
                        style={{ width: `${r.confidence}%` }}
                      />
                    </div>
                    <span
                      className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}
                    >
                      {r.confidence}
                    </span>
                  </div>
                ) : (
                  <span className="font-mono text-[11px] text-ink-2">—</span>
                )}
              </div>
              <div>
                {r.status === "mapped" ? (
                  <Chip label="Mapped" bucket="chip-1" dot />
                ) : r.status === "skipped" ? (
                  <Chip label="Skipped" bucket="chip-5" />
                ) : (
                  <Chip label="New" bucket="chip-2" dot />
                )}
              </div>
            </div>
          );
        })
      )}

      </div>{/* /scroll region */}

      {/* footer — multi-dim commit */}
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
    <div className="sticky bottom-0 z-20 border-t border-line bg-surface">
      {p.commitError && (
        <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
          <span>Commit failed — {p.commitError}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => p.setCommitError(null)}>
              Dismiss
            </Button>
            <Button size="sm" onClick={() => p.commitAll()}>
              Retry
            </Button>
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
                          <span className="shrink-0 text-ink-2 tabular-nums">{d.at}</span>
                          <button
                            type="button"
                            onClick={() => p.discard(d.dimId, d.raw)}
                            title="Discard this draft"
                            aria-label="Discard draft"
                            className="shrink-0 text-ink-3 transition-colors hover:text-danger"
                          >
                            <IconX className="h-3.5 w-3.5" />
                          </button>
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
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="font-mono text-[11px] text-ink-2">
          {p.flash ? (
            <span
              className="zz-rise text-committed"
              style={{ animationDuration: "var(--dur-slide)" }}
            >
              ✓ {p.flash.n} change{p.flash.n === 1 ? "" : "s"} published ·{" "}
              {p.flash.rows.toLocaleString()} rows recovered
            </span>
          ) : stagedCount > 0 ? (
            <>
              {stagedCount} change{stagedCount === 1 ? "" : "s"} staged across {grouped.length} dim
              {grouped.length === 1 ? "" : "s"}, ready to publish
            </>
          ) : (
            <>nothing to publish yet — accept or merge values above to stage them</>
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
              <span className="ml-1.5 inline-block max-w-[140px] truncate align-bottom text-[11px] text-ink-3">
                {p.undo.topLabel}
              </span>
            )}
            {p.undo.topSurface && (
              <span className="ml-1.5 font-mono text-[10px] text-ink-3">({p.undo.topSurface})</span>
            )}
            <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={stagedCount === 0}
            onClick={() => setReview((s) => !s)}
          >
            {review ? "Hide review" : `Review ${stagedCount}`}
          </Button>
          <Button size="sm" disabled={stagedCount === 0} onClick={() => p.commitAll()}>
            Publish {stagedCount} change{stagedCount === 1 ? "" : "s"}
            <span className="ml-2 font-mono text-[10px] opacity-60">⌘↵</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
