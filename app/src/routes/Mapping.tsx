import { Fragment, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Checkbox } from "../components/Checkbox";
import { ComboSelect } from "../components/ComboSelect";
import { DimensionPicker } from "../components/DimensionPicker";
import { NoDimensionsYet } from "../components/NoDimensionsYet";
import { IconCheck, IconX, IconWand, IconArrowRight, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import { valueRows } from "../data";
import type { MappingValue } from "../data";
import { useDimensions, addDimension, useDrafts, saveDraft, discardDraft, listDrafts, commit, dkey, currentUser } from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { useGridCursor, useUndoStack } from "../components/datagrid";
import type { ColumnDef } from "../components/datagrid";

/* Value mapping — match messy source values to one master record. Each accept /
   merge / skip lands as a per-user DRAFT (the store's Postgres seam), never a
   per-keystroke MotherDuck round-trip; the footer reviews the staged drafts and
   commits them in one batch MERGE to DuckDB (dim_* + map_*). The row status you
   see = the committed truth overlaid with your pending draft. */

type RStatus = "mapped" | "new" | "skipped";
type ValueState = Record<string, { target: string | null; status: RStatus }>;
type Filter = "new" | "all" | "mapped";

const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger/30");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");
const COLS = "grid grid-cols-[28px_minmax(160px,1.3fr)_22px_minmax(160px,1.1fr)_88px_84px_64px] items-center gap-3";

export function Mapping() {
  const dims = useDimensions();
  if (dims.length === 0) return <NoDimensionsYet from="mapping" />;
  return <MappingInner />;
}

function MappingInner() {
  const dims = useDimensions();
  const allDrafts = useDrafts();
  const { engineer } = useEngineerMode();
  const [seedId, setSeedId] = useState(dims[0].id);
  const seed = dims.find((s) => s.id === seedId) ?? dims[0];
  const [sel, setSel] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("new");
  const [open, setOpen] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [review, setReview] = useState(false);
  const [flash, setFlash] = useState<{ n: number; rows: number } | null>(null);
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

  const selectSeed = (id: string) => { setSeedId(id); setSel([]); setOpen(null); setShowSql(false); setReview(false); setFlash(null); };

  const counts = useMemo(() => {
    const c = { all: seed.values.length, new: 0, mapped: 0, skipped: 0 };
    for (const v of seed.values) c[state[v.value]?.status ?? "new"]++;
    return c;
  }, [seed, state]);

  const stageMap = (v: string, label: string) => saveDraft(seed.id, v, "mapped", label, keyFor(label));
  const accept = (v: string) => { const r = byVal(v); if (r.suggestion) stageMap(v, r.suggestion); };
  const pick = (v: string, t: string) => stageMap(v, t);
  const skip = (v: string) => saveDraft(seed.id, v, "skipped", null, null);
  const reset = (v: string) => discardDraft(seed.id, v);
  const automap = () => {
    let n = 0;
    for (const r of seed.values) if (r.suggestion && r.confidence >= 90 && state[r.value].status === "new") { stageMap(r.value, r.suggestion); n++; }
    setAutoFlash(n);
    setTimeout(() => setAutoFlash(null), 2600);
  };
  const bulkApply = (fn: (v: string) => void) => { sel.forEach(fn); setSel([]); };

  const visible = seed.values.filter((v) => filter === "all" || state[v.value]?.status === filter);
  const visIds = visible.map((v) => v.value);
  const allSel = visIds.length > 0 && visIds.every((id) => sel.includes(id));
  const headState: "on" | "off" | "mixed" = allSel ? "on" : sel.length ? "mixed" : "off";

  const visibleRows = visible;            // alias for clarity
  const COLS_FOR_CURSOR: ColumnDef<MappingValue>[] = [
    { field: "value", label: "Source", type: "text", editable: false },
    { field: "target", label: "Master", type: "text", editable: true },
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
    const res = await commit(seed.id);      // server folds drafts + returns rows recovered
    if (!res.committed) return;
    setFlash({ n: res.committed, rows: res.rowsRecovered }); setShowSql(false); setReview(false);
    setTimeout(() => setFlash(null), 2800);
  };

  const FILTERS: { k: Filter; label: string; n: number }[] = [
    { k: "new", label: "Needs review", n: counts.new },
    { k: "all", label: "All", n: counts.all },
    { k: "mapped", label: "Mapped", n: counts.mapped },
  ];

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="zz-rise flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">Match values</div>
          <h1 className="mt-1.5 font-display text-[clamp(26px,3.6vw,40px)] font-extrabold leading-none tracking-[-0.035em] text-ink">
            Match {seed.dimension.toLowerCase()} values
          </h1>
        </div>
        <Button icon={<IconWand className="h-4 w-4" />} onClick={automap} className="zz-glow-sm">
          {autoFlash !== null ? `✓ Auto-matched ${autoFlash}` : "Auto-match new values"}
        </Button>
      </div>

      {/* dimension picker — choose master data, or create a new one */}
      <div className="zz-rise relative z-30" style={{ animationDelay: "60ms" }}>
        <DimensionPicker dims={dims} activeId={seedId} onSelect={selectSeed} onCreate={async (name, keyKind) => selectSeed(await addDimension(name, keyKind))} />
      </div>

      {/* coverage + (engineer-only) target tables */}
      <div className="zz-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-surface px-5 py-4" style={{ animationDelay: "100ms" }}>
        {engineer && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px]">
            <span className="text-ink-3">master <span className="text-ink">{seed.dimTable}</span></span>
            <span className="text-ink-3">lookup <span className="text-ink">{seed.mapTable}</span></span>
            <span className="text-ink-3">{seed.rows.toLocaleString()} rows · key <span className="text-ink">{seed.keyCol}</span></span>
          </div>
        )}
        <div className={cx("flex items-center gap-3", engineer && "ml-auto")}>
          <div className="h-1.5 w-36 overflow-hidden rounded-pill bg-surface-2"><div className="h-full rounded-pill bg-accent transition-[width] duration-300" style={{ width: `${coverage}%` }} /></div>
          <span className="font-mono text-[11px] text-ink-2 tabular-nums">{coverage}% mapped</span>
          {counts.new > 0 && <Badge tone="warn" dot>{counts.new} need review</Badge>}
        </div>
      </div>

      {/* workbench */}
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
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void approveAndCommit(); return; }
        }}
        style={{ animationDelay: "150ms" }}
      >
        {/* toolbar / bulk bar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
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
                <Button size="sm" icon={<IconCheck className="h-3.5 w-3.5" />} onClick={() => bulkApply((v) => { const r = byVal(v); if (r.suggestion) stageMap(v, r.suggestion); })}>Accept</Button>
                <div className="w-48"><ComboSelect options={options} value={null} allowCreate={!external} placeholder="Merge all to…" onPick={(t) => bulkApply((v) => stageMap(v, t))} /></div>
                <Button variant="secondary" size="sm" icon={<IconX className="h-3.5 w-3.5" />} onClick={() => bulkApply((v) => saveDraft(seed.id, v, "skipped", null, null))}>Skip</Button>
              </div>
              <button type="button" onClick={() => setSel([])} className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink">clear</button>
            </>
          )}
        </div>

        {/* column header */}
        <div className={cx(COLS, "border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3")}>
          <span /><span>Source value · where it's seen</span><span /><span>Master {seed.dimension.toLowerCase()}</span><span>Confidence</span><span>Status</span><span />
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
                  ) : <span className="font-mono text-[11px] text-ink-3">—</span>}
                </div>
                <div>{row.status === "mapped" ? <Badge tone="ok" dot>Mapped</Badge> : row.status === "skipped" ? <Badge>Skipped</Badge> : <Badge tone="warn" dot>New</Badge>}</div>
                <div className="flex items-center justify-end gap-1.5">
                  {r.suggestion && row.status !== "mapped" && (
                    <button type="button" aria-label="Accept" title="Accept suggestion" onClick={() => accept(r.value)} className="grid h-7 w-7 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-accent hover:text-accent"><IconCheck className="h-3.5 w-3.5" /></button>
                  )}
                  {row.status === "new" ? (
                    <button type="button" aria-label="Skip" title="Skip" onClick={() => skip(r.value)} className="grid h-7 w-7 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-danger hover:text-danger"><IconX className="h-3.5 w-3.5" /></button>
                  ) : (
                    <button type="button" aria-label="Reset" title="Reset" onClick={() => reset(r.value)} className="grid h-7 w-7 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-accent hover:text-accent"><IconArrowRight className="h-3.5 w-3.5 -rotate-90" /></button>
                  )}
                </div>
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
            </Fragment>
          );
        })}
        {visible.length === 0 && (
          <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
            {filter === "new" ? "🎉 no new values — this one is fully matched" : "no values in this view"}
          </div>
        )}

        {/* review & commit footer — drafts stage in Postgres, commit batch-MERGEs to DuckDB */}
        <div className="border-t border-line">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="font-mono text-[11px] text-ink-3">
              {flash
                ? <span className="text-ok">
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
              <Button variant="ghost" size="sm" disabled={staged.length === 0} onClick={() => setReview((s) => !s)}>{review ? "Hide review" : `Review ${staged.length}`}</Button>
              {engineer && (
                <Button variant="secondary" size="sm" disabled={staged.length === 0} onClick={() => setShowSql((s) => !s)}>{showSql ? "Hide SQL" : "Preview SQL"}</Button>
              )}
              <Button size="sm" disabled={staged.length === 0} onClick={approveAndCommit}>
                {engineer ? `Approve & commit ${staged.length}` : `Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
          {review && staged.length > 0 && (
            <div className="border-t border-line">
              <div className="px-5 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">Staged for review · {stagedDrafts.length}</div>
              <ul className="mt-1 divide-y divide-line">
                {stagedDrafts.map((d) => (
                  <li key={d.raw} className="flex items-center gap-3 px-5 py-2.5 font-mono text-[11.5px]">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-pill bg-surface-3 text-[9px] text-ink-2" title={d.user.name}>{d.user.initials}</span>
                    <span className="min-w-0 max-w-[40%] truncate text-ink">{d.raw}</span>
                    <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 truncate text-accent">{d.targetLabel}</span>
                    <span className="ml-auto shrink-0 text-ink-3">{d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}</span>
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
    </div>
  );
}
