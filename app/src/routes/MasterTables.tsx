import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Checkbox } from "../components/Checkbox";
import { ComboSelect } from "../components/ComboSelect";
import { DimensionPicker } from "../components/DimensionPicker";
import { NoDimensionsYet } from "../components/NoDimensionsYet";
import { IconPlus, IconX, IconChevron, IconEdit } from "../components/Icons";
import { cx } from "../lib/cx";
import { slug } from "../store";
import {
  useDimensions, useSources, addDimension,
  addCanonical, renameCanonical, mergeCanonical, retireCanonical, fetchVariants, deriveCanonical,
  addField, setFieldValue,
} from "../store";
import { useEngineerMode } from "../lib/engineer-mode";

/* Master tables (pillar 2) — the master-record workbench, live against Postgres
   dim_/map_. Import from a source column, MERGE near-duplicates into one survivor
   (raw values re-point), rename, remove, and enrich with attribute COLUMNS
   (currency, locale, …) editable inline. Expand a record for the raw values that
   resolve to it (the lineage receipt). Every mutation is persisted + audited. */

const FIELD_TYPES = ["text", "number", "boolean", "date"] as const;
const cellBase = "w-full rounded-sm border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2 outline-none transition-colors hover:border-line-2 focus:border-accent focus:bg-bg";

/** Inline-editable enrichment cell — typed; commits on blur/change. */
function FieldCell({ value, type, onCommit }: { value: string | null; type: string; onCommit: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => { setV(value ?? ""); }, [value]);
  const commit = (next: string | null) => { if (next !== (value ?? null)) onCommit(next); };

  if (type === "boolean") {
    return (
      <select value={value ?? ""} onChange={(e) => commit(e.target.value || null)} className={cx(cellBase, "cursor-pointer")}>
        <option value="">—</option><option value="true">true</option><option value="false">false</option>
      </select>
    );
  }
  return (
    <input
      type={type === "date" ? "date" : "text"} inputMode={type === "number" ? "decimal" : undefined}
      value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => commit(v.trim() || null)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      placeholder="—" className={cellBase}
    />
  );
}

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
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
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

  // grid widens with each enrichment column: checkbox · label · key · …fields · raw values · actions
  const gridStyle = { gridTemplateColumns: `24px minmax(140px,1.4fr) 0.7fr ${fields.map(() => "minmax(96px,0.8fr)").join(" ")} 72px 84px` };

  const activeId = dim.id;

  const reset = () => { setSel([]); setOpen(null); setEditing(null); setNotice(null); };
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
  const rename = async (key: string, next: string) => { setEditing(null); const label = next.trim(); if (!label) return; setBusy(true); await renameCanonical(activeId, key, label); setBusy(false); };
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

      <div className="zz-rise overflow-x-auto rounded-lg border border-line bg-surface" style={{ animationDelay: "150ms" }}>
        {sel.length === 0 && list.length >= 2 && (
          <div className="border-b border-line px-5 py-2 text-[11.5px] text-ink-3">
            Tip — select two or more master records to merge them into one.
          </div>
        )}
        {/* header / merge bar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5">
          {sel.length === 0 ? (
            <div className="grid w-full items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-ink-3" style={gridStyle}>
              <span /><span>Master record</span><span>{engineer ? dim.keyCol : "Key"}</span>
              {fields.map((f) => <span key={f.field} className="truncate" title={f.label}>{f.label}</span>)}
              <span className="text-right">Raw values</span><span />
            </div>
          ) : (
            <>
              <Checkbox state="mixed" onClick={() => setSel([])} aria-label="Clear" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="w-56"><ComboSelect options={list.filter((c) => sel.includes(c.key)).map((c) => c.label)} value={null} placeholder={sel.length < 2 ? "select 2+ to merge" : "Merge into…"} onPick={merge} /></div>
              <button type="button" onClick={() => setSel([])} className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink">clear</button>
            </>
          )}
        </div>

        {list.map((c) => {
          const variants = c.variants ?? 0;
          const isOpen = open === c.key;
          const locked = variants > 0;
          const checked = sel.includes(c.key);
          const cached = variantsCache[ck(c.key)];
          return (
            <Fragment key={c.key}>
              <div className={cx("grid items-center gap-3 border-b border-line px-5 py-3 transition-colors", checked ? "bg-accent-wash" : "hover:bg-hover", isOpen && "border-b-0")} style={gridStyle}>
                <Checkbox state={checked ? "on" : "off"} onClick={() => setSel((s) => (s.includes(c.key) ? s.filter((x) => x !== c.key) : [...s, c.key]))} aria-label={`Select ${c.label}`} />
                {editing === c.key ? (
                  <input autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => (e.key === "Enter" ? rename(c.key, editDraft) : e.key === "Escape" && setEditing(null))}
                    onBlur={() => rename(c.key, editDraft)}
                    className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-display text-[14px] font-semibold text-ink outline-none" />
                ) : (
                  <button type="button" onClick={() => toggleOpen(c.key)} className="flex min-w-0 items-center gap-2 text-left">
                    <IconChevron className={cx("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", isOpen && "rotate-180")} />
                    {c.unresolved ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px] text-ink-2">{c.key}</span>
                        <Badge tone="warn">unresolved</Badge>
                      </span>
                    ) : (
                      <span className="truncate font-display text-[14px] font-semibold text-ink">{c.label}</span>
                    )}
                  </button>
                )}
                <span className="truncate font-mono text-[12px] text-accent">{external && c.unresolved ? "" : c.key}</span>
                {fields.map((f) => (
                  <FieldCell key={f.field} value={c.fields?.[f.field] ?? null} type={f.type} onCommit={(v) => setFieldValue(activeId, c.key, f.field, v)} />
                ))}
                <span className="text-right">{variants > 0 ? <Badge>{variants}</Badge> : <span className="font-mono text-[11px] text-ink-3">0</span>}</span>
                <div className="flex justify-end gap-1.5">
                  {!external && (
                    <button type="button" aria-label="Rename" title="Rename" onClick={() => { setEditing(c.key); setEditDraft(c.label); }} className="grid h-7 w-7 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-accent hover:text-accent"><IconEdit className="h-3.5 w-3.5" /></button>
                  )}
                  <button type="button" aria-label={locked ? "Has raw values — can't remove" : "Remove"} title={locked ? `${variants} raw values still map here` : "Remove record"}
                    onClick={() => retire(c.key, c.label)} disabled={locked}
                    className={cx("grid h-7 w-7 place-items-center rounded-sm border border-line-2 transition-colors", locked ? "text-ink-3 opacity-40" : "text-ink-3 hover:border-danger hover:text-danger")}>
                    <IconX className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="border-b border-line bg-surface-2/40 px-5 py-3 pl-[44px]">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">raw values mapped here (the receipt)</div>
                  {cached === "loading" ? (
                    <div className="mt-2 font-mono text-[11px] text-ink-3">loading…</div>
                  ) : cached && cached.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {cached.map((raw) => <span key={raw} className="rounded-sm border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-2">{raw}</span>)}
                    </div>
                  ) : <div className="mt-2 font-mono text-[11px] text-ink-3">no source values map here yet — match them on Value mapping</div>}
                </div>
              )}
            </Fragment>
          );
        })}
        {list.length === 0 && (
          <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">no master records yet — import from a source above, or add one below</div>
        )}

        {!external && (
          <div className="flex items-center gap-2 px-5 py-3">
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
