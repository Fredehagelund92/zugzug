import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { ComboSelect } from "../ComboSelect";
import { Chip, useGridCursor, useUndoStack } from "../datagrid";
import type { ColumnDef } from "../datagrid";
import { IconArrowRight, IconCheck, IconChevron, IconWand, IconX } from "../Icons";
import { cx } from "../../lib/cx";
import { useEngineerMode } from "../../lib/engineer-mode";
import { valueRows } from "../../data";
import type { MappingDimension, MappingValue } from "../../data";
import {
  commit,
  currentUser,
  discardDraft,
  dkey,
  listDrafts,
  saveDraft,
  useDrafts,
} from "../../store";

/* MatchModeBody — the per-tab single-dim Match workbench. Lifted from the
   monolithic Mapping route so each open table mounts its own scoped instance
   under TablePane's UndoStackProvider. Cross-dim triage lives in /app/triage
   now; this body only ever knows about one `dim`. */

type RStatus = "mapped" | "new" | "skipped";
type ValueState = Record<string, { target: string | null; status: RStatus }>;
type Filter = "new" | "all" | "mapped";

const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger/30");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");
const COLS =
  "grid max-md:grid-cols-[28px_1fr] md:grid-cols-[28px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px] items-center gap-3";

// Escape a string for use inside a double-quoted CSS attribute selector.
const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Brief accent-wash on a row after the user acted on it (Accept/Skip/Pick).
// Defers to next frame so React has rendered any state-driven className
// change before we layer the animation on top; the force-reflow lets a
// rapid second action on the same row retrigger the animation.
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

function useSessionState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (window.sessionStorage.getItem(key) as T) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      window.sessionStorage.setItem(key, next);
    } catch {
      /* ignore quota / disabled storage */
    }
  };
  return [v, set];
}

interface MatchModeBodyProps {
  /** Fully resolved dimension. Parent guarantees non-null. */
  dim: MappingDimension;
  /** Whether this pane is currently the active tab. Drives URL-mirroring of
   *  focused row — only the active pane writes/reads ?value=. */
  isActive: boolean;
}

export function MatchModeBody({ dim, isActive }: MatchModeBodyProps) {
  const allDrafts = useDrafts();
  const { engineer } = useEngineerMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const undo = useUndoStack();

  const [sel, setSel] = useState<string[]>([]);
  // Filter persists in session so re-opening a tab keeps the user's last lens.
  // Per-dim scoping isn't needed — most users keep "new" anyway and the win is
  // not having the filter snap back on every dim switch.
  const [filter, setFilter] = useSessionState<Filter>("zz:mapping:filter", "new");
  const [open, setOpen] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [review, setReview] = useState(false);
  const [flash, setFlash] = useState<{ n: number; rows: number } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [autoFlash, setAutoFlash] = useState<number | null>(null);

  const byVal = (v: string) => dim.values.find((r) => r.value === v)!;
  const keyFor = (label: string) =>
    dim.canonical.find((c) => c.label === label)?.key ??
    label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const options = dim.canonical.map((c) => c.label);
  const external = dim.keyKind === "external_id";

  // committed truth (dim) overlaid with each value's pending draft, if any
  const state: ValueState = useMemo(
    () =>
      Object.fromEntries(
        dim.values.map((v) => {
          const d = allDrafts[dkey(dim.id, v.value)];
          return [
            v.value,
            d
              ? { target: d.targetLabel, status: d.status }
              : { target: v.current, status: v.current ? "mapped" : "new" },
          ];
        }),
      ),
    [dim, allDrafts],
  );

  const counts = useMemo(() => {
    const c = { all: dim.values.length, new: 0, mapped: 0, skipped: 0 };
    for (const v of dim.values) c[state[v.value]?.status ?? "new"]++;
    return c;
  }, [dim, state]);

  const stageMap = (v: string, label: string) => {
    const prev = allDrafts[dkey(dim.id, v)];
    undo.push({
      label: `match "${v}" → ${label}`,
      surface: "Match",
      apply: () => saveDraft(dim.id, v, "mapped", label, keyFor(label)),
      inverse: () =>
        prev
          ? saveDraft(dim.id, v, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dim.id, v),
    });
    return saveDraft(dim.id, v, "mapped", label, keyFor(label));
  };
  const accept = (v: string) => {
    const r = byVal(v);
    if (!r.suggestion) return;
    void stageMap(v, r.suggestion);
    flashRow(`[data-row="${attrEsc(v)}"]`);
    advanceToNextNew(v);
  };
  const pick = (v: string, t: string) => {
    void stageMap(v, t);
    flashRow(`[data-row="${attrEsc(v)}"]`);
    advanceToNextNew(v);
  };
  // Skip without advancing the cursor — bulkApply uses this so the cursor
  // doesn't bounce when skipping a selection. The single-action `skip` below
  // composes this + advanceToNextNew.
  const skipPersist = (v: string) => {
    const prev = allDrafts[dkey(dim.id, v)];
    undo.push({
      label: `skip "${v}"`,
      surface: "Match",
      apply: () => saveDraft(dim.id, v, "skipped", null, null),
      inverse: () =>
        prev
          ? saveDraft(dim.id, v, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dim.id, v),
    });
    return saveDraft(dim.id, v, "skipped", null, null);
  };
  const skip = (v: string) => {
    void skipPersist(v);
    flashRow(`[data-row="${attrEsc(v)}"]`);
    advanceToNextNew(v);
  };
  const reset = (v: string) => {
    const prev = allDrafts[dkey(dim.id, v)];
    if (!prev) return;
    undo.push({
      label: `reset "${v}"`,
      surface: "Match",
      apply: () => discardDraft(dim.id, v),
      inverse: () => saveDraft(dim.id, v, prev.status, prev.targetLabel, prev.targetKey),
    });
    return discardDraft(dim.id, v);
  };
  // Bulk operations: collect saveDraft promises, fire in parallel, wrap every
  // per-value undo entry in one compound entry. One Cmd+Z restores the whole
  // batch and N values commit as 1 network round-trip instead of N sequential.
  const automap = async () => {
    const matches = dim.values.filter(
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

  // Drop a single staged draft from the review panel. Undo-able so reviewers
  // can take a value back.
  const discardStaged = (raw: string) => {
    const prev = allDrafts[dkey(dim.id, raw)];
    if (!prev) return;
    undo.push({
      label: `discard "${raw}"`,
      surface: "Match",
      apply: () => discardDraft(dim.id, raw),
      inverse: () => saveDraft(dim.id, raw, prev.status, prev.targetLabel, prev.targetKey),
    });
    void discardDraft(dim.id, raw);
  };

  const visible = dim.values.filter((v) => filter === "all" || state[v.value]?.status === filter);
  const visIds = visible.map((v) => v.value);
  const allSel = visIds.length > 0 && visIds.every((id) => sel.includes(id));
  const headState: "on" | "off" | "mixed" = allSel ? "on" : sel.length ? "mixed" : "off";

  const visibleRows = visible; // alias for clarity
  const COLS_FOR_CURSOR: ColumnDef<MappingValue>[] = [
    { field: "value", label: "Source", config: { type: "text" }, editable: false },
    { field: "target", label: "Record", config: { type: "text" }, editable: true },
    { field: "status", label: "Status", config: { type: "text" }, editable: false },
  ];
  const cursor = useGridCursor<MappingValue>({
    rows: visibleRows,
    rowKey: (r) => r.value,
    columns: COLS_FOR_CURSOR,
    onSelectAll: () => setSel(visIds),
    onUndo: () => void undo.undo(),
    onRedo: () => void undo.redo(),
    onFocusFilter: () => {
      /* filter chips already global */
    },
  });

  // advance the cursor to the next visible row whose status is "new",
  // wrapping around once. used by accept/skip/pick/N to keep the user
  // moving through the inbox without reaching for the mouse.
  const advanceToNextNew = useCallback(
    (fromRowKey: string | null) => {
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
    },
    [visibleRows, state, cursor],
  );

  // ── Deep-linking ─────────────────────────────────────────────────────────
  // URL ?value=… pins the focused row so a teammate can Slack a link to a
  // specific mapping decision. Consumed once on the first dim where it
  // matches, then cleared from the ref so subsequent dim switches auto-
  // advance normally. Only fires when this pane is the active tab — inactive
  // panes shouldn't pin the cursor based on a URL that belongs to another tab.
  const initialUrlValueRef = useRef<string | null>(isActive ? searchParams.get("value") : null);

  // on mount and every dim change, drop the cursor on the first unmapped row
  // — unless the URL pinned a value present in this dim. Lets a user open
  // Match and start pressing A/M/S without clicking.
  const focusedDimRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedDimRef.current === dim.id) return;
    focusedDimRef.current = dim.id;
    const pinned = initialUrlValueRef.current;
    if (pinned && dim.values.some((r) => r.value === pinned)) {
      cursor.setCursor({ rowKey: pinned, field: "target", editing: false });
      initialUrlValueRef.current = null;
      return;
    }
    advanceToNextNew(null);
  }, [dim.id, dim.values, cursor, advanceToNextNew]);

  // Mirror the focused row to URL ?value=… while this pane is active. When
  // inactive we leave the URL alone so we don't clobber another tab's value
  // (the URL contract: ?value= belongs to the active match-mode tab).
  useEffect(() => {
    if (!isActive) return;
    const want = cursor.cursor?.rowKey ?? null;
    setSearchParams(
      (prev) => {
        const have = prev.get("value");
        if (want == null && have == null) return prev;
        if (want === have) return prev;
        if (want == null) prev.delete("value");
        else prev.set("value", want);
        return prev;
      },
      { replace: true },
    );
  }, [isActive, cursor.cursor?.rowKey, setSearchParams]);

  // the staged drafts awaiting commit (incl. teammates' work) — the review
  // set. Scoped to still-uncommitted (new) values, matching what commit()
  // actually folds.
  const stagedDrafts = useMemo(
    () =>
      listDrafts(dim.id).filter(
        (d) => d.status === "mapped" && dim.values.find((v) => v.value === d.raw)?.status === "new",
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dim, allDrafts],
  );
  const staged = stagedDrafts.map((d) => ({ raw: d.raw, label: d.targetLabel! }));

  const sql = useMemo(() => {
    if (!staged.length) return "";
    const created = [...new Set(staged.map((s) => s.label))].filter(
      (l) => !dim.canonical.some((c) => c.label === l),
    );
    const dimSql = created.length
      ? `-- new master records → ${dim.dimTable}\nINSERT INTO ${dim.dimTable} (${dim.keyCol}, label) VALUES\n${created.map((l) => `  ('${keyFor(l)}', '${l.replace(/'/g, "''")}')`).join(",\n")}\nON CONFLICT (${dim.keyCol}) DO NOTHING;\n\n`
      : "";
    const merge = `-- value lookup → ${dim.mapTable}\nMERGE INTO ${dim.mapTable} AS m\nUSING (VALUES\n${staged.map((s) => `  ('${s.raw.replace(/'/g, "''")}', '${keyFor(s.label)}')`).join(",\n")}\n) AS s(raw, ${dim.keyCol})\nON lower(m.raw) = lower(s.raw)\nWHEN NOT MATCHED THEN INSERT (raw, ${dim.keyCol}) VALUES (s.raw, s.${dim.keyCol});`;
    return dimSql + merge;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, dim]);

  const approveAndCommit = async () => {
    setCommitError(null);
    if (staged.length === 0) return;
    // Optimistic flash — predict count + warehouse rows before the server
    // round-trip so the success moment lands on click, not 50ms later.
    // Reverted on failure.
    const predictedRows = stagedDrafts.reduce((n, d) => {
      const v = dim.values.find((x) => x.value === d.raw);
      return n + (v ? valueRows(v) : 0);
    }, 0);
    setFlash({ n: staged.length, rows: predictedRows });
    setShowSql(false);
    setReview(false);
    try {
      const res = await commit(dim.id); // server folds drafts + returns rows recovered
      if (!res.committed) {
        setFlash(null);
        return;
      }
      setFlash({ n: res.committed, rows: res.rowsRecovered });
      setTimeout(() => setFlash(null), 2800);
    } catch (err) {
      setFlash(null);
      setCommitError(
        err instanceof Error ? err.message : "Commit failed — check your connection and try again.",
      );
    }
  };

  const FILTERS: { k: Filter; label: string; n: number }[] = [
    { k: "new", label: "Needs review", n: counts.new },
    { k: "all", label: "All", n: counts.all },
    { k: "mapped", label: "Mapped", n: counts.mapped },
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* small left-aligned toolbar above the body — owns Auto-match per spec § 1 */}
      {counts.new > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
          <Button
            size="sm"
            variant="ghost"
            icon={<IconWand className="h-3.5 w-3.5" />}
            onClick={automap}
            className="zz-glow-sm"
          >
            {autoFlash !== null ? `✓ Auto-matched ${autoFlash}` : "Auto-match new values"}
          </Button>
        </div>
      )}

      {/* workbench — single-dim mode */}
      <div
        className="flex flex-1 flex-col min-h-0 outline-none focus:ring-1 focus:ring-accent/40"
        ref={cursor.ref}
        tabIndex={0}
        onKeyDown={(e) => {
          // grid bindings first
          cursor.onKeyDown(e);
          if (e.defaultPrevented) return;
          // Match-specific shortcuts (single-key, not editing)
          if (!cursor.cursor) return;
          const cur = cursor.cursor;
          if (cur.editing) return;
          if (e.key === "a" || e.key === "A") {
            e.preventDefault();
            accept(cur.rowKey);
            return;
          }
          if (e.key === "s" || e.key === "S") {
            e.preventDefault();
            skip(cur.rowKey);
            return;
          }
          if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            reset(cur.rowKey);
            return;
          }
          if (e.key === "m" || e.key === "M") {
            e.preventDefault();
            cursor.startEdit();
            return;
          }
          if (e.key === "n" || e.key === "N") {
            e.preventDefault();
            advanceToNextNew(cur.rowKey);
            return;
          }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void approveAndCommit();
            return;
          }
        }}
      >
        {/* toolbar / bulk bar */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
          {sel.length === 0 ? (
            <>
              <Checkbox
                state={headState}
                onClick={() => setSel(allSel ? [] : visIds)}
                aria-label="Select all"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.k}
                    type="button"
                    onClick={() => setFilter(f.k)}
                    className={cx(
                      "rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors",
                      filter === f.k
                        ? "bg-accent-wash text-accent"
                        : "text-ink-3 hover:bg-hover hover:text-ink-2",
                    )}
                  >
                    {f.label} <span className="opacity-60">{f.n}</span>
                  </button>
                ))}
              </div>
              {counts.new > 0 && (
                <Badge tone="warn" dot>
                  {counts.new} need review
                </Badge>
              )}
            </>
          ) : (
            <>
              <Checkbox state={headState} onClick={() => setSel([])} aria-label="Clear selection" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  icon={<IconCheck className="h-3.5 w-3.5" />}
                  onClick={() =>
                    void bulkApply(
                      `accept ${sel.length} match${sel.length === 1 ? "" : "es"}`,
                      (v) => {
                        const r = byVal(v);
                        return r.suggestion ? stageMap(v, r.suggestion) : undefined;
                      },
                    )
                  }
                >
                  Accept
                </Button>
                <div className="w-48">
                  <ComboSelect
                    options={options}
                    value={null}
                    allowCreate={!external}
                    placeholder="Merge all to…"
                    onPick={(t) =>
                      void bulkApply(
                        `merge ${sel.length} value${sel.length === 1 ? "" : "s"} → ${t}`,
                        (v) => stageMap(v, t),
                      )
                    }
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconX className="h-3.5 w-3.5" />}
                  onClick={() =>
                    void bulkApply(`skip ${sel.length} value${sel.length === 1 ? "" : "s"}`, (v) =>
                      skipPersist(v),
                    )
                  }
                >
                  Skip
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setSel([])}
                className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink"
              >
                clear
              </button>
            </>
          )}
        </div>

        {/* column header */}
        <div
          className={cx(
            COLS,
            "border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3",
          )}
        >
          <span />
          <span>Source value · where it&apos;s seen</span>
          <span className="max-md:hidden" />
          <span className="max-md:hidden">{dim.dimension.toLowerCase()} record</span>
          <span className="max-md:hidden">Confidence</span>
          <span className="max-md:hidden">Status</span>
        </div>

        {/* rows */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {visible.map((r) => {
            const row = state[r.value];
            const checked = sel.includes(r.value);
            const isOpen = open === r.value;
            const primary = r.sources[0];
            const focused = cursor.cursor?.rowKey === r.value;
            return (
              <Fragment key={r.value}>
                <div
                  className={cx(
                    COLS,
                    "border-b border-line px-4 py-2.5 transition-colors",
                    checked ? "bg-accent-wash" : "hover:bg-hover",
                    isOpen && "border-b-0",
                    focused && "ring-1 ring-accent/60 bg-accent-wash/40",
                  )}
                  data-row={r.value}
                  onClick={() =>
                    cursor.setCursor({ rowKey: r.value, field: "target", editing: false })
                  }
                >
                  <Checkbox
                    state={checked ? "on" : "off"}
                    onClick={() =>
                      setSel((s) =>
                        s.includes(r.value) ? s.filter((x) => x !== r.value) : [...s, r.value],
                      )
                    }
                    aria-label={`Select ${r.value}`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="truncate font-mono text-[13px] text-ink">{r.value}</div>
                      <span className="md:hidden">
                        {row.status === "mapped" ? (
                          <Chip label="Mapped" bucket="chip-1" dot />
                        ) : row.status === "skipped" ? (
                          <Chip label="Skipped" bucket="chip-5" />
                        ) : (
                          <Chip label="New" bucket="chip-2" dot />
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : r.value)}
                      className="flex items-center gap-1 font-mono text-[10px] text-ink-3 transition-colors hover:text-ink-2"
                    >
                      <IconChevron
                        className={cx("h-3 w-3 transition-transform", isOpen && "rotate-180")}
                      />
                      {primary.table}.{primary.column}
                      {r.sources.length > 1 ? ` +${r.sources.length - 1}` : ""} ·{" "}
                      {valueRows(r).toLocaleString()} rows
                    </button>
                    <div className="mt-1.5 md:hidden">
                      <ComboSelect
                        options={options}
                        value={row.target}
                        suggestion={r.suggestion}
                        allowCreate={!external}
                        onPick={(t) => pick(r.value, t)}
                      />
                    </div>
                  </div>
                  <IconArrowRight className="max-md:hidden h-4 w-4 text-ink-3" />
                  <div className="max-md:hidden">
                    <ComboSelect
                      options={options}
                      value={row.target}
                      suggestion={r.suggestion}
                      allowCreate={!external}
                      onPick={(t) => pick(r.value, t)}
                    />
                  </div>
                  <div className="max-md:hidden">
                    {r.confidence > 0 ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-8 overflow-hidden rounded-pill bg-surface-2">
                          <div
                            className={cx("h-full rounded-pill", confBar(r.confidence))}
                            style={{ width: `${r.confidence}%` }}
                          />
                        </div>
                        <span
                          className={cx(
                            "font-mono text-[11px] tabular-nums",
                            confText(r.confidence),
                          )}
                        >
                          {r.confidence}
                        </span>
                      </div>
                    ) : (
                      <span className="font-mono text-[11px] text-ink-2">—</span>
                    )}
                  </div>
                  <div className="max-md:hidden">
                    {row.status === "mapped" ? (
                      <Chip label="Mapped" bucket="chip-1" dot />
                    ) : row.status === "skipped" ? (
                      <Chip label="Skipped" bucket="chip-5" />
                    ) : (
                      <Chip label="New" bucket="chip-2" dot />
                    )}
                  </div>
                </div>

                {/* expandable provenance + write target */}
                {isOpen && (
                  <div className="border-b border-line bg-surface-2/40 px-4 py-3 pl-[52px]">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                      appears in
                    </div>
                    <div className="mt-2 grid gap-1.5">
                      {r.sources.map((o, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between gap-4 font-mono text-[11.5px]"
                        >
                          <span className="text-ink-2">
                            {o.table}
                            <span className="text-ink-3">.{o.column}</span>
                          </span>
                          <span className="text-ink-3 tabular-nums">
                            {o.rows.toLocaleString()} rows
                            {r.firstSeen ? ` · seen ${r.firstSeen}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 font-mono text-[10.5px] text-ink-3">
                      {row.target ? (
                        engineer ? (
                          <>
                            → writes{" "}
                            <span className="text-accent">
                              (&***REMOVED***39;{r.value}&***REMOVED***39;, &***REMOVED***39;{keyFor(row.target)}&***REMOVED***39;)
                            </span>{" "}
                            to {dim.mapTable}
                          </>
                        ) : (
                          <>
                            → will resolve to <span className="text-accent">{row.target}</span> in{" "}
                            {dim.dimension}
                          </>
                        )
                      ) : engineer ? (
                        <>
                          ⚠ unresolved — these {valueRows(r).toLocaleString()} rows currently{" "}
                          <span className="text-danger">LEFT JOIN to NULL</span>
                        </>
                      ) : (
                        <>
                          ⚠ <span className="text-danger">Unmapped</span> —{" "}
                          {valueRows(r).toLocaleString()} downstream rows are missing this value
                        </>
                      )}
                    </div>
                    {(() => {
                      const d = allDrafts[dkey(dim.id, r.value)];
                      return d ? (
                        <div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                          <span className="grid h-4 w-4 place-items-center rounded-pill bg-surface-3 text-[8px] text-ink-2">
                            {d.user.initials}
                          </span>
                          staged {d.status === "skipped" ? "(skipped) " : ""}by{" "}
                          {d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}
                          {engineer ? " · uncommitted draft" : " · awaiting publish"}
                        </div>
                      ) : null;
                    })()}
                  </div>
                )}
                {focused && !isOpen && (
                  <div className="border-b border-line bg-surface-2/40 px-4 py-1.5 pl-[52px] font-mono text-[10.5px] text-ink-3">
                    <span className="mr-3">
                      <kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">
                        A
                      </kbd>{" "}
                      accept
                    </span>
                    <span className="mr-3">
                      <kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">
                        M
                      </kbd>{" "}
                      record
                    </span>
                    <span className="mr-3">
                      <kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">
                        S
                      </kbd>{" "}
                      skip
                    </span>
                    <span className="mr-3">
                      <kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">
                        R
                      </kbd>{" "}
                      reset
                    </span>
                    <span className="mr-3">
                      <kbd className="rounded border border-line-2 bg-surface px-1 text-[10px] text-ink">
                        ?
                      </kbd>{" "}
                      all shortcuts
                    </span>
                  </div>
                )}
              </Fragment>
            );
          })}
          {visible.length === 0 &&
            (filter === "new" ? (
              <div className="px-4 py-10 text-center">
                <div className="font-display text-[18px] font-semibold text-ink">
                  {dim.dimension} is fully matched 🎉
                </div>
                <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">
                  See what else needs attention across all tables.
                </div>
                <div className="mt-4">
                  <Link to="/app/triage">
                    <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
                      Open Triage
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
                no values in this view
              </div>
            ))}
        </div>

        {/* review & commit footer — drafts stage in Postgres, commit batch-MERGEs to DuckDB */}
        <div className="sticky bottom-0 z-10 border-t border-line bg-surface">
          {commitError && (
            <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
              <span>Commit failed — {commitError}</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCommitError(null)}>
                  Dismiss
                </Button>
                <Button size="sm" onClick={() => void approveAndCommit()}>
                  Retry
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="font-mono text-[11px] text-ink-2">
              {flash ? (
                <span
                  className="zz-rise text-committed"
                  style={{ animationDuration: "var(--dur-slide)" }}
                >
                  ✓ {flash.n} {engineer ? "draft" : "change"}
                  {flash.n === 1 ? "" : "s"}{" "}
                  {engineer ? <>merged into {dim.mapTable}</> : <>published to {dim.dimension}</>}
                  {" · "}
                  {flash.rows.toLocaleString()} rows recovered
                </span>
              ) : staged.length > 0 ? (
                engineer ? (
                  <>
                    {staged.length} staged draft{staged.length === 1 ? "" : "s"} → batch MERGE to{" "}
                    <span className="text-ink-2">{dim.dimTable}</span> +{" "}
                    <span className="text-ink-2">{dim.mapTable}</span>
                  </>
                ) : (
                  <>
                    {staged.length} change{staged.length === 1 ? "" : "s"} ready to publish to{" "}
                    <span className="text-ink-2">{dim.dimension}</span>
                  </>
                )
              ) : (
                <>nothing to publish yet — accept or merge values above to stage them</>
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!undo.canUndo}
                onClick={() => void undo.undo()}
                title={undo.topLabel ?? undefined}
              >
                ↶ Undo
                {undo.topSurface && (
                  <span className="ml-1.5 font-mono text-[10px] text-ink-3">
                    ({undo.topSurface})
                  </span>
                )}
                {undo.topLabel && (
                  <span className="ml-1.5 inline-block max-w-[140px] truncate align-bottom text-[11px] text-ink-3">
                    {undo.topLabel}
                  </span>
                )}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={staged.length === 0}
                onClick={() => setReview((s) => !s)}
              >
                {review ? "Hide review" : `Review ${staged.length}`}
              </Button>
              {engineer && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={staged.length === 0}
                  onClick={() => setShowSql((s) => !s)}
                >
                  {showSql ? "Hide SQL" : "Preview SQL"}
                </Button>
              )}
              <Button size="sm" disabled={staged.length === 0} onClick={approveAndCommit}>
                {engineer
                  ? `Approve & commit ${staged.length}`
                  : `Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘↵</span>
              </Button>
            </div>
          </div>
          {review && staged.length > 0 && (
            <div className="border-t border-line">
              <div className="px-5 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">
                Staged for review · {stagedDrafts.length}
              </div>
              {/* Grouped by target canonical record so duplicates collapse into
                  "→ X (N)" and the reviewer can scan what's about to land. */}
              <div className="mt-1 max-h-64 overflow-y-auto px-5 pb-2">
                {(() => {
                  const byTarget = new Map<string, typeof stagedDrafts>();
                  for (const d of stagedDrafts) {
                    const t = d.targetLabel ?? "—";
                    const arr = byTarget.get(t) ?? [];
                    arr.push(d);
                    byTarget.set(t, arr);
                  }
                  return [...byTarget.entries()]
                    .sort((a, b) => b[1].length - a[1].length)
                    .map(([target, drafts]) => (
                      <div key={target} className="pb-1.5">
                        <div className="flex items-center gap-2 pt-1.5 font-mono text-[11px]">
                          <IconArrowRight className="h-3 w-3 shrink-0 text-ink-3" />
                          <span className="truncate text-accent">{target}</span>
                          <span className="text-ink-3 tabular-nums">({drafts.length})</span>
                        </div>
                        <ul className="mt-1 divide-y divide-line">
                          {drafts.map((d) => (
                            <li
                              key={d.raw}
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
                              <span className="shrink-0 text-ink-2 tabular-nums">
                                {d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}
                              </span>
                              <button
                                type="button"
                                onClick={() => discardStaged(d.raw)}
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
                    ));
                })()}
              </div>
            </div>
          )}
          {showSql && staged.length > 0 && (
            <pre className="overflow-x-auto border-t border-line bg-bg px-5 py-4 font-mono text-[11.5px] leading-relaxed text-ink-2">
              {sql}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
