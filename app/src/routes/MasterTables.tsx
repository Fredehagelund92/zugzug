import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Checkbox } from "../components/Checkbox";
import { ComboSelect } from "../components/ComboSelect";
import { TablePicker } from "../components/TablePicker";
import { CreateTableModal } from "../components/CreateTableModal";
import { NoTablesYet } from "../components/NoTablesYet";
import { PageHeader } from "../components/PageHeader";
import { StatsBar } from "../components/StatsBar";
import { IconPlus, IconX, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import { AddFieldPopover } from "../components/AddFieldPopover";
import { slug } from "../store";
import {
  useDimensions, useSources,
  addCanonical, renameCanonical, mergeCanonical, retireCanonical, fetchVariants, deriveCanonical,
  addField, setFieldValue, addColumnOption,
  renameColumn, changeColumnType, deleteColumn,
  getGridLayout, setGridLayout, type GridLayoutConfig,
} from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { DataGrid, useUndoStack } from "../components/datagrid";
import type { ColumnDef } from "../components/datagrid";
import type { CanonicalValue } from "../data";

/* Tables (pillar 2) — the master-record workbench, live against Postgres
   dim_/map_. Import from a source column, MERGE near-duplicates into one survivor
   (raw values re-point), rename, remove, and enrich with attribute COLUMNS
   (currency, locale, …) editable inline. Expand a record for the raw values that
   resolve to it (the lineage receipt). Every mutation is persisted + audited. */


export function MasterTables() {
  const dims = useDimensions();
  const sources = useSources();
  const { engineer } = useEngineerMode();
  const [dimId, setDimId] = useState<string | null>(dims[0]?.id ?? null);
  const dim = dims.find((d) => d.id === dimId) ?? dims[0] ?? null;

  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // Ref mirror of `open` so the columns memo can read the current expanded key
  // without listing `open` in its deps. Recomputing the whole column defs (and
  // the downstream DataGrid layout chain) on every row expand was visible jank.
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  const [draft, setDraft] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [variantsCache, setVariantsCache] = useState<Record<string, string[] | "loading">>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [renameFlash, setRenameFlash] = useState<{ prev: string; next: string; variants: number } | null>(null);
  const renameFlashTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const wired = useMemo(() => sources.filter((s) => s.dimId === dimId), [sources, dimId]);
  const [idOpt, setIdOpt] = useState<string | null>(null);
  const [nameOpt, setNameOpt] = useState<string | null>(null);

  // "+ field" popover state
  const [addOpen, setAddOpen] = useState(false);
  const addFieldRef = useRef<HTMLButtonElement | null>(null);

  if (!dim) return (
    <>
      <NoTablesYet from="tables" onCreateRequested={() => setCreateOpen(true)} />
      <CreateTableModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => { setDimId(id); }}
      />
    </>
  );

  const list = dim.canonical;
  const fields = dim.fields ?? [];
  const totalVariants = list.reduce((n, c) => n + (c.variants ?? 0), 0);
  const sourceOpts = wired.map((s) => `${s.table}.${s.column}`);
  const external = dim.keyKind === "external_id";

  const activeId = dim.id;
  const undo = useUndoStack();

  // hydrate per-user layout (widths/order/hidden) when the dimension changes
  const [layout, setLayout] = useState<GridLayoutConfig>({});
  useEffect(() => { void getGridLayout(activeId).then(setLayout); }, [activeId]);

  // column defs for <DataGrid>. The first three are pinned (checkbox is
  // managed by the grid itself; "Master record" and "Key" are pinned-left
  // and not part of the attribute-fields loop).
  const columns = useMemo<ColumnDef<CanonicalValue>[]>(() => {
    const cols: ColumnDef<CanonicalValue>[] = [
      {
        field: "label",
        label: "Record",
        type: "text",
        pinnedLeft: true,
        editable: !external,
        render: (c) => (
          <button type="button"
            onClick={() => toggleOpen(c.key)}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            <IconChevron className={cx("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", openRef.current === c.key && "rotate-180")} />
            {c.unresolved ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13px] text-ink-2">{c.key}</span>
                <Badge tone="warn">unresolved</Badge>
              </span>
            ) : (
              <span className="truncate font-display text-[14px] font-semibold text-ink">{c.label}</span>
            )}
          </button>
        ),
        edit: (c, { commit }) => (
          <input autoFocus defaultValue={c.label}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value.trim());
              if (e.key === "Escape") commit(c.label); // no-op cancel
            }}
            onBlur={(e) => commit(e.target.value.trim())}
            className="w-full border-b-2 border-b-accent bg-transparent px-1 py-1 font-display text-[14px] font-semibold text-ink outline-none"
          />
        ),
      },
      {
        field: "key",
        label: engineer ? dim.keyCol : "Key",
        type: "text",
        pinnedLeft: true,
        editable: false,
        render: (c) => (
          <span className="truncate font-mono text-[12px] text-accent">{external && c.unresolved ? "" : c.key}</span>
        ),
      },
      ...fields.map<ColumnDef<CanonicalValue>>((f) => ({
        field: f.field,
        label: f.label,
        type: f.type as ColumnDef<CanonicalValue>["type"],
        options: f.options,
        editable: true,
        // value extraction: <DataGrid> reads row[field]; map from c.fields[field]
        render: undefined,   // built-in renderer (uses (row as any)[c.field])
      })),
      {
        field: "variants",
        label: "Raw",
        type: "number",
        editable: false,
        align: "right",
        render: (c) => (c.variants ?? 0) > 0
          ? <Badge>{c.variants}</Badge>
          : <span className="font-mono text-[11px] text-ink-3">0</span>,
      },
    ];
    // apply persisted layout: width, hidden, order
    const ordered = cols
      .map((c) => ({
        ...c,
        width: layout.widths?.[c.field] ?? c.width,
        hidden: layout.hidden?.includes(c.field) ?? false,
      }))
      .sort((a, b) => {
        const ord = layout.order ?? [];
        const ai = ord.indexOf(a.field);
        const bi = ord.indexOf(b.field);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    return ordered;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, engineer, dim.keyCol, external, layout]);

  // <DataGrid> reads (row as any)[c.field]. The MasterTables CanonicalValue
  // shape stores attribute values in c.fields[field]; flatten before passing
  // so cell renderers see row.region etc.
  const rowsForGrid = useMemo(
    () => list.map((c) => ({ ...c, ...(c.fields ?? {}) })),
    [list],
  );

  const reset = () => { setSel([]); setOpen(null); setNotice(null); };
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 3000); };
  const ck = (key: string) => `${activeId}::${key}`;

  const toggleOpen = async (key: string) => {
    if (open === key) { setOpen(null); return; }
    setOpen(key);
    if (!variantsCache[ck(key)]) {
      setVariantsCache((c) => ({ ...c, [ck(key)]: "loading" }));
      const vs = await fetchVariants(activeId, key);
      setVariantsCache((c) => ({ ...c, [ck(key)]: vs }));
    }
  };

  const add = async () => {
    const label = draft.trim(); if (!label || busy) return;
    setBusy(true);
    await addCanonical(activeId, label);
    undo.push({
      label: `add “${label}”`,
      apply: () => addCanonical(activeId, label),
      inverse: () => retireCanonical(activeId, slug(label)).then(() => undefined),
    });
    setBusy(false); setDraft("");
  };

  const merge = async (survivorLabel: string) => {
    const survivor = list.find((c) => c.label === survivorLabel)?.key;
    if (!survivor) return;
    const losers = sel.filter((k) => k !== survivor);
    if (!losers.length) return;
    // snapshot loser records BEFORE the merge
    const snapshot = list.filter((c) => losers.includes(c.key))
      .map((c) => ({ key: c.key, label: c.label, fields: c.fields }));

    setBusy(true);
    const n = await mergeCanonical(activeId, survivor, losers);
    undo.push({
      label: `merge ${losers.length} into “${survivorLabel}”`,
      apply: () => mergeCanonical(activeId, survivor, losers).then(() => undefined),
      inverse: async () => {
        // re-insert losers; variants stay pointing at the survivor (v1 limitation — deferred to v1.1)
        for (const s of snapshot) await addCanonical(activeId, s.label);
      },
    });
    setBusy(false);
    setSel([]); flash(`Merged ${n} record${n === 1 ? "" : "s"} into ${survivorLabel} — raw values re-pointed.`);
  };

  const retire = async (key: string, label: string) => {
    setBusy(true);
    const r = await retireCanonical(activeId, key);
    setBusy(false);
    if (!r.ok) { flash(`Can’t remove “${label}” — ${r.variants} raw value${r.variants === 1 ? "" : "s"} still map here. Merge or remap them first.`); return; }
    undo.push({
      label: `remove “${label}”`,
      apply: () => retireCanonical(activeId, key).then(() => undefined),
      inverse: () => addCanonical(activeId, label),
    });
  };
  const derive = async (opt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === opt);
    if (!s || busy) return;
    setBusy(true); const n = await deriveCanonical(activeId, s.table, s.column); setBusy(false);
    flash(n > 0 ? `Imported ${n} record${n === 1 ? "" : "s"} from ${s.table}.${s.column}.` : `${s.table}.${s.column} has no rows to import.`);
  };
  const deriveExternal = async (idColOpt: string, nameColOpt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === idColOpt);
    const nameCol = nameColOpt.split(".").slice(1).join(".");
    if (!s || !nameCol || busy) return;
    setBusy(true); const n = await deriveCanonical(activeId, s.table, s.column, nameCol); setBusy(false);
    flash(n > 0 ? `Imported ${n} external-ID key${n === 1 ? "" : "s"} from ${s.table}.${s.column} (names ← ${nameCol}).` : `${s.table}.${s.column} has no distinct values to import.`);
  };

  return (
    <div className="space-y-6">
      <div className="relative z-40">
        <PageHeader
          kicker="Master data"
          title="Tables"
          lede="Records other systems resolve to. Manual lists welcome too."
          action={
            sourceOpts.length > 0 && !external ? (
              <div className="w-60"><ComboSelect options={sourceOpts} value={null} placeholder="import from source…" onPick={derive} /></div>
            ) : external && sourceOpts.length > 0 ? (
              <div className="flex items-end gap-2">
                <div className="w-44"><ComboSelect options={sourceOpts} value={idOpt} placeholder="id column…" onPick={setIdOpt} /></div>
                <div className="w-44"><ComboSelect options={sourceOpts} value={nameOpt} placeholder="name column…" onPick={setNameOpt} /></div>
                <Button size="sm" disabled={!idOpt || !nameOpt || busy} onClick={() => idOpt && nameOpt && deriveExternal(idOpt, nameOpt)}>Import</Button>
              </div>
            ) : null
          }
        />
      </div>

      <div className="zz-rise relative z-30" style={{ animationDelay: "60ms" }}>
        <TablePicker
          dims={dims}
          activeId={activeId}
          onSelect={(id) => { setDimId(id); reset(); setDraft(""); }}
          onCreateRequested={() => setCreateOpen(true)}
        />
        <CreateTableModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => { setDimId(id); reset(); setDraft(""); }}
        />
      </div>

      <StatsBar animationDelay="100ms" className="font-mono text-[11px]">
        {engineer && (
          <>
            <span className="text-ink-2">table <span className="text-ink">{dim.dimTable}</span></span>
            <span className="text-ink-2">key <span className="text-ink">{dim.keyCol}</span></span>
          </>
        )}
        <span className="text-ink-2 tabular-nums">{list.length} record{list.length === 1 ? "" : "s"}</span>
        <span className="text-ink-2 tabular-nums">{fields.length} field{fields.length === 1 ? "" : "s"}</span>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-ink-2 tabular-nums">{totalVariants.toLocaleString()} raw value{totalVariants === 1 ? "" : "s"} resolve here</span>
          <Button variant="ghost" size="sm" disabled={!undo.canUndo} onClick={() => void undo.undo()} title={undo.topLabel ?? undefined}>
            ↶ Undo
            {undo.topLabel && <span className="ml-1.5 inline-block max-w-[140px] truncate align-bottom text-[11px] text-ink-3">{undo.topLabel}</span>}
            <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
          </Button>
        </div>
      </StatsBar>

      {notice && <div className="rounded-lg border border-line bg-accent-wash px-4 py-2.5 font-mono text-[12px] text-accent">{notice}</div>}
      {renameFlash && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-accent-wash px-4 py-2.5 font-mono text-[12px] text-accent">
          <span>
            Renamed “{renameFlash.prev}” → “{renameFlash.next}”. {renameFlash.variants.toLocaleString()} raw value{renameFlash.variants === 1 ? "" : "s"} re-pointed.
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!undo.canUndo}
              onClick={() => { void undo.undo(); setRenameFlash(null); }}
            >Undo</Button>
            <Button variant="ghost" size="sm" onClick={() => setRenameFlash(null)}>Dismiss</Button>
          </div>
        </div>
      )}

      <div className="zz-rise space-y-0" style={{ animationDelay: "150ms" }}>
        {/* selection / action bar */}
        <div className="flex flex-wrap items-center gap-3 rounded-t-lg border border-b-0 border-line bg-surface px-5 py-2.5">
          {sel.length === 0 ? (
            <span className="font-mono text-[11.5px] text-ink-3">
              {list.length >= 5 ? "Tip — select two or more records to merge them into one." : ""}
            </span>
          ) : (
            <>
              <Checkbox state="mixed" onClick={() => setSel([])} aria-label="Clear" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="w-56">
                <ComboSelect options={list.filter((c) => sel.includes(c.key)).map((c) => c.label)}
                  value={null} placeholder={sel.length < 2 ? "select 2+ to merge" : "merge into…"} onPick={merge} />
              </div>
              <Button size="sm" variant="secondary" icon={<IconX className="h-3.5 w-3.5" />}
                onClick={async () => {
                  for (const k of sel) {
                    const c = list.find((x) => x.key === k);
                    if (c) await retire(k, c.label);
                  }
                  setSel([]);
                }}
                disabled={busy}
              >Remove</Button>
              <button type="button" onClick={() => setSel([])} className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink">clear</button>
            </>
          )}
        </div>

        <DataGrid<CanonicalValue>
          rows={rowsForGrid as CanonicalValue[]}
          rowKey={(c) => c.key}
          columns={columns}
          selection={{ selected: sel, onChange: setSel }}
          onCommit={async (rowKey, field, value) => {
            if (field === "label") {
              const prev = list.find((c) => c.key === rowKey)?.label;
              if (typeof value !== "string" || !value.trim() || value === prev) return;
              await renameCanonical(activeId, rowKey, value);
              if (prev) {
                undo.push({
                  label: `rename "${prev}" → "${value}"`,
                  apply: () => renameCanonical(activeId, rowKey, value),
                  inverse: () => renameCanonical(activeId, rowKey, prev),
                });
                void fetchVariants(activeId, rowKey).then((vs) => {
                  setRenameFlash({ prev, next: value, variants: vs.length });
                  if (renameFlashTimer.current) window.clearTimeout(renameFlashTimer.current);
                  renameFlashTimer.current = window.setTimeout(() => setRenameFlash(null), 8000);
                });
              }
              return;
            }
            // attribute field
            const v = value == null ? null : String(value);
            const prev = list.find((c) => c.key === rowKey)?.fields?.[field] ?? null;
            await setFieldValue(activeId, rowKey, field, v);
            if (prev !== v) undo.push({
              label: `edit ${field} on "${rowKey}"`,
              apply: () => setFieldValue(activeId, rowKey, field, v),
              inverse: () => setFieldValue(activeId, rowKey, field, prev),
            });
          }}
          onAddColumnOption={(field, label, color) => addColumnOption(activeId, field, label, color ?? null)}
          onRenameColumn={(field, label) => void renameColumn(activeId, field, label)}
          onChangeColumnType={(field, newType, opts) =>
            changeColumnType(activeId, field, newType, opts?.options, opts?.coerceInvalidToNull ?? false)
          }
          onDeleteColumn={(field) => void deleteColumn(activeId, field)}
          onLayoutChange={(partial) => {
            // persist the FULLY MERGED config: the server does a full replace, so
            // sending just the partial wipes the other persisted keys (order/hidden
            // gone when only `widths` changes, etc.)
            setLayout((cur) => {
              const next = { ...cur, ...partial };
              setGridLayout(activeId, next);
              return next;
            });
          }}
          empty={<div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">no records yet — import from a source above, or add one below</div>}
          onAddFieldClick={() => setAddOpen((v) => !v)}
          addFieldRef={addFieldRef as React.MutableRefObject<HTMLElement | null>}
        />

        {addOpen && (
          <AddFieldPopover
            anchorRef={addFieldRef as React.RefObject<HTMLElement | null>}
            onClose={() => setAddOpen(false)}
            onSubmit={async (input) => {
              await addField(activeId, input.label, input.type, input.options);
            }}
          />
        )}

        {/* per-row expandable variants drawer — kept under the grid as a separate slice */}
        {open && (() => {
          const c = list.find((x) => x.key === open);
          const cached = c ? variantsCache[ck(c.key)] : undefined;
          if (!c) return null;
          return (
            <div className="border border-t-0 border-line bg-surface-2/40 px-5 py-3 pl-[44px]">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                raw values mapped to <span className="text-ink">{c.label}</span>
              </div>
              {cached === "loading" ? (
                <div className="mt-2 font-mono text-[11px] text-ink-3">loading…</div>
              ) : cached && cached.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {cached.map((raw) => <Badge key={raw}>{raw}</Badge>)}
                </div>
              ) : (
                <div className="mt-2 font-mono text-[11px] text-ink-3">
                  no source values map here yet —{" "}
                  <Link to={`/app/mapping?dimId=${activeId}`} className="text-accent hover:underline">match them on Value mapping</Link>
                </div>
              )}
            </div>
          );
        })()}

        {!external && (
          <div className="flex items-center gap-2 rounded-b-lg border border-t-0 border-line bg-surface px-5 py-3">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={`new ${dim.dimension.toLowerCase()} record…`}
              className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent" />
            {draft.trim() && <span className="font-mono text-[11px] text-ink-3">{dim.keyCol} = <span className="text-accent">{slug(draft)}</span></span>}
            <Button size="sm" icon={<IconPlus className="h-3.5 w-3.5" />} onClick={add} disabled={!draft.trim() || busy} className="ml-auto">Add record</Button>
          </div>
        )}
      </div>
    </div>
  );
}
