import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { Checkbox } from "./Checkbox";
import { ComboSelect } from "./ComboSelect";
import { AddFieldPopover } from "./AddFieldPopover";
import { IconPlus, IconX } from "./Icons";
import {
  slug,
  useSources,
  addCanonical,
  renameCanonical,
  mergeCanonical,
  retireCanonical,
  fetchVariants,
  deriveCanonical,
  addField,
  setFieldValue,
  addColumnOption,
  renameColumn,
  changeColumnType,
  deleteColumn,
  getGridLayout,
  setGridLayout,
  type GridLayoutConfig,
} from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import { DataGrid, UndoStackProvider, useUndoStack } from "./datagrid";
import type { ColumnDef, ColumnConfig } from "./datagrid";
import type { CanonicalValue, MappingDimension, FieldDef } from "../data";
import { ModeStrip } from "./modes/ModeStrip";
import { MatchModeBody } from "./modes/MatchModeBody";
import { WiredSourcesModeBody } from "./modes/WiredSourcesModeBody";
import type { Mode } from "../lib/available-modes";

/** Convert a FieldDef (server shape) into a ColumnConfig discriminated union. */
function fieldDefToColumnConfig(f: FieldDef): ColumnConfig {
  switch (f.type) {
    case "number": return { type: "number", numberFormat: f.numberFormat };
    case "boolean": return { type: "boolean" };
    case "date": return { type: "date" };
    case "select": return { type: "select", options: f.options ?? [] };
    case "url": return { type: "url" };
    case "email": return { type: "email" };
    case "rating": return { type: "rating", ratingMax: f.ratingMax ?? 5 };
    default: return { type: "text" };
  }
}

interface TablePaneProps {
  dim: MappingDimension;
  isActive: boolean;
  /** Currently-selected mode for this pane. Optional — defaults to "records"
   *  so callers that haven't wired URL-folded mode yet still compile. Task 3.4
   *  threads the real value through from MasterTables. */
  mode?: Mode;
  /** Modes available for this dim (records always present; match + sources
   *  conditional on wiring). Optional + defaults to ["records"] — when ≤ 1
   *  the ModeStrip self-hides anyway, so no chrome appears. */
  modes?: readonly Mode[];
  /** Called when the user picks a different mode. No-op default lets the
   *  component stand alone in tests/previews. */
  onModeChange?: (m: Mode) => void;
}

export function TablePane({ dim, isActive, mode, modes, onModeChange }: TablePaneProps) {
  return (
    <UndoStackProvider scopeKey={dim.id}>
      <TablePaneInner
        dim={dim}
        isActive={isActive}
        mode={mode}
        modes={modes}
        onModeChange={onModeChange}
      />
    </UndoStackProvider>
  );
}

/** Records mode has only the "new" status for canonical values right now —
 *  treat any value whose status is missing as "mapped" for the badge count. */
function countNewForDim(dim: MappingDimension): number {
  return dim.values.filter((v) => v.status === "new").length;
}

function TablePaneInner({ dim, isActive, mode, modes, onModeChange }: TablePaneProps) {
  const sources = useSources();
  const wired = useMemo(() => sources.filter((s) => s.dimId === dim.id), [sources, dim.id]);
  const activeModes: readonly Mode[] = modes ?? ["records"];
  const activeMode: Mode = mode ?? "records";

  return (
    <div
      className="flex flex-1 flex-col min-h-0"
      onKeyDown={(e) => {
        // Skip when editing in a grid cell (focus is inside an input)
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
        if (e.altKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
          const idx = parseInt(e.key, 10) - 1;
          const target = activeModes[idx];
          if (target) {
            e.preventDefault();
            onModeChange?.(target);
          }
          return;
        }
        if (e.key === "[" || e.key === "]") {
          const dir = e.key === "]" ? 1 : -1;
          const i = activeModes.indexOf(activeMode);
          const next = activeModes[i + dir];
          if (next) {
            e.preventDefault();
            onModeChange?.(next);
          }
        }
      }}
    >
      {activeModes.length > 1 && (
        <div className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-2.5 overflow-x-auto [scrollbar-width:none]">
          <ModeStrip
            modes={activeModes}
            active={activeMode}
            onSelect={onModeChange ?? (() => {})}
            badges={{
              match: { count: countNewForDim(dim) },
              sources: { warn: wired.some((s) => s.unmapped > 0) },
            }}
          />
        </div>
      )}
      <div className="flex flex-1 flex-col min-h-0 overflow-auto">
        {activeMode === "records" && <RecordsBody dim={dim} isActive={isActive} />}
        {activeMode === "match" && <MatchModeBody dim={dim} isActive={isActive} />}
        {activeMode === "sources" && <WiredSourcesModeBody dim={dim} />}
      </div>
    </div>
  );
}


function exportToCSV(dim: MappingDimension): void {
  const fields = dim.fields ?? [];
  const headers = ["key", "label", ...fields.map((f) => f.label)];
  const escape = (v: string) => {
    if (/[,"\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const rows = dim.canonical.map((c) =>
    [c.key, c.label, ...fields.map((f) => String(c.fields?.[f.field] ?? ""))].map(escape).join(","),
  );
  const csv = [headers.map(escape).join(","), ...rows].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(dim.dimension)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** RecordsBody — the original TablePane body, lifted verbatim so TablePaneInner
 *  can switch between this and other mode bodies (Match, Sources) under one
 *  shared UndoStackProvider. The body owns its own grid layout state, popovers, etc. */
function RecordsBody({ dim, isActive }: { dim: MappingDimension; isActive: boolean }) {
  const sources = useSources();
  const { engineer } = useEngineerMode();
  const [searchParams] = useSearchParams();
  const activeId = dim.id;
  const undo = useUndoStack();


  const [sel, setSel] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [renameFlash, setRenameFlash] = useState<{
    prev: string;
    next: string;
    variants: number;
  } | null>(null);
  const renameFlashTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [idOpt, setIdOpt] = useState<string | null>(null);
  const [nameOpt, setNameOpt] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addFieldRef = useRef<HTMLButtonElement | null>(null);

  const wired = useMemo(() => sources.filter((s) => s.dimId === activeId), [sources, activeId]);
  const [layout, setLayout] = useState<GridLayoutConfig>({});
  useEffect(() => {
    void getGridLayout(activeId).then(setLayout);
  }, [activeId]);

  // ?focus=<key> — scroll the focused record into view (only when this pane is
  // the active one at mount; inactive panes are display:none so scrollIntoView
  // would silently no-op anyway, but we gate to avoid stale-tab side effects).
  const initialFocusRef = useRef(isActive ? searchParams.get("focus") : null);
  useEffect(() => {
    const key = initialFocusRef.current;
    if (!key) return;
    initialFocusRef.current = null;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("zz-row-flash");
      window.setTimeout(() => el.classList.remove("zz-row-flash"), 1700);
    });
  }, []);

  const list = dim.canonical;
  const fields = useMemo(() => dim.fields ?? [], [dim.fields]);
  const external = dim.keyKind === "external_id";
  const totalVariants = list.reduce((n, c) => n + (c.variants ?? 0), 0);
  const sourceOpts = wired.map((s) => `${s.table}.${s.column}`);

  const columns = useMemo<ColumnDef<CanonicalValue>[]>(() => {
    const cols: ColumnDef<CanonicalValue>[] = [
      {
        field: "label",
        label: "Record",
        config: { type: "text" },
        pinnedLeft: true,
        editable: !external,
        render: (c) =>
          c.unresolved ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[13px] text-ink-2">{c.key}</span>
              <Badge tone="warn">unresolved</Badge>
            </span>
          ) : (
            <span className="truncate font-display text-[14px] font-semibold text-ink">
              {c.label}
            </span>
          ),
        edit: (c, { commit }) => (
          <input
            autoFocus
            defaultValue={c.label}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value.trim());
              if (e.key === "Escape") commit(c.label);
            }}
            onBlur={(e) => commit(e.target.value.trim())}
            className="w-full border-b-2 border-b-accent bg-transparent px-1 py-1 font-display text-[14px] font-semibold text-ink outline-none"
          />
        ),
      },
      {
        field: "key",
        label: engineer ? dim.keyCol : "Key",
        config: { type: "text" },
        pinnedLeft: true,
        editable: false,
        render: (c) => (
          <span className="truncate font-mono text-[12px] text-accent">
            {external && c.unresolved ? "" : c.key}
          </span>
        ),
      },
      ...fields.map<ColumnDef<CanonicalValue>>((f) => ({
        field: f.field,
        label: f.label,
        config: fieldDefToColumnConfig(f),
        editable: true,
        render: undefined,
      })),
    ];
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
  }, [fields, engineer, dim.keyCol, external, layout]);

  const rowsForGrid = useMemo(
    () => list.map((c): CanonicalValue & Record<string, unknown> => ({ ...c, ...(c.fields ?? {}) })),
    [list],
  );

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 3000);
  };

  const add = async () => {
    const label = draft.trim();
    if (!label || busy) return;
    setBusy(true);
    await addCanonical(activeId, label);
    undo.push({
      label: `add "${label}"`,
      surface: "Records",
      apply: () => addCanonical(activeId, label),
      inverse: () => retireCanonical(activeId, slug(label)).then(() => undefined),
    });
    setBusy(false);
    setDraft("");
  };

  const merge = async (survivorLabel: string) => {
    const survivor = list.find((c) => c.label === survivorLabel)?.key;
    if (!survivor) return;
    const losers = sel.filter((k) => k !== survivor);
    if (!losers.length) return;
    const snapshot = list
      .filter((c) => losers.includes(c.key))
      .map((c) => ({ key: c.key, label: c.label, fields: c.fields }));

    setBusy(true);
    const n = await mergeCanonical(activeId, survivor, losers);
    undo.push({
      label: `merge ${losers.length} into "${survivorLabel}"`,
      surface: "Records",
      apply: () => mergeCanonical(activeId, survivor, losers).then(() => undefined),
      inverse: async () => {
        for (const s of snapshot) await addCanonical(activeId, s.label);
      },
    });
    setBusy(false);
    setSel([]);
    flash(`Merged ${n} record${n === 1 ? "" : "s"} into ${survivorLabel} — raw values re-pointed.`);
  };

  const retire = async (key: string, label: string) => {
    setBusy(true);
    try {
      const r = await retireCanonical(activeId, key);
      if (!r.ok) {
        flash(
          `Can't remove "${label}" — ${r.variants} raw value${r.variants === 1 ? "" : "s"} still map here. Merge or remap them first.`,
        );
        return;
      }
      undo.push({
        label: `remove "${label}"`,
        surface: "Records",
        apply: () => retireCanonical(activeId, key).then(() => undefined),
        inverse: () => addCanonical(activeId, label),
      });
    } catch (err) {
      flash(`Remove failed — ${err instanceof Error ? err.message : "network error"}`);
    } finally {
      setBusy(false);
    }
  };

  const derive = async (opt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === opt);
    if (!s || busy) return;
    setBusy(true);
    const n = await deriveCanonical(activeId, s.table, s.column);
    setBusy(false);
    flash(
      n > 0
        ? `Imported ${n} record${n === 1 ? "" : "s"} from ${s.table}.${s.column}.`
        : `${s.table}.${s.column} has no rows to import.`,
    );
  };

  const deriveExternal = async (idColOpt: string, nameColOpt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === idColOpt);
    const nameCol = nameColOpt.split(".").slice(1).join(".");
    if (!s || !nameCol || busy) return;
    setBusy(true);
    const n = await deriveCanonical(activeId, s.table, s.column, nameCol);
    setBusy(false);
    flash(
      n > 0
        ? `Imported ${n} external-ID key${n === 1 ? "" : "s"} from ${s.table}.${s.column} (names ← ${nameCol}).`
        : `${s.table}.${s.column} has no distinct values to import.`,
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-2">
          {engineer && (
            <>
              <span>
                table <span className="text-ink">{dim.dimTable}</span>
              </span>
              <span>
                key <span className="text-ink">{dim.keyCol}</span>
              </span>
              <span className="text-line-2">·</span>
            </>
          )}
          <span className="tabular-nums">
            {list.length} record{list.length === 1 ? "" : "s"}
          </span>
          <span className="tabular-nums">
            {fields.length} field{fields.length === 1 ? "" : "s"}
          </span>
          <span className="tabular-nums">{totalVariants.toLocaleString()} raw</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2 max-md:w-full max-md:ml-0">
          <Button
            variant="ghost"
            size="sm"
            disabled={!undo.canUndo}
            onClick={() => void undo.undo()}
            title={undo.topLabel ?? undefined}
            className="max-md:hidden"
          >
            ↶ Undo
            {undo.topSurface && (
              <span className="ml-1.5 font-mono text-[10px] text-ink-3">({undo.topSurface})</span>
            )}
            <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!undo.canRedo}
            onClick={() => void undo.redo()}
            className="max-md:hidden"
          >
            ↷ Redo
          </Button>

          {list.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => exportToCSV(dim)}>
              ↓ Export CSV
            </Button>
          )}
          {sourceOpts.length > 0 && !external && (
            <div className="w-full md:w-56">
              <ComboSelect
                options={sourceOpts}
                value={null}
                placeholder="import from source…"
                onPick={derive}
              />
            </div>
          )}
          {external && sourceOpts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 max-md:w-full">
              <div className="w-full md:w-40">
                <ComboSelect
                  options={sourceOpts}
                  value={idOpt}
                  placeholder="id column…"
                  onPick={setIdOpt}
                />
              </div>
              <div className="w-full md:w-40">
                <ComboSelect
                  options={sourceOpts}
                  value={nameOpt}
                  placeholder="name column…"
                  onPick={setNameOpt}
                />
              </div>
              <Button
                size="sm"
                disabled={!idOpt || !nameOpt || busy}
                onClick={() => idOpt && nameOpt && deriveExternal(idOpt, nameOpt)}
                className="max-md:w-full"
              >
                Import
              </Button>
            </div>
          )}
        </div>
      </div>

      {notice && (
        <div className="border-b border-line bg-accent-wash px-4 py-2 font-mono text-[12px] text-accent">
          {notice}
        </div>
      )}
      {renameFlash && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-accent-wash px-4 py-2 font-mono text-[12px] text-accent">
          <span>
            Renamed “{renameFlash.prev}” → “{renameFlash.next}”.{" "}
            {renameFlash.variants.toLocaleString()} raw value{renameFlash.variants === 1 ? "" : "s"}{" "}
            re-pointed.
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!undo.canUndo}
              onClick={() => {
                void undo.undo();
                setRenameFlash(null);
              }}
            >
              Undo
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRenameFlash(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="zz-rise flex flex-1 flex-col min-h-0" style={{ animationDelay: "60ms" }}>
        {sel.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-accent/30 bg-accent-wash px-5 py-2.5">
            <Checkbox state="mixed" onClick={() => setSel([])} aria-label="Clear selection" />
            <span className="font-mono text-[12px] font-medium text-accent">
              {sel.length} record{sel.length === 1 ? "" : "s"} selected
            </span>
            {sel.length < list.length && (
              <button
                type="button"
                onClick={() => setSel(list.map((c) => c.key))}
                className="font-mono text-[11px] text-accent underline underline-offset-2 hover:opacity-80"
              >
                Select all {list.length}
              </button>
            )}
            <div className="w-56">
              <ComboSelect
                options={list.filter((c) => sel.includes(c.key)).map((c) => c.label)}
                value={null}
                placeholder={sel.length < 2 ? "select 2+ to merge" : "merge into…"}
                onPick={merge}
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              icon={<IconX className="h-3.5 w-3.5" />}
              onClick={async () => {
                const targets = sel
                  .map((k) => list.find((x) => x.key === k))
                  .filter((c): c is NonNullable<typeof c> => c != null);
                if (targets.length === 0) return;
                setSel([]);
                const label =
                  targets.length === 1
                    ? `remove "${targets[0].label}"`
                    : `remove ${targets.length} records`;
                undo.beginTransaction(label);
                try {
                  await Promise.all(targets.map((c) => retire(c.key, c.label)));
                } finally {
                  undo.endTransaction();
                }
              }}
              disabled={busy}
            >
              Remove
            </Button>
            <button
              type="button"
              onClick={() => setSel([])}
              className="ml-auto font-mono text-[11px] text-accent/60 hover:text-accent"
            >
              clear
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-2.5">
            <span className="font-mono text-[11.5px] text-ink-3">
              {list.length >= 5 ? "Tip — select two or more records to merge them into one." : ""}
            </span>
          </div>
        )}

        <DataGrid<CanonicalValue>
          rows={rowsForGrid}
          rowKey={(c) => c.key}
          columns={columns}

          showRowNumbers
          selection={{ selected: sel, onChange: setSel }}
          onCommit={async (rowKey, field, value) => {
            if (field === "label") {
              const prev = list.find((c) => c.key === rowKey)?.label;
              if (typeof value !== "string" || !value.trim() || value === prev) return;
              await renameCanonical(activeId, rowKey, value);
              if (prev) {
                undo.push({
                  label: `rename "${prev}" → "${value}"`,
                  surface: "Records",
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
            const v = value == null ? null : String(value);
            const prev = list.find((c) => c.key === rowKey)?.fields?.[field] ?? null;
            await setFieldValue(activeId, rowKey, field, v);
            if (prev !== v)
              undo.push({
                label: `edit ${field} on "${rowKey}"`,
                surface: "Records",
                apply: () => setFieldValue(activeId, rowKey, field, v),
                inverse: () => setFieldValue(activeId, rowKey, field, prev),
              });
          }}
          onAddColumnOption={(field, label, color) =>
            addColumnOption(activeId, field, label, color ?? null)
          }
          onRenameColumn={(field, label) => void renameColumn(activeId, field, label)}
          onChangeColumnType={(field, newConfig, opts) =>
            changeColumnType(
              activeId,
              field,
              newConfig.type,
              newConfig.type === "select" ? newConfig.options : undefined,
              opts?.coerceInvalidToNull ?? false,
              newConfig.type === "number" ? newConfig.numberFormat : undefined,
              newConfig.type === "rating" ? newConfig.ratingMax : undefined,
            )
          }
          onDeleteColumn={(field) => void deleteColumn(activeId, field)}
          onLayoutChange={(partial) => {
            setLayout((cur) => {
              const next = { ...cur, ...partial };
              setGridLayout(activeId, next);
              return next;
            });
          }}
          empty={
            <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">
              no records yet — import from a source above, or add one below
            </div>
          }
          onAddFieldClick={() => setAddOpen((v) => !v)}
          addFieldRef={addFieldRef as React.MutableRefObject<HTMLElement | null>}
        />

        {addOpen && (
          <AddFieldPopover
            anchorRef={addFieldRef as React.RefObject<HTMLElement | null>}
            onClose={() => setAddOpen(false)}
            onSubmit={async (input) => {
              const { label, config } = input;
              const options = config.type === "select" ? config.options : undefined;
              const numberFormat = config.type === "number" ? config.numberFormat : undefined;
              const ratingMax = config.type === "rating" ? config.ratingMax : undefined;
              await addField(activeId, label, config.type, options, { numberFormat, ratingMax });
            }}
          />
        )}

        {!external && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={`new ${dim.dimension.toLowerCase()} record…`}
              className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
            {draft.trim() && engineer && (
              <span className="font-mono text-[11px] text-ink-3">
                {dim.keyCol} = <span className="text-accent">{slug(draft)}</span>
              </span>
            )}
            <Button
              size="sm"
              icon={<IconPlus className="h-3.5 w-3.5" />}
              onClick={add}
              disabled={!draft.trim() || busy}
              loading={busy}
              className="ml-auto"
            >
              Add record
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
