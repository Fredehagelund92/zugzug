import { useMemo, useState } from "react";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Checkbox } from "../components/Checkbox";
import { ComboSelect } from "../components/ComboSelect";
import { DimensionPicker } from "../components/DimensionPicker";
import { NoDimensionsYet } from "../components/NoDimensionsYet";
import { IconPlus, IconX, IconChevron } from "../components/Icons";
import { cx } from "../lib/cx";
import { slug } from "../store";
import {
  useDimensions, useSources, addDimension,
  addCanonical, renameCanonical, mergeCanonical, retireCanonical, fetchVariants, deriveCanonical,
  addField, setFieldValue, addColumnOption,
} from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { DataGrid } from "../components/datagrid";
import type { ColumnDef } from "../components/datagrid";
import type { CanonicalValue } from "../data";

/* Master tables (pillar 2) — the master-record workbench, live against Postgres
   dim_/map_. Import from a source column, MERGE near-duplicates into one survivor
   (raw values re-point), rename, remove, and enrich with attribute COLUMNS
   (currency, locale, …) editable inline. Expand a record for the raw values that
   resolve to it (the lineage receipt). Every mutation is persisted + audited. */

const FIELD_TYPES = ["text", "number", "boolean", "date"] as const;

/** "＋ column" affordance → name + type, adds an attribute column. */
function AddColumn({ onAdd }: { onAdd: (label: string, type: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<string>("text");
  if (!editing) return <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1 font-mono text-[11px] text-ink-3 transition-colors hover:text-accent"><IconPlus className="h-3 w-3" /> column</button>;
  const commit = () => { if (label.trim()) onAdd(label.trim(), type); setLabel(""); setType("text"); setEditing(false); };
  return (
    <div className="flex items-center gap-1.5">
      <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => (e.key === "Enter" ? commit() : e.key === "Escape" && setEditing(false))}
        placeholder="column name…" className="w-32 rounded-sm border border-accent bg-bg px-2 py-0.5 font-mono text-[11px] text-ink outline-none" />
      <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink-2 outline-none">
        {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <button type="button" onMouseDown={(e) => { e.preventDefault(); commit(); }} className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:border-accent">add</button>
    </div>
  );
}

export function MasterTables() {
  const dims = useDimensions();
  const sources = useSources();
  const { engineer } = useEngineerMode();
  const [dimId, setDimId] = useState<string | null>(dims[0]?.id ?? null);
  const dim = dims.find((d) => d.id === dimId) ?? dims[0] ?? null;

  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [variantsCache, setVariantsCache] = useState<Record<string, string[] | "loading">>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wired = useMemo(() => sources.filter((s) => s.dimId === dimId), [sources, dimId]);
  const [idOpt, setIdOpt] = useState<string | null>(null);
  const [nameOpt, setNameOpt] = useState<string | null>(null);

  if (!dim) return <NoDimensionsYet from="tables" />;

  const list = dim.canonical;
  const fields = dim.fields ?? [];
  const totalVariants = list.reduce((n, c) => n + (c.variants ?? 0), 0);
  const sourceOpts = wired.map((s) => `${s.table}.${s.column}`);
  const external = dim.keyKind === "external_id";

  const activeId = dim.id;

  // column defs for <DataGrid>. The first three are pinned (checkbox is
  // managed by the grid itself; "Master record" and "Key" are pinned-left
  // and not part of the attribute-fields loop).
  const columns = useMemo<ColumnDef<CanonicalValue>[]>(() => {
    const cols: ColumnDef<CanonicalValue>[] = [
      {
        field: "label",
        label: "Master record",
        type: "text",
        pinnedLeft: true,
        editable: !external,
        render: (c) => (
          <button type="button"
            onClick={() => toggleOpen(c.key)}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            <IconChevron className={cx("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", open === c.key && "rotate-180")} />
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
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-display text-[14px] font-semibold text-ink outline-none"
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
    return cols;
  }, [fields, engineer, dim.keyCol, external, open]);

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

  const add = async () => { const label = draft.trim(); if (!label || busy) return; setBusy(true); await addCanonical(activeId, label); setBusy(false); setDraft(""); };
  const merge = async (survivorLabel: string) => {
    const survivor = list.find((c) => c.label === survivorLabel)?.key;
    if (!survivor) return;
    const losers = sel.filter((k) => k !== survivor);
    if (!losers.length) return;
    setBusy(true); const n = await mergeCanonical(activeId, survivor, losers); setBusy(false);
    setSel([]); flash(`Merged ${n} record${n === 1 ? "" : "s"} into ${survivorLabel} — raw values re-pointed.`);
  };
  const retire = async (key: string, label: string) => {
    setBusy(true); const r = await retireCanonical(activeId, key); setBusy(false);
    if (!r.ok) flash(`Can’t remove “${label}” — ${r.variants} raw value${r.variants === 1 ? "" : "s"} still map here. Merge or remap them first.`);
  };
  const derive = async (opt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === opt);
    if (!s || busy) return;
    setBusy(true); const n = await deriveCanonical(activeId, s.table, s.column); setBusy(false);
    flash(n > 0 ? `Imported ${n} master record${n === 1 ? "" : "s"} from ${s.table}.${s.column}.` : `${s.table}.${s.column} has no rows to import.`);
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
      <div className="zz-rise relative z-40 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">Master</div>
          <h1 className="mt-1.5 font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-none tracking-[-0.035em] text-ink">Master lists</h1>
          <p className="mt-3 max-w-[60ch] text-ink-2">The master records every source value resolves to. Import them from a source, merge duplicates, add attribute columns, and expand any record to see the raw values that resolve to it.</p>
        </div>
        {sourceOpts.length > 0 && !external && (
          <div className="w-60"><ComboSelect options={sourceOpts} value={null} placeholder="Import from source…" onPick={derive} /></div>
        )}
        {external && sourceOpts.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="w-44"><ComboSelect options={sourceOpts} value={idOpt} placeholder="ID column…" onPick={setIdOpt} /></div>
            <div className="w-44"><ComboSelect options={sourceOpts} value={nameOpt} placeholder="Name column…" onPick={setNameOpt} /></div>
            <Button size="sm" disabled={!idOpt || !nameOpt || busy} onClick={() => idOpt && nameOpt && deriveExternal(idOpt, nameOpt)}>Import</Button>
          </div>
        )}
      </div>

      <div className="zz-rise relative z-30" style={{ animationDelay: "60ms" }}>
        <DimensionPicker dims={dims} activeId={activeId}
          onSelect={(id) => { setDimId(id); reset(); setDraft(""); }}
          onCreate={async (name, keyKind) => { const id = await addDimension(name, keyKind); setDimId(id); reset(); setDraft(""); }} />
      </div>

      <div className="zz-rise flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-5 py-4 font-mono text-[11px]" style={{ animationDelay: "100ms" }}>
        {engineer && (
          <>
            <span className="text-ink-3">table <span className="text-ink">{dim.dimTable}</span></span>
            <span className="text-ink-3">key <span className="text-ink">{dim.keyCol}</span></span>
          </>
        )}
        <span className="text-ink-3">{list.length} record{list.length === 1 ? "" : "s"}</span>
        <span className="text-ink-3">{fields.length} attribute column{fields.length === 1 ? "" : "s"}</span>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-ink-3">{totalVariants.toLocaleString()} raw value{totalVariants === 1 ? "" : "s"} resolve here</span>
          <AddColumn onAdd={(label, type) => addField(activeId, label, type)} />
        </div>
      </div>

      {notice && <div className="rounded-lg border border-line bg-accent-wash px-4 py-2.5 font-mono text-[12px] text-accent">{notice}</div>}

      <div className="zz-rise space-y-0" style={{ animationDelay: "150ms" }}>
        {/* selection / action bar */}
        <div className="flex flex-wrap items-center gap-3 rounded-t-lg border border-b-0 border-line bg-surface px-5 py-2.5">
          {sel.length === 0 ? (
            <span className="font-mono text-[11.5px] text-ink-3">
              {list.length >= 2 ? "Tip — select two or more master records to merge them into one." : ""}
            </span>
          ) : (
            <>
              <Checkbox state="mixed" onClick={() => setSel([])} aria-label="Clear" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="w-56">
                <ComboSelect options={list.filter((c) => sel.includes(c.key)).map((c) => c.label)}
                  value={null} placeholder={sel.length < 2 ? "select 2+ to merge" : "Merge into…"} onPick={merge} />
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

        <DataGrid<CanonicalValue & Record<string, unknown>>
          rows={rowsForGrid}
          rowKey={(c) => c.key}
          columns={columns}
          selection={{ selected: sel, onChange: setSel }}
          onCommit={async (rowKey, field, value) => {
            if (field === "label") {
              if (typeof value === "string" && value.trim() && value !== list.find((c) => c.key === rowKey)?.label) {
                await renameCanonical(activeId, rowKey, value);
              }
              return;
            }
            // attribute field
            const v = value == null ? null : String(value);
            await setFieldValue(activeId, rowKey, field, v);
          }}
          onAddColumnOption={(field, label) => addColumnOption(activeId, field, label)}
          empty={<div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">no master records yet — import from a source above, or add one below</div>}
        />

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
                  {cached.map((raw) => <span key={raw} className="rounded-sm border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-2">{raw}</span>)}
                </div>
              ) : <div className="mt-2 font-mono text-[11px] text-ink-3">no source values map here yet — match them on Value mapping</div>}
            </div>
          );
        })()}

        {!external && (
          <div className="flex items-center gap-2 rounded-b-lg border border-t-0 border-line bg-surface px-5 py-3">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={`New ${dim.dimension.toLowerCase()} master record…`}
              className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent" />
            {draft.trim() && <span className="font-mono text-[11px] text-ink-3">{dim.keyCol} = <span className="text-accent">{slug(draft)}</span></span>}
            <Button size="sm" icon={<IconPlus className="h-3.5 w-3.5" />} onClick={add} disabled={!draft.trim() || busy} className="ml-auto">Add record</Button>
          </div>
        )}
      </div>
    </div>
  );
}
