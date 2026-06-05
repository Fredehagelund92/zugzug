import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { Checkbox } from "./Checkbox";
import { ComboSelect } from "./ComboSelect";
import { AddFieldPopover } from "./AddFieldPopover";
import { IconPlus, IconX, IconChevron } from "./Icons";
import { cx } from "../lib/cx";
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
import type { ColumnDef } from "./datagrid";
import type { CanonicalValue, MappingDimension } from "../data";
import { ModeStrip } from "./modes/ModeStrip";
import { MatchModeBody } from "./modes/MatchModeBody";
import type { Mode } from "../lib/available-modes";

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
    <div className="flex flex-1 flex-col min-h-0">
      {activeModes.length > 1 && (
        <div className="border-b border-line bg-surface px-4 py-2.5">
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
        {/* sources mode arrives in Task 4.1 */}
      </div>
    </div>
  );
}

const DENSITY_KEY = "zugzug:grid-density";

function useDensity(): ["default" | "compact", () => void] {
  const [d, setD] = useState<"default" | "compact">(() => {
    if (typeof localStorage === "undefined") return "default";
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "default";
  });
  return [
    d,
    () =>
      setD((cur) => {
        const next = cur === "compact" ? "default" : "compact";
        try {
          localStorage.setItem(DENSITY_KEY, next);
        } catch {
          /* ignore */
        }
        return next;
      }),
  ];
}

/** RecordsBody — the original TablePane body, lifted verbatim so TablePaneInner
 *  can switch between this and other mode bodies (Match, Sources) under one
 *  shared UndoStackProvider. The body owns its own grid layout state, density
 *  toggle, popovers, etc. */
function RecordsBody({ dim, isActive }: { dim: MappingDimension; isActive: boolean }) {
  const sources = useSources();
  const { engineer } = useEngineerMode();
  const [searchParams] = useSearchParams();
  const activeId = dim.id;
  const undo = useUndoStack();
  const [density, toggleDensity] = useDensity();

  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const [draft, setDraft] = useState("");
  const [variantsCache, setVariantsCache] = useState<Record<string, string[] | "loading">>({});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = dim.canonical;
  const fields = dim.fields ?? [];
  const external = dim.keyKind === "external_id";
  const totalVariants = list.reduce((n, c) => n + (c.variants ?? 0), 0);
  const sourceOpts = wired.map((s) => `${s.table}.${s.column}`);

  const columns = useMemo<ColumnDef<CanonicalValue>[]>(() => {
    const cols: ColumnDef<CanonicalValue>[] = [
      {
        field: "label",
        label: "Record",
        type: "text",
        pinnedLeft: true,
        editable: !external,
        render: (c) => (
          <button
            type="button"
            onClick={() => toggleOpen(c.key)}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            <IconChevron
              className={cx(
                "h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform",
                openRef.current === c.key && "rotate-180",
              )}
            />
            {c.unresolved ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13px] text-ink-2">{c.key}</span>
                <Badge tone="warn">unresolved</Badge>
              </span>
            ) : (
              <span className="truncate font-display text-[14px] font-semibold text-ink">
                {c.label}
              </span>
            )}
          </button>
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
        type: "text",
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
        type: f.type as ColumnDef<CanonicalValue>["type"],
        options: f.options,
        editable: true,
        render: undefined,
      })),
      {
        field: "variants",
        label: "Raw",
        type: "number",
        editable: false,
        align: "right",
        render: (c) =>
          (c.variants ?? 0) > 0 ? (
            <Badge>{c.variants}</Badge>
          ) : (
            <span className="font-mono text-[11px] text-ink-3">0</span>
          ),
      },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, engineer, dim.keyCol, external, layout]);

  const rowsForGrid = useMemo(
    () => list.map((c): CanonicalValue & Record<string, unknown> => ({ ...c, ...(c.fields ?? {}) })),
    [list],
  );

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 3000);
  };
  const ck = (key: string) => `${activeId}::${key}`;

  const toggleOpen = async (key: string) => {
    if (open === key) {
      setOpen(null);
      return;
    }
    setOpen(key);
    if (!variantsCache[ck(key)]) {
      setVariantsCache((c) => ({ ...c, [ck(key)]: "loading" }));
      const vs = await fetchVariants(activeId, key);
      setVariantsCache((c) => ({ ...c, [ck(key)]: vs }));
    }
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
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <div className="flex items-center gap-3 font-mono text-[11px] text-ink-2">
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

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!undo.canUndo}
            onClick={() => void undo.undo()}
            title={undo.topLabel ?? undefined}
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
          >
            ↷ Redo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleDensity}
            title={density === "compact" ? "Default row height" : "Compact row height"}
          >
            {density === "compact" ? "▤ Default" : "≡ Compact"}
          </Button>
          {sourceOpts.length > 0 && !external && (
            <div className="w-56">
              <ComboSelect
                options={sourceOpts}
                value={null}
                placeholder="import from source…"
                onPick={derive}
              />
            </div>
          )}
          {external && sourceOpts.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-40">
                <ComboSelect
                  options={sourceOpts}
                  value={idOpt}
                  placeholder="id column…"
                  onPick={setIdOpt}
                />
              </div>
              <div className="w-40">
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

      <div className="zz-rise space-y-0" style={{ animationDelay: "60ms" }}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-2.5">
          {sel.length === 0 ? (
            <span className="font-mono text-[11.5px] text-ink-3">
              {list.length >= 5 ? "Tip — select two or more records to merge them into one." : ""}
            </span>
          ) : (
            <>
              <Checkbox state="mixed" onClick={() => setSel([])} aria-label="Clear" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
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
                className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink"
              >
                clear
              </button>
            </>
          )}
        </div>

        <DataGrid<CanonicalValue>
          rows={rowsForGrid}
          rowKey={(c) => c.key}
          columns={columns}
          density={density}
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
          onChangeColumnType={(field, newType, opts) =>
            changeColumnType(
              activeId,
              field,
              newType,
              opts?.options,
              opts?.coerceInvalidToNull ?? false,
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
              await addField(activeId, input.label, input.type, input.options);
            }}
          />
        )}

        {open &&
          (() => {
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
                    {cached.map((raw) => (
                      <Badge key={raw}>{raw}</Badge>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 font-mono text-[11px] text-ink-3">
                    no source values map here yet —{" "}
                    <Link
                      to={`/app/mapping?dimId=${activeId}`}
                      className="text-accent hover:underline"
                    >
                      match them on Value mapping
                    </Link>
                  </div>
                )}
              </div>
            );
          })()}

        {!external && (
          <div className="flex items-center gap-2 border-t border-line bg-surface px-5 py-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={`new ${dim.dimension.toLowerCase()} record…`}
              className="w-full max-w-xs rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
            {draft.trim() && (
              <span className="font-mono text-[11px] text-ink-3">
                {dim.keyCol} = <span className="text-accent">{slug(draft)}</span>
              </span>
            )}
            <Button
              size="sm"
              icon={<IconPlus className="h-3.5 w-3.5" />}
              onClick={add}
              disabled={!draft.trim() || busy}
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
