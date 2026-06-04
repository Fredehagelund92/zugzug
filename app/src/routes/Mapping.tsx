import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Checkbox } from "../components/Checkbox";
import { ComboSelect } from "../components/ComboSelect";
import { TablePicker } from "../components/TablePicker";
import { CreateTableModal } from "../components/CreateTableModal";
import { NoTablesYet } from "../components/NoTablesYet";
import { PageHeader } from "../components/PageHeader";
import { StatsBar } from "../components/StatsBar";
import { IconCheck, IconX, IconWand, IconArrowRight, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import { valueRows } from "../data";
import type { MappingValue } from "../data";
import { useDimensions, useDrafts, saveDraft, discardDraft, listDrafts, commit, dkey, currentUser } from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { useGridCursor, useUndoStack, Chip } from "../components/datagrid";
import type { ColumnDef } from "../components/datagrid";

/* Value mapping — match messy source values to one master record. Each accept /
   merge / skip lands as a per-user DRAFT (the store's Postgres seam), never a
   per-keystroke MotherDuck round-trip; the footer reviews the staged drafts and
   commits them in one batch MERGE to DuckDB (dim_* + map_*). The row status you
   see = the committed truth overlaid with your pending draft. */

type RStatus = "mapped" | "new" | "skipped";
type ValueState = Record<string, { target: string | null; status: RStatus }>;
type Filter = "new" | "all" | "mapped";
type ViewMode = "single" | "all";
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
const COLS = "grid grid-cols-[28px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px] items-center gap-3";

function useSessionState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (window.sessionStorage.getItem(key) as T) ?? fallback; }
    catch { return fallback; }
  });
  const set = (next: T) => {
    setV(next);
    try { window.sessionStorage.setItem(key, next); } catch { /* ignore quota / disabled storage */ }
  };
  return [v, set];
}

export function Mapping() {
  const dims = useDimensions();
  const [createOpen, setCreateOpen] = useState(false);
  if (dims.length === 0) return (
    <>
      <NoTablesYet from="mapping" onCreateRequested={() => setCreateOpen(true)} />
      <CreateTableModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
      />
    </>
  );
  return <MappingInner />;
}

function MappingInner() {
  const dims = useDimensions();
  const allDrafts = useDrafts();
  const { engineer } = useEngineerMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const [seedIdRaw, setSeedIdRaw] = useState(() => {
    const fromUrl = searchParams.get("dimId");
    if (fromUrl && dims.some((d) => d.id === fromUrl)) return fromUrl;
    try {
      const fromSession = window.sessionStorage.getItem("zz:mapping:seedId");
      if (fromSession && dims.some((d) => d.id === fromSession)) return fromSession;
    } catch { /* ignore */ }
    return dims[0].id;
  });
  const setSeedId = (id: string) => {
    setSeedIdRaw(id);
    try { window.sessionStorage.setItem("zz:mapping:seedId", id); } catch { /* ignore */ }
  };
  const seedId = seedIdRaw;
  const seed = dims.find((s) => s.id === seedId) ?? dims[0];
  const [createOpen, setCreateOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [filter, setFilter] = useSessionState<Filter>("zz:mapping:filter", "new");
  const [viewMode, setViewMode] = useSessionState<ViewMode>("zz:mapping:viewMode", "single");
  const [crossCursor, setCrossCursor] = useState<{ dimId: string; raw: string } | null>(null);
  // refs for the view-mode segmented control's sliding indicator
  const singleBtnRef = useRef<HTMLButtonElement>(null);
  const allBtnRef = useRef<HTMLButtonElement>(null);
  const [tabMarker, setTabMarker] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [review, setReview] = useState(false);
  const [flash, setFlash] = useState<{ n: number; rows: number } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [autoFlash, setAutoFlash] = useState<number | null>(null);
  const [_shortcuts, setShortcuts] = useState(false);
  void _shortcuts; // placeholder — wired to ShortcutsOverlay in Task 29

  const undo = useUndoStack();

  const byVal = (v: string) => seed.values.find((r) => r.value === v)!;
  const keyFor = (label: string) => seed.canonical.find((c) => c.label === label)?.key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const options = seed.canonical.map((c) => c.label);
  const external = seed.keyKind === "external_id";

  // committed truth (dims) overlaid with each value's pending draft, if any
  const state: ValueState = useMemo(
    () => Object.fromEntries(seed.values.map((v) => {
      const d = allDrafts[dkey(seed.id, v.value)];
      return [v.value, d ? { target: d.targetLabel, status: d.status } : { target: v.current, status: v.current ? "mapped" : "new" }];
    })),
    [seed, allDrafts],
  );

  const selectSeed = (id: string) => {
    setSeedId(id);
    setSearchParams((prev) => { prev.set("dimId", id); return prev; }, { replace: true });
    setSel([]); setOpen(null); setShowSql(false); setReview(false); setFlash(null);
  };

  const counts = useMemo(() => {
    const c = { all: seed.values.length, new: 0, mapped: 0, skipped: 0 };
    for (const v of seed.values) c[state[v.value]?.status ?? "new"]++;
    return c;
  }, [seed, state]);

  // every value across every dimension, normalized into one queue ranked
  // by impact (unmapped × log10(rows) per-dim, then by confidence ascending).
  // drives the cross-dim inbox view.
  const dimById = useMemo(() => new Map(dims.map((d) => [d.id, d])), [dims]);
  const crossDimRows = useMemo<CrossRow[]>(() => {
    const dimScore = new Map<string, number>();
    for (const d of dims) {
      let unmapped = 0;
      for (const v of d.values) {
        const draft = allDrafts[dkey(d.id, v.value)];
        const status = draft ? draft.status : (v.current ? "mapped" : "new");
        if (status === "new") unmapped++;
      }
      dimScore.set(d.id, unmapped * Math.log10(Math.max(10, d.rows)));
    }
    const out: CrossRow[] = [];
    for (const d of dims) {
      for (const v of d.values) {
        const draft = allDrafts[dkey(d.id, v.value)];
        const status: RStatus = draft ? draft.status : (v.current ? "mapped" : "new");
        out.push({
          dimId: d.id, dimName: d.dimension, dimRows: d.rows,
          raw: v.value, suggestion: v.suggestion ?? null,
          confidence: v.confidence ?? 0,
          status, target: draft ? draft.targetLabel : v.current,
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

  // unmapped count per dimension, sorted desc — drives the "next dimension with
  // work" handoff when the current dim's inbox is empty.
  const nextDims = useMemo(() => {
    const out: { id: string; name: string; count: number }[] = [];
    for (const d of dims) {
      let n = 0;
      for (const v of d.values) {
        const draft = allDrafts[dkey(d.id, v.value)];
        const status = draft ? draft.status : (v.current ? "mapped" : "new");
        if (status === "new") n++;
      }
      if (n > 0) out.push({ id: d.id, name: d.dimension, count: n });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [dims, allDrafts]);

  const stageMap = (v: string, label: string) => {
    const prev = allDrafts[dkey(seed.id, v)];
    undo.push({
      label: `match "${v}" → ${label}`,
      apply: () => saveDraft(seed.id, v, "mapped", label, keyFor(label)),
      inverse: () => prev ? saveDraft(seed.id, v, prev.status, prev.targetLabel, prev.targetKey) : discardDraft(seed.id, v),
    });
    return saveDraft(seed.id, v, "mapped", label, keyFor(label));
  };
  const accept = (v: string) => {
    const r = byVal(v);
    if (!r.suggestion) return;
    void stageMap(v, r.suggestion);
    advanceToNextNew(v);
  };
  const pick = (v: string, t: string) => {
    void stageMap(v, t);
    advanceToNextNew(v);
  };
  // Skip without advancing the cursor — bulkApply uses this so the cursor
  // doesn't bounce when skipping a selection. The single-action `skip` below
  // composes this + advanceToNextNew.
  const skipPersist = (v: string) => {
    const prev = allDrafts[dkey(seed.id, v)];
    undo.push({
      label: `skip "${v}"`,
      apply: () => saveDraft(seed.id, v, "skipped", null, null),
      inverse: () => prev ? saveDraft(seed.id, v, prev.status, prev.targetLabel, prev.targetKey) : discardDraft(seed.id, v),
    });
    return saveDraft(seed.id, v, "skipped", null, null);
  };
  const skip = (v: string) => {
    void skipPersist(v);
    advanceToNextNew(v);
  };
  const reset = (v: string) => {
    const prev = allDrafts[dkey(seed.id, v)];
    if (!prev) return;
    undo.push({
      label: `reset "${v}"`,
      apply: () => discardDraft(seed.id, v),
      inverse: () => saveDraft(seed.id, v, prev.status, prev.targetLabel, prev.targetKey),
    });
    return discardDraft(seed.id, v);
  };
  // Bulk operations: collect saveDraft promises, fire in parallel, wrap every
  // per-value undo entry in one compound entry. One Cmd+Z restores the whole
  // batch and N values commit as 1 network round-trip instead of N sequential.
  const automap = async () => {
    const matches = seed.values.filter(
      (r) => r.suggestion && r.confidence >= 90 && state[r.value].status === "new",
    );
    if (matches.length === 0) return;
    const label = `auto-match ${matches.length} value${matches.length === 1 ? "" : "s"}`;
    undo.beginTransaction(label);
    try {
      await Promise.all(matches.map((r) => stageMap(r.value, r.suggestion!)));
    } finally {
      undo.endTransaction();
      setAutoFlash(matches.length);
      setTimeout(() => setAutoFlash(null), 2600);
    }
  };
  const bulkApply = async (label: string, fn: (v: string) => unknown) => {
    if (sel.length === 0) return;
    const values = [...sel];
    setSel([]);
    undo.beginTransaction(label);
    try {
      await Promise.all(values.map((v) => Promise.resolve(fn(v))));
    } finally {
      undo.endTransaction();
    }
  };

  // ── cross-dimension inbox handlers ─────────────────────────────────────────
  const keyForLabelIn = (dimId: string, label: string) => {
    const d = dimById.get(dimId);
    return d?.canonical.find((c) => c.label === label)?.key
      ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  };
  const stageMapCross = (dimId: string, raw: string, label: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    undo.push({
      label: `match "${raw}" → ${label}`,
      apply: () => saveDraft(dimId, raw, "mapped", label, keyForLabelIn(dimId, label)),
      inverse: () => prev
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
    advanceCrossNext(dimId, raw);
  };
  const skipCross = (dimId: string, raw: string) => {
    const prev = allDrafts[dkey(dimId, raw)];
    undo.push({
      label: `skip "${raw}"`,
      apply: () => saveDraft(dimId, raw, "skipped", null, null),
      inverse: () => prev
        ? saveDraft(dimId, raw, prev.status, prev.targetLabel, prev.targetKey)
        : discardDraft(dimId, raw),
    });
    void saveDraft(dimId, raw, "skipped", null, null);
    advanceCrossNext(dimId, raw);
  };
  const pickCross = (dimId: string, raw: string, label: string) => {
    void stageMapCross(dimId, raw, label);
    advanceCrossNext(dimId, raw);
  };
  function advanceCrossNext(fromDimId: string | null, fromRaw: string | null) {
    const rows = visibleCross;
    if (rows.length === 0) return;
    const fromKey = fromDimId && fromRaw ? `${fromDimId}::${fromRaw}` : null;
    const idx = fromKey ? rows.findIndex((r) => `${r.dimId}::${r.raw}` === fromKey) : -1;
    for (let i = 1; i <= rows.length; i++) {
      const j = ((idx < 0 ? -1 : idx) + i + rows.length) % rows.length;
      if (rows[j].status === "new") {
        setCrossCursor({ dimId: rows[j].dimId, raw: rows[j].raw });
        return;
      }
    }
  }

  // staged drafts across ALL dimensions — drives the commit footer in all-mode
  const stagedAllDrafts = useMemo(
    () => Object.values(allDrafts).filter((d) => {
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
    // Optimistic flash — see approveAndCommit above.
    const predictedRows = stagedAllDrafts.reduce((n, d) => {
      const v = dimById.get(d.dimId)?.values.find((x) => x.value === d.raw);
      return n + (v ? valueRows(v) : 0);
    }, 0);
    setFlash({ n: stagedAllDrafts.length, rows: predictedRows });
    setShowSql(false); setReview(false);
    try {
      let total = 0, totalRows = 0;
      for (const id of dimIds) {
        const res = await commit(id);
        total += res.committed; totalRows += res.rowsRecovered;
      }
      if (total === 0) { setFlash(null); return; }
      setFlash({ n: total, rows: totalRows });
      setTimeout(() => setFlash(null), 2800);
    } catch (err) {
      setFlash(null);
      setCommitError(err instanceof Error ? err.message : "Commit failed across dimensions — check your connection and try again.");
    }
  };

  // on switching to all-mode, drop the cursor on the first cross-dim "new" row
  const focusedModeRef = useRef<ViewMode | null>(null);
  useEffect(() => {
    if (focusedModeRef.current === viewMode) return;
    focusedModeRef.current = viewMode;
    if (viewMode === "all" && !crossCursor) advanceCrossNext(null, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const visible = seed.values.filter((v) => filter === "all" || state[v.value]?.status === filter);
  const visIds = visible.map((v) => v.value);
  const allSel = visIds.length > 0 && visIds.every((id) => sel.includes(id));
  const headState: "on" | "off" | "mixed" = allSel ? "on" : sel.length ? "mixed" : "off";

  const visibleRows = visible;            // alias for clarity
  const COLS_FOR_CURSOR: ColumnDef<MappingValue>[] = [
    { field: "value", label: "Source", type: "text", editable: false },
    { field: "target", label: "Record", type: "text", editable: true },
    { field: "status", label: "Status", type: "text", editable: false },
  ];
  const cursor = useGridCursor<MappingValue>({
    rows: visibleRows,
    rowKey: (r) => r.value,
    columns: COLS_FOR_CURSOR,
    onSelectAll: () => setSel(visIds),
    onUndo: () => void undo.undo(),
    onRedo: () => void undo.redo(),
    onShortcuts: () => setShortcuts(true),
    onFocusFilter: () => {/* filter chips already global */},
  });

  // advance the cursor to the next visible row whose status is "new",
  // wrapping around once. used by accept/skip/pick/N to keep the user
  // moving through the inbox without reaching for the mouse.
  function advanceToNextNew(fromRowKey: string | null) {
    const rows = visibleRows;
    if (rows.length === 0) return;
    const idx = fromRowKey ? rows.findIndex((r) => r.value === fromRowKey) : -1;
    for (let i = 1; i <= rows.length; i++) {
      const j = ((idx < 0 ? -1 : idx) + i + rows.length) % rows.length;
      if (state[rows[j].value]?.status === "new") {
        cursor.setCursor({ rowKey: rows[j].value, field: "value", editing: false });
        return;
      }
    }
  }

  // on mount and every dimension change, drop the cursor on the first
  // unmapped row. lets a user open Mapping and start pressing A/M/S
  // without first clicking a row.
  const focusedSeedRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedSeedRef.current === seedId) return;
    focusedSeedRef.current = seedId;
    advanceToNextNew(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedId]);

  // the staged drafts awaiting commit (incl. teammates' work) — the review set.
  // scoped to still-uncommitted (new) values, matching what commit() actually folds.
  const stagedDrafts = useMemo(
    () => listDrafts(seed.id).filter((d) => d.status === "mapped" && seed.values.find((v) => v.value === d.raw)?.status === "new"),
    [seed, allDrafts],
  );
  const staged = stagedDrafts.map((d) => ({ raw: d.raw, label: d.targetLabel! }));
  const coverage = Math.round((counts.mapped / counts.all) * 100);

  const sql = useMemo(() => {
    if (!staged.length) return "";
    const created = [...new Set(staged.map((s) => s.label))].filter((l) => !seed.canonical.some((c) => c.label === l));
    const dim = created.length
      ? `-- new master records → ${seed.dimTable}\nINSERT INTO ${seed.dimTable} (${seed.keyCol}, label) VALUES\n${created.map((l) => `  ('${keyFor(l)}', '${l.replace(/'/g, "''")}')`).join(",\n")}\nON CONFLICT (${seed.keyCol}) DO NOTHING;\n\n`
      : "";
    const merge = `-- value lookup → ${seed.mapTable}\nMERGE INTO ${seed.mapTable} AS m\nUSING (VALUES\n${staged.map((s) => `  ('${s.raw.replace(/'/g, "''")}', '${keyFor(s.label)}')`).join(",\n")}\n) AS s(raw, ${seed.keyCol})\nON lower(m.raw) = lower(s.raw)\nWHEN NOT MATCHED THEN INSERT (raw, ${seed.keyCol}) VALUES (s.raw, s.${seed.keyCol});`;
    return dim + merge;
  }, [staged, seed]);

  const approveAndCommit = async () => {
    setCommitError(null);
    if (staged.length === 0) return;
    // Optimistic flash — predict count + warehouse rows before the server roundtrip
    // so the success moment lands on click, not 50ms later. Reverted on failure.
    const predictedRows = stagedDrafts.reduce((n, d) => {
      const v = seed.values.find((x) => x.value === d.raw);
      return n + (v ? valueRows(v) : 0);
    }, 0);
    setFlash({ n: staged.length, rows: predictedRows });
    setShowSql(false); setReview(false);
    try {
      const res = await commit(seed.id);      // server folds drafts + returns rows recovered
      if (!res.committed) { setFlash(null); return; }
      setFlash({ n: res.committed, rows: res.rowsRecovered });
      setTimeout(() => setFlash(null), 2800);
    } catch (err) {
      setFlash(null);
      setCommitError(err instanceof Error ? err.message : "Commit failed — check your connection and try again.");
    }
  };

  const FILTERS: { k: Filter; label: string; n: number }[] = [
    { k: "new", label: "Needs review", n: counts.new },
    { k: "all", label: "All", n: counts.all },
    { k: "mapped", label: "Mapped", n: counts.mapped },
  ];

  // Slide the view-mode marker behind the active tab. Recomputes whenever the
  // selection changes OR the buttons themselves resize (dim name, count chip).
  useLayoutEffect(() => {
    const recalc = (): void => {
      const btn = viewMode === "single" ? singleBtnRef.current : allBtnRef.current;
      const parent = btn?.parentElement;
      if (!btn || !parent) return;
      const pBox = parent.getBoundingClientRect();
      const bBox = btn.getBoundingClientRect();
      setTabMarker({ left: bBox.left - pBox.left, width: bBox.width });
    };
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, [viewMode, seed.dimension, crossCounts.new]);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Match values"
        title={`Match ${seed.dimension.toLowerCase()} values`}
        action={
          <Button icon={<IconWand className="h-4 w-4" />} onClick={automap} className="zz-glow-sm">
            {autoFlash !== null ? `✓ Auto-matched ${autoFlash}` : "Auto-match new values"}
          </Button>
        }
      />

      {/* view-mode segmented control — compact, sliding indicator, real type
          hierarchy. Sits left rather than spanning the page; primary modes
          read in display weight while their metadata (dim name / count chip)
          carries the accent splash. */}
      <div
        className="zz-rise relative inline-flex items-stretch self-start rounded-pill border border-line bg-surface-2 p-1"
        style={{ animationDelay: "50ms" }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 rounded-pill bg-surface-elevated shadow-pop-sm ring-1 ring-line transition-[left,width] duration-[var(--dur-slide)] ease-[var(--ease-spring)]"
          style={{ left: tabMarker.left, width: tabMarker.width }}
        />
        <button
          ref={singleBtnRef}
          type="button"
          onClick={() => setViewMode("single")}
          className={cx(
            "relative z-10 inline-flex items-center gap-2.5 rounded-pill px-4 py-2 transition-colors",
            viewMode === "single" ? "text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          <span className="font-display text-[14px] font-semibold leading-none tracking-[-0.01em]">Single dim</span>
          <span className={cx(
            "font-mono text-[10px] uppercase leading-none tracking-[0.18em] transition-colors",
            viewMode === "single" ? "text-accent" : "text-ink-3",
          )}>
            {seed.dimension}
          </span>
        </button>
        <button
          ref={allBtnRef}
          type="button"
          onClick={() => setViewMode("all")}
          className={cx(
            "relative z-10 inline-flex items-center gap-2.5 rounded-pill px-4 py-2 transition-colors",
            viewMode === "all" ? "text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          <span className="font-display text-[14px] font-semibold leading-none tracking-[-0.01em]">All dimensions</span>
          {crossCounts.new > 0 && (
            <span className={cx(
              "inline-flex h-5 min-w-[20px] items-center justify-center rounded-pill px-1.5 font-mono text-[10px] font-semibold leading-none tabular-nums transition-colors",
              viewMode === "all"
                ? "bg-accent text-accent-ink"
                : "bg-surface-3 text-ink-2",
            )}>
              {crossCounts.new}
            </span>
          )}
        </button>
      </div>

      {viewMode === "single" && (
        <>
          {/* dimension picker — choose master data, or create a new one */}
          <div className="zz-rise relative z-30" style={{ animationDelay: "60ms" }}>
            <TablePicker
              dims={dims}
              activeId={seedId}
              onSelect={selectSeed}
              onCreateRequested={() => setCreateOpen(true)}
            />
            <CreateTableModal
              open={createOpen}
              onClose={() => setCreateOpen(false)}
              onCreated={(id) => { selectSeed(id); }}
            />
          </div>

          {/* coverage + (engineer-only) target tables */}
          <StatsBar animationDelay="100ms">
            {engineer && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px]">
                <span className="text-ink-3">master <span className="text-ink">{seed.dimTable}</span></span>
                <span className="text-ink-3">lookup <span className="text-ink">{seed.mapTable}</span></span>
                <span className="text-ink-3">{seed.rows.toLocaleString()} rows · key <span className="text-ink">{seed.keyCol}</span></span>
              </div>
            )}
            <div className={cx("flex items-center gap-3", engineer && "ml-auto")}>
              <div className="h-1.5 w-36 overflow-hidden rounded-pill bg-surface-2"><div className="h-full rounded-pill bg-accent transition-[width] duration-[var(--dur-slide)] ease-[var(--ease-spring)]" style={{ width: `${coverage}%` }} /></div>
              <span className="font-mono text-[11px] text-ink-2 tabular-nums">{coverage}% mapped</span>
              {counts.new > 0 && <Badge tone="warn" dot>{counts.new} need review</Badge>}
            </div>
          </StatsBar>
        </>
      )}

      {viewMode === "single" && (
      /* workbench — single-dim mode */
      <div className="zz-rise rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
        ref={cursor.ref}
        tabIndex={0}
        onKeyDown={(e) => {
          // grid bindings first
          cursor.onKeyDown(e);
          if (e.defaultPrevented) return;
          // Mapping-specific shortcuts (single-key, not editing)
          if (!cursor.cursor) return;
          const cur = cursor.cursor;
          if (cur.editing) return;
          if (e.key === "a" || e.key === "A") { e.preventDefault(); accept(cur.rowKey); return; }
          if (e.key === "s" || e.key === "S") { e.preventDefault(); skip(cur.rowKey); return; }
          if (e.key === "r" || e.key === "R") { e.preventDefault(); reset(cur.rowKey); return; }
          if (e.key === "m" || e.key === "M") { e.preventDefault(); cursor.startEdit(); return; }
          if (e.key === "n" || e.key === "N") { e.preventDefault(); advanceToNextNew(cur.rowKey); return; }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void approveAndCommit(); return; }
        }}
        style={{ animationDelay: "150ms" }}
      >
        {/* toolbar / bulk bar */}
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
          {sel.length === 0 ? (
            <>
              <Checkbox state={headState} onClick={() => setSel(allSel ? [] : visIds)} aria-label="Select all" />
              <div className="flex flex-wrap items-center gap-1.5">
                {FILTERS.map((f) => (
                  <button key={f.k} type="button" onClick={() => setFilter(f.k)}
                    className={cx("rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors", filter === f.k ? "bg-accent-wash text-accent" : "text-ink-3 hover:bg-hover hover:text-ink-2")}>
                    {f.label} <span className="opacity-60">{f.n}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Checkbox state={headState} onClick={() => setSel([])} aria-label="Clear selection" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<IconCheck className="h-3.5 w-3.5" />} onClick={() => void bulkApply(
                  `accept ${sel.length} match${sel.length === 1 ? "" : "es"}`,
                  (v) => { const r = byVal(v); return r.suggestion ? stageMap(v, r.suggestion) : undefined; },
                )}>Accept</Button>
                <div className="w-48"><ComboSelect options={options} value={null} allowCreate={!external} placeholder="Merge all to…" onPick={(t) => void bulkApply(
                  `merge ${sel.length} value${sel.length === 1 ? "" : "s"} → ${t}`,
                  (v) => stageMap(v, t),
                )} /></div>
                <Button variant="secondary" size="sm" icon={<IconX className="h-3.5 w-3.5" />} onClick={() => void bulkApply(
                  `skip ${sel.length} value${sel.length === 1 ? "" : "s"}`,
                  (v) => skipPersist(v),
                )}>Skip</Button>
              </div>
              <button type="button" onClick={() => setSel([])} className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink">clear</button>
            </>
          )}
        </div>

        {/* column header */}
        <div className={cx(COLS, "border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3")}>
          <span /><span>Source value · where it's seen</span><span /><span>{seed.dimension.toLowerCase()} record</span><span>Confidence</span><span>Status</span>
        </div>

        {/* rows */}
        {visible.map((r) => {
          const row = state[r.value];
          const checked = sel.includes(r.value);
          const isOpen = open === r.value;
          const primary = r.sources[0];
          const focused = cursor.cursor?.rowKey === r.value;
          return (
            <Fragment key={r.value}>
              <div className={cx(COLS, "border-b border-line px-4 py-2.5 transition-colors", checked ? "bg-accent-wash" : "hover:bg-hover", isOpen && "border-b-0", focused && "ring-1 ring-accent/60 bg-accent-wash/40")} data-row={r.value} onClick={() => cursor.setCursor({ rowKey: r.value, field: "target", editing: false })}>
                <Checkbox state={checked ? "on" : "off"} onClick={() => setSel((s) => (s.includes(r.value) ? s.filter((x) => x !== r.value) : [...s, r.value]))} aria-label={`Select ${r.value}`} />
                <div className="min-w-0">
                  <div className="truncate font-mono text-[13px] text-ink">{r.value}</div>
                  <button type="button" onClick={() => setOpen(isOpen ? null : r.value)} className="flex items-center gap-1 font-mono text-[10px] text-ink-3 transition-colors hover:text-ink-2">
                    <IconChevron className={cx("h-3 w-3 transition-transform", isOpen && "rotate-180")} />
                    {primary.table}.{primary.column}{r.sources.length > 1 ? ` +${r.sources.length - 1}` : ""} · {valueRows(r).toLocaleString()} rows
                  </button>
                </div>
                <IconArrowRight className="h-4 w-4 text-ink-3" />
                <ComboSelect options={options} value={row.target} suggestion={r.suggestion} allowCreate={!external} onPick={(t) => pick(r.value, t)} />
                <div>
                  {r.confidence > 0 ? (
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-8 overflow-hidden rounded-pill bg-surface-2"><div className={cx("h-full rounded-pill", confBar(r.confidence))} style={{ width: `${r.confidence}%` }} /></div>
                      <span className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}>{r.confidence}</span>
                    </div>
                  ) : <span className="font-mono text-[11px] text-ink-2">—</span>}
                </div>
                <div>{row.status === "mapped"
                  ? <Chip label="Mapped" bucket="chip-1" dot />
                  : row.status === "skipped"
                    ? <Chip label="Skipped" bucket="chip-5" />
                    : <Chip label="New" bucket="chip-2" dot />}</div>
              </div>

              {/* expandable provenance + write target */}
              {isOpen && (
                <div className="border-b border-line bg-surface-2/40 px-4 py-3 pl-[52px]">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">appears in</div>
                  <div className="mt-2 grid gap-1.5">
                    {r.sources.map((o, i) => (
                      <div key={i} className="flex items-center justify-between gap-4 font-mono text-[11.5px]">
                        <span className="text-ink-2">{o.table}<span className="text-ink-3">.{o.column}</span></span>
                        <span className="text-ink-3 tabular-nums">{o.rows.toLocaleString()} rows{r.firstSeen ? ` · seen ${r.firstSeen}` : ""}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 font-mono text-[10.5px] text-ink-3">
                    {row.target
                      ? engineer
                        ? <>→ writes <span className="text-accent">('{r.value}', '{keyFor(row.target)}')</span> to {seed.mapTable}</>
                        : <>→ will resolve to <span className="text-accent">{row.target}</span> in {seed.dimension}</>
                      : engineer
                        ? <>⚠ unresolved — these {valueRows(r).toLocaleString()} rows currently <span className="text-danger">LEFT JOIN to NULL</span></>
                        : <>⚠ <span className="text-danger">Unmapped</span> — {valueRows(r).toLocaleString()} downstream rows are missing this value</>}
                  </div>
                  {(() => {
                    const d = allDrafts[dkey(seed.id, r.value)];
                    return d ? (
                      <div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                        <span className="grid h-4 w-4 place-items-center rounded-pill bg-surface-3 text-[8px] text-ink-2">{d.user.initials}</span>
                        staged {d.status === "skipped" ? "(skipped) " : ""}by {d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}{engineer ? " · uncommitted draft" : " · awaiting publish"}
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
              {focused && !isOpen && (
                <div className="border-b border-line bg-surface-2/40 px-4 py-1.5 pl-[52px] font-mono text-[10.5px] text-ink-3">
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">A</kbd> accept</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">M</kbd> record</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">S</kbd> skip</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">R</kbd> reset</span>
                  <span className="mr-3"><kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">?</kbd> all shortcuts</span>
                </div>
              )}
            </Fragment>
          );
        })}
        {visible.length === 0 && (filter === "new" ? (
          <div className="px-4 py-10 text-center">
            <div className="font-display text-[18px] font-semibold text-ink">{seed.dimension} is fully matched 🎉</div>
            {nextDims.filter((x) => x.id !== seedId).length > 0 ? (
              <>
                <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">Pick the next dimension with work</div>
                <div className="mx-auto mt-4 grid max-w-md gap-1.5">
                  {nextDims.filter((x) => x.id !== seedId).slice(0, 6).map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      onClick={() => selectSeed(x.id)}
                      className="flex items-center justify-between gap-3 rounded-sm border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-line-2 hover:bg-hover"
                    >
                      <span className="font-display text-[13px] text-ink">{x.name}</span>
                      <span className="font-mono text-[11px] text-ink-2 tabular-nums">{x.count} need{x.count === 1 ? "s" : ""} review</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">Nothing left to reconcile across all dimensions.</div>
            )}
          </div>
        ) : (
          <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">no values in this view</div>
        ))}

        {/* review & commit footer — drafts stage in Postgres, commit batch-MERGEs to DuckDB */}
        <div className="sticky bottom-0 z-20 border-t border-line bg-surface">
          {commitError && (
            <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
              <span>Commit failed — {commitError}</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCommitError(null)}>Dismiss</Button>
                <Button size="sm" onClick={() => void approveAndCommit()}>Retry</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="font-mono text-[11px] text-ink-2">
              {flash
                ? <span className="zz-rise text-committed" style={{ animationDuration: "var(--dur-slide)" }}>
                    ✓ {flash.n} {engineer ? "draft" : "change"}{flash.n === 1 ? "" : "s"}{" "}
                    {engineer ? <>merged into {seed.mapTable}</> : <>published to {seed.dimension}</>}
                    {" · "}{flash.rows.toLocaleString()} rows recovered
                  </span>
                : staged.length > 0
                  ? engineer
                    ? <>{staged.length} staged draft{staged.length === 1 ? "" : "s"} → batch MERGE to <span className="text-ink-2">{seed.dimTable}</span> + <span className="text-ink-2">{seed.mapTable}</span></>
                    : <>{staged.length} change{staged.length === 1 ? "" : "s"} ready to publish to <span className="text-ink-2">{seed.dimension}</span></>
                  : <>nothing to publish yet — accept or merge values above to stage them</>}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!undo.canUndo} onClick={() => void undo.undo()} title={undo.topLabel ?? undefined}>
                ↶ Undo
                {undo.topLabel && <span className="ml-1.5 inline-block max-w-[140px] truncate align-bottom text-[11px] text-ink-3">{undo.topLabel}</span>}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
              </Button>
              <Button variant="ghost" size="sm" disabled={staged.length === 0} onClick={() => setReview((s) => !s)}>{review ? "Hide review" : `Review ${staged.length}`}</Button>
              {engineer && (
                <Button variant="secondary" size="sm" disabled={staged.length === 0} onClick={() => setShowSql((s) => !s)}>{showSql ? "Hide SQL" : "Preview SQL"}</Button>
              )}
              <Button size="sm" disabled={staged.length === 0} onClick={approveAndCommit}>
                {engineer ? `Approve & commit ${staged.length}` : `Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘↵</span>
              </Button>
            </div>
          </div>
          {review && staged.length > 0 && (
            <div className="border-t border-line">
              <div className="px-5 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">Staged for review · {stagedDrafts.length}</div>
              <ul className="mt-1 max-h-64 divide-y divide-line overflow-y-auto">
                {stagedDrafts.map((d) => (
                  <li key={d.raw} className="flex items-center gap-3 px-5 py-2.5 font-mono text-[11.5px]">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-pill bg-surface-3 text-[9px] text-ink-2" title={d.user.name}>{d.user.initials}</span>
                    <span className="min-w-0 max-w-[40%] truncate text-ink">{d.raw}</span>
                    <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 truncate text-accent">{d.targetLabel}</span>
                    <span className="ml-auto shrink-0 text-ink-2 tabular-nums">{d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {showSql && staged.length > 0 && (
            <pre className="overflow-x-auto border-t border-line bg-bg px-5 py-4 font-mono text-[11.5px] leading-relaxed text-ink-2">{sql}</pre>
          )}
        </div>
      </div>
      )}

      {viewMode === "all" && <CrossDimInbox
        rows={visibleCross}
        counts={crossCounts}
        filter={filter}
        setFilter={setFilter}
        cursor={crossCursor}
        setCursor={setCrossCursor}
        accept={acceptCross}
        skip={skipCross}
        pick={pickCross}
        advanceNext={advanceCrossNext}
        dimById={dimById}
        stagedAllCount={stagedAllDrafts.length}
        commitAll={approveAndCommitAll}
        commitError={commitError}
        setCommitError={setCommitError}
        flash={flash}
        undo={undo}
      />}
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
  dimById: Map<string, import("../data").MappingDimension>;
  stagedAllCount: number;
  commitAll: () => void;
  commitError: string | null;
  setCommitError: (e: string | null) => void;
  flash: { n: number; rows: number } | null;
  undo: ReturnType<typeof useUndoStack>;
}

const COLS_CROSS = "grid grid-cols-[120px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px] items-center gap-3";

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
      className="zz-rise rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); return; }
        if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); return; }
        if (!p.cursor) return;
        if (e.key === "a" || e.key === "A") { e.preventDefault(); p.accept(p.cursor.dimId, p.cursor.raw); return; }
        if (e.key === "s" || e.key === "S") { e.preventDefault(); p.skip(p.cursor.dimId, p.cursor.raw); return; }
        if (e.key === "n" || e.key === "N") { e.preventDefault(); p.advanceNext(p.cursor.dimId, p.cursor.raw); return; }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); p.commitAll(); return; }
      }}
      style={{ animationDelay: "150ms" }}
    >
      {/* toolbar — sticky filter chips */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.k} type="button" onClick={() => p.setFilter(f.k)}
              className={cx("rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors", p.filter === f.k ? "bg-accent-wash text-accent" : "text-ink-3 hover:bg-hover hover:text-ink-2")}>
              {f.label} <span className="opacity-60">{f.n}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-ink-3">
          ranked by impact · J/K navigate · A accept · S skip · N next · ⌘↵ publish
        </span>
      </div>

      {/* column header */}
      <div className={cx(COLS_CROSS, "border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3")}>
        <span>Dimension</span><span>Source value</span><span /><span>Record</span><span>Confidence</span><span>Status</span>
      </div>

      {/* rows */}
      {p.rows.length === 0 ? (
        <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
          {p.filter === "new" ? "🎉 nothing left to reconcile across all dimensions" : "no values in this view"}
        </div>
      ) : p.rows.slice(0, 500).map((r) => {
        const key = `${r.dimId}::${r.raw}`;
        const focused = curKey === key;
        const dim = p.dimById.get(r.dimId);
        const options = dim?.canonical.map((c) => c.label) ?? [];
        const external = dim?.keyKind === "external_id";
        return (
          <div
            key={key}
            className={cx(COLS_CROSS, "border-b border-line px-4 py-2.5 transition-colors hover:bg-hover", focused && "ring-1 ring-accent/60 bg-accent-wash/40")}
            onClick={() => p.setCursor({ dimId: r.dimId, raw: r.raw })}
          >
            <span><Chip label={r.dimName} bucket="chip-3" /></span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[13px] text-ink">{r.raw}</div>
              <div className="font-mono text-[10px] text-ink-2 tabular-nums">{r.dimRows.toLocaleString()} rows in warehouse</div>
            </div>
            <IconArrowRight className="h-4 w-4 text-ink-3" />
            <ComboSelect
              options={options} value={r.target}
              suggestion={r.suggestion ?? undefined}
              allowCreate={!external}
              onPick={(t) => p.pick(r.dimId, r.raw, t)}
            />
            <div>
              {r.confidence > 0 ? (
                <div className="flex items-center gap-2">
                  <div className="h-1 w-8 overflow-hidden rounded-pill bg-surface-2"><div className={cx("h-full rounded-pill", confBar(r.confidence))} style={{ width: `${r.confidence}%` }} /></div>
                  <span className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}>{r.confidence}</span>
                </div>
              ) : <span className="font-mono text-[11px] text-ink-2">—</span>}
            </div>
            <div>{r.status === "mapped"
              ? <Chip label="Mapped" bucket="chip-1" dot />
              : r.status === "skipped"
                ? <Chip label="Skipped" bucket="chip-5" />
                : <Chip label="New" bucket="chip-2" dot />}</div>
          </div>
        );
      })}

      {/* footer — multi-dim commit */}
      <div className="sticky bottom-0 z-20 border-t border-line bg-surface">
        {p.commitError && (
          <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
            <span>Commit failed — {p.commitError}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => p.setCommitError(null)}>Dismiss</Button>
              <Button size="sm" onClick={() => p.commitAll()}>Retry</Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="font-mono text-[11px] text-ink-2">
            {p.flash ? (
              <span className="zz-rise text-committed" style={{ animationDuration: "var(--dur-slide)" }}>✓ {p.flash.n} change{p.flash.n === 1 ? "" : "s"} published · {p.flash.rows.toLocaleString()} rows recovered</span>
            ) : p.stagedAllCount > 0 ? (
              <>{p.stagedAllCount} change{p.stagedAllCount === 1 ? "" : "s"} staged across dimensions, ready to publish</>
            ) : (
              <>nothing to publish yet — accept or merge values above to stage them</>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={!p.undo.canUndo} onClick={() => void p.undo.undo()} title={p.undo.topLabel ?? undefined}>
              ↶ Undo
              {p.undo.topLabel && <span className="ml-1.5 inline-block max-w-[140px] truncate align-bottom text-[11px] text-ink-3">{p.undo.topLabel}</span>}
              <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
            </Button>
            <Button size="sm" disabled={p.stagedAllCount === 0} onClick={() => p.commitAll()}>
              Publish {p.stagedAllCount} change{p.stagedAllCount === 1 ? "" : "s"}
              <span className="ml-2 font-mono text-[10px] opacity-60">⌘↵</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
