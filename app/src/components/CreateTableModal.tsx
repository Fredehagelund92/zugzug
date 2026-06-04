import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { IconX } from "./Icons";
import { PALETTE, PALETTE_NAMES, defaultTintFor } from "../lib/palette";
import { createTable, useSources, type ColumnDraft, type CreateTableMode, type CreateTableInput } from "../store";
import { ComboSelect } from "./ComboSelect";
import { OptionBuilder } from "./OptionBuilder";
import type { PaletteName } from "../data";

interface Props {
  open: boolean;
  defaultMode?: CreateTableMode;
  onClose: () => void;
  onCreated: (id: string) => void;
}

/* CreateTableModal — Airtable-style one-page scaffold. Identity (monogram tint
   + description) lives at the top; a three-pill mode segment swaps the form
   below it (blank → column scaffold; source → 1 picker; from IDs → 2 pickers).
   Posts to /api/tables in one round-trip and consolidates the audit log entry. */

export function CreateTableModal({ open, defaultMode = "blank", onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<PaletteName>(() => defaultTintFor(String(Date.now())));
  const [mode, setMode] = useState<CreateTableMode>(defaultMode);
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [source, setSource] = useState<{ table: string; column: string } | null>(null);
  const [external, setExternal] = useState<{ table: string; idColumn: string; nameColumn: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sources = useSources();
  const sourceOpts = useMemo(
    () => Array.from(new Set(sources.map((s) => `${s.table}.${s.column}`))).sort(),
    [sources],
  );
  const columnsOfTable = (table: string): string[] =>
    Array.from(new Set(sources.filter((s) => s.table === table).map((s) => s.column))).sort();

  // blank-mode field row helpers
  const addField = (): void => setColumns((cs) => [...cs, { label: "", type: "text" }]);
  const updateField = (i: number, next: Partial<ColumnDraft>): void =>
    setColumns((cs) => cs.map((c, j) => (i === j ? { ...c, ...next } : c)));
  const removeField = (i: number): void => setColumns((cs) => cs.filter((_, j) => j !== i));

  // reset on open
  useEffect(() => {
    if (!open) return;
    setName(""); setDescription(""); setMode(defaultMode);
    setColor(defaultTintFor(String(Date.now())));
    setColumns([]); setSource(null); setExternal(null);
    setError(null);
  }, [open, defaultMode]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit()) void submit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name, mode, source, external]);

  if (!open) return null;
  const monogram = (name.trim().charAt(0) || "?").toUpperCase();
  const tint = PALETTE[color];

  const canSubmit = (): boolean => {
    if (!name.trim()) return false;
    if (mode === "source") return !!(source?.table && source?.column);
    if (mode === "external_id") return !!(external?.table && external?.idColumn && external?.nameColumn);
    return true; // blank: name is enough
  };

  const submit = async (): Promise<void> => {
    if (submitting || !canSubmit()) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateTableInput = {
        name: name.trim(),
        description: description.trim() || null,
        color,
        mode,
        ...(mode === "blank" ? { columns } : {}),
        ...(mode === "source" && source ? { source } : {}),
        ...(mode === "external_id" && external ? { external } : {}),
      };
      const id = await createTable(payload);
      onCreated(id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-[10vh] w-[520px] max-w-full overflow-hidden rounded-lg border border-line-2 bg-surface shadow-pop"
      >
        {/* accent edge */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />

        <div className="space-y-3 px-6 pb-5 pt-6">
          <div className="flex items-start justify-between">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">New table</div>
            <button type="button" onClick={onClose} aria-label="close" className="text-ink-3 hover:text-ink"><IconX className="h-3.5 w-3.5" /></button>
          </div>

          {/* identity */}
          <div className="flex items-center gap-3">
            <div
              className="grid h-8 w-8 shrink-0 place-items-center rounded-sm font-display text-[15px] font-bold text-white"
              style={{ background: tint.bg, boxShadow: `0 0 0 1.5px ${tint.border}` }}
            >
              {monogram}
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled table"
              className="w-full border-0 border-b border-line bg-transparent py-1.5 font-display text-[18px] font-semibold text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
          </div>

          {/* palette swatch row */}
          <div className="ml-11 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">
            <span>tint</span>
            {PALETTE_NAMES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                className={`h-3.5 w-3.5 rounded-sm transition-transform hover:scale-110 ${color === c ? "ring-1 ring-ink" : ""}`}
                style={{ background: PALETTE[c].bg }}
              />
            ))}
          </div>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="describe what's in this table (optional)"
            className="w-full resize-none border-0 bg-transparent py-1 font-body text-[13px] text-ink-2 outline-none placeholder:text-ink-3"
          />
        </div>

        {/* mode segment */}
        <div className="space-y-2 px-6 pb-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">Start from</div>
          <div className="flex gap-0.5 rounded-sm border border-line bg-bg p-0.5">
            {(["blank", "source", "external_id"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-sm px-2.5 py-1.5 font-mono text-[11.5px] transition-colors ${mode === m ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {m === "blank" ? "blank" : m === "source" ? "from a source column" : "from IDs"}
              </button>
            ))}
          </div>
          <div className="font-mono text-[11px] leading-[1.5] text-ink-3">
            {mode === "blank" && "start with empty rows · design fields now or add them later"}
            {mode === "source" && "seed records from distinct values in a warehouse column"}
            {mode === "external_id" && "records keyed by a warehouse id · names resolved live"}
          </div>
        </div>

        {/* swappable region */}
        <div className="px-6 pb-4 pt-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
            {mode === "blank" ? "Fields" : mode === "source" ? "Source column" : "Source columns"}
          </div>

          {/* ─── blank: scaffold ────────────────────────────────────────────────── */}
          {mode === "blank" && (
            <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
              {/* locked primary row */}
              <div className="grid grid-cols-[14px_1fr_110px_18px] items-center gap-2 border-b border-dashed border-line pb-2">
                <span className="text-center font-mono text-[10px] text-ink-3">⋮⋮</span>
                <span className="font-mono text-[12px] text-ink">name</span>
                <span className="justify-self-end rounded-pill border border-accent/35 bg-accent-wash px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-accent">primary</span>
                <span />
              </div>

              {/* user fields */}
              {columns.map((c, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="grid grid-cols-[14px_1fr_110px_18px] items-center gap-2">
                    <span className="text-center font-mono text-[10px] text-ink-3">⋮⋮</span>
                    <input
                      value={c.label}
                      onChange={(e) => updateField(i, { label: e.target.value })}
                      placeholder="field name…"
                      className="border-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
                    />
                    <select
                      value={c.type}
                      onChange={(e) => updateField(i, { type: e.target.value as ColumnDraft["type"], options: e.target.value === "select" ? (c.options ?? []) : undefined })}
                      className="rounded-sm border border-line-2 bg-bg px-1.5 py-1 font-mono text-[10.5px] text-ink-2 outline-none"
                    >
                      <option value="text">text</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                      <option value="date">date</option>
                      <option value="select">select</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      aria-label="remove field"
                      className="text-center font-mono text-[13px] text-ink-3 hover:text-ink"
                    >
                      ×
                    </button>
                  </div>
                  {c.type === "select" && (
                    <div className="ml-[22px]">
                      <OptionBuilder
                        options={c.options ?? []}
                        onChange={(next) => updateField(i, { options: next })}
                      />
                    </div>
                  )}
                </div>
              ))}

              <button
                type="button"
                onClick={addField}
                className="mt-1 w-full border-t border-dashed border-line pt-2 text-left font-mono text-[11px] text-accent hover:opacity-80"
              >
                + add field
              </button>
            </div>
          )}

          {/* ─── source: 1 picker ───────────────────────────────────────────────── */}
          {mode === "source" && (
            <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
              <ComboSelect
                options={sourceOpts}
                value={source ? `${source.table}.${source.column}` : null}
                placeholder="pick a warehouse column…"
                onPick={(opt) => {
                  const dot = opt.lastIndexOf(".");
                  if (dot > 0) setSource({ table: opt.slice(0, dot), column: opt.slice(dot + 1) });
                }}
              />
              <div className="font-mono text-[11px] text-ink-3">distinct values from the chosen column become records · already-mapped values are skipped</div>
            </div>
          )}

          {/* ─── external_id: 2 pickers ─────────────────────────────────────────── */}
          {mode === "external_id" && (
            <div className="space-y-2 rounded-sm border border-line bg-surface-2 p-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">id column</div>
                  <ComboSelect
                    options={sourceOpts}
                    value={external ? `${external.table}.${external.idColumn}` : null}
                    placeholder="pick the id column…"
                    onPick={(opt) => {
                      const dot = opt.lastIndexOf(".");
                      if (dot > 0) {
                        const table = opt.slice(0, dot);
                        const idColumn = opt.slice(dot + 1);
                        setExternal((prev) => ({
                          table,
                          idColumn,
                          nameColumn: prev && prev.table === table ? prev.nameColumn : "",
                        }));
                      }
                    }}
                  />
                </div>
                <div>
                  <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-3">name column</div>
                  <ComboSelect
                    options={external?.table ? columnsOfTable(external.table).filter((c) => c !== external.idColumn) : []}
                    value={external?.nameColumn || null}
                    placeholder={external?.table ? "pick the name column…" : "pick an id column first"}
                    onPick={(opt) => setExternal((prev) => prev ? { ...prev, nameColumn: opt } : prev)}
                  />
                </div>
              </div>
              <div className="font-mono text-[11px] text-ink-3">keys come from the id column · the human name is resolved live from the name column · no slug</div>
            </div>
          )}
        </div>

        {/* error banner */}
        {error && (
          <div className="border-t border-line bg-accent-wash px-6 py-2 font-mono text-[12px] text-accent">{error}</div>
        )}

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line bg-bg/40 px-6 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit() || submitting}>
            {submitting ? "Creating…" : "Create table"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
