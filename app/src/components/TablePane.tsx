import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { Checkbox } from "./Checkbox";
import { ComboSelect } from "./ComboSelect";
import { AddFieldPopover } from "./AddFieldPopover";
import { IconPlus, IconX } from "./Icons";
import {
  slug,
  useSources,
  useDimensions,
  addCanonical,
  renameCanonical,
  getCanonical,
  importRows,
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
  updateFieldRules,
  updateFieldDescription,
  updateFieldDisplayFields,
  getGridLayout,
  getCachedGridLayout,
  setGridLayout,
  useCanEdit,
  useCurrentUser,
  ConflictError,
  refreshDimAndNotify,
  type GridLayoutConfig,
} from "../store";
import { usePresence } from "../lib/use-presence";
import { useLinkedCandidates } from "../lib/use-linked-candidates";
import { useOpenTabs } from "../lib/open-tabs";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { ManageLinkedFieldsPopover } from "./linked/ManageLinkedFieldsPopover";
import { ConflictBanner } from "./ConflictBanner";
import { useEngineerMode } from "../lib/engineer-mode";
import { useRowActivity } from "../lib/use-row-activity";
import { DataGrid, UndoStackProvider, useUndoStack } from "./datagrid";
import type { ColumnDef, ColumnConfig } from "./datagrid";
import type { CanonicalValue, MappingDimension, FieldDef } from "../data";
import { buildLinkedColumns } from "./linked/buildLinkedColumns";
import { ModeStrip } from "./modes/ModeStrip";
import { MatchModeBody } from "./modes/MatchModeBody";
import { WiredSourcesModeBody } from "./modes/WiredSourcesModeBody";
import type { Mode } from "../lib/available-modes";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "./Toast";
import { prepareImport, type ParsedImport } from "../lib/csv";
import { PresenceStrip } from "./datagrid/PresenceStrip";

/** Convert a FieldDef (server shape) into a ColumnConfig discriminated union. */
function fieldDefToColumnConfig(f: FieldDef): ColumnConfig {
  switch (f.type) {
    case "number":
      return { type: "number", numberFormat: f.numberFormat };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "date" };
    case "select":
      return { type: "select", options: f.options ?? [] };
    case "url":
      return { type: "url" };
    case "email":
      return { type: "email" };
    case "rating":
      return { type: "rating", ratingMax: f.ratingMax ?? 5 };
    default:
      return { type: "text" };
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
      <div className="flex flex-1 flex-col min-h-0">
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
  const allDims = useDimensions();
  const { engineer } = useEngineerMode();
  const canEdit = useCanEdit();
  const [searchParams] = useSearchParams();
  const activeId = dim.id;
  const activity = useRowActivity(activeId);
  const currentUser = useCurrentUser();
  const presence = usePresence(currentUser ? activeId : null, {
    userId: currentUser?.id ?? "",
    displayName: currentUser?.name ?? "",
  });
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
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [idOpt, setIdOpt] = useState<string | null>(null);
  const [nameOpt, setNameOpt] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addFieldRef = useRef<HTMLButtonElement | null>(null);

  const [bulkRemoveConfirm, setBulkRemoveConfirm] = useState<{ count: number } | null>(null);
  const [singleDeleteConfirm, setSingleDeleteConfirm] = useState<{
    key: string;
    label: string;
  } | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState<{
    survivorLabel: string;
    loserCount: number;
  } | null>(null);
  const [linkPicker, setLinkPicker] = useState<{
    fkField: string;
    anchorRect: DOMRect;
  } | null>(null);

  const [conflicts, setConflicts] = useState<
    Map<string, { current: ConflictError["current"]; conflictedKeys?: string[] }>
  >(new Map());

  const surfaceConflict = useCallback((rowKey: string, err: unknown) => {
    if (err instanceof ConflictError) {
      setConflicts((prev) => {
        const next = new Map(prev);
        next.set(rowKey, { current: err.current, conflictedKeys: err.conflictedKeys });
        return next;
      });
      return true;
    }
    return false;
  }, []);

  const dismissConflict = useCallback((rowKey: string) => {
    setConflicts((prev) => {
      if (!prev.has(rowKey)) return prev;
      const next = new Map(prev);
      next.delete(rowKey);
      return next;
    });
  }, []);

  const wired = useMemo(() => sources.filter((s) => s.dimId === activeId), [sources, activeId]);
  const [layout, setLayout] = useState<GridLayoutConfig>(() => getCachedGridLayout(activeId) ?? {});
  useEffect(() => {
    const cached = getCachedGridLayout(activeId);
    if (cached) setLayout(cached);
    else void getGridLayout(activeId).then(setLayout);
  }, [activeId]);

  const importFileRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<ParsedImport | null>(null);
  const onImportFile = async (file: File | null, input: HTMLInputElement) => {
    input.value = ""; // allow re-picking the same file
    if (!file) return;
    const text = await file.text();
    try {
      setPendingImport(
        prepareImport(text, { keyCol: dim.keyCol, dimension: dim.dimension, fields }),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't parse that CSV.", "error");
    }
  };

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
  const linkedTargets = useLinkedCandidates(fields, allDims);
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
        editable: !external && canEdit,
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
      ...fields.flatMap<ColumnDef<CanonicalValue>>((f) => {
        if (f.type === "linked") {
          const target = f.referencedDimId ? linkedTargets.get(f.referencedDimId) : undefined;
          const fieldLabels = target?.fieldLabels ?? new Map<string, string>();
          const [fkCol, ...lookupCols] = buildLinkedColumns(f, {
            fieldLabels,
            fieldExists: new Set(fieldLabels.keys()),
            candidates: target?.candidates ?? [],
          });
          return [{ ...fkCol, editable: canEdit }, ...lookupCols];
        }
        return [
          {
            field: f.field,
            label: f.label,
            config: fieldDefToColumnConfig(f),
            editable: canEdit,
            rules: f.rules,
            description: f.description,
          },
        ];
      }),
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
  }, [fields, engineer, dim.keyCol, external, layout, linkedTargets, canEdit]);

  const rowsForGrid = useMemo(
    () =>
      list.map((c): CanonicalValue & Record<string, unknown> => ({ ...c, ...(c.fields ?? {}) })),
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
      inverse: () => {
        const addedKey = slug(label);
        const v = getCanonical(activeId, addedKey)?.version ?? 1;
        return retireCanonical(activeId, addedKey, v).then(() => undefined);
      },
    });
    setBusy(false);
    setDraft("");
  };

  const merge = async (survivorLabel: string) => {
    const survivorRow = list.find((c) => c.label === survivorLabel);
    const survivor = survivorRow?.key;
    if (!survivor) return;
    const losers = sel.filter((k) => k !== survivor);
    if (!losers.length) return;
    const loserRows = list.filter((c) => losers.includes(c.key));
    const snapshot = loserRows.map((c) => ({ key: c.key, label: c.label, fields: c.fields }));
    const expectedVersions = Object.fromEntries(
      [survivorRow, ...loserRows].map((r) => [r.key, r.version]),
    );

    setBusy(true);
    let n: number;
    try {
      n = await mergeCanonical(activeId, survivor, losers, expectedVersions);
    } catch (e) {
      setBusy(false);
      const anchor =
        e instanceof ConflictError && e.conflictedKeys?.length ? e.conflictedKeys[0]! : survivor;
      if (!surfaceConflict(anchor, e)) throw e;
      return;
    }
    undo.push({
      label: `merge ${losers.length} into "${survivorLabel}"`,
      surface: "Records",
      apply: () => {
        const currentExpectedVersions = Object.fromEntries(
          [survivor, ...losers]
            .map((k) => getCanonical(activeId, k))
            .filter((r): r is CanonicalValue => r !== undefined)
            .map((r) => [r.key, r.version]),
        );
        return mergeCanonical(activeId, survivor, losers, currentExpectedVersions).then(
          () => undefined,
        );
      },
      inverse: async () => {
        for (const s of snapshot) await addCanonical(activeId, s.label);
      },
    });
    setBusy(false);
    setSel([]);
    for (const k of [survivor, ...losers]) dismissConflict(k);
    flash(`Merged ${n} record${n === 1 ? "" : "s"} into ${survivorLabel} — raw values re-pointed.`);
  };

  const retire = async (key: string, label: string) => {
    const row = list.find((c) => c.key === key);
    const version = row?.version ?? 1;
    setBusy(true);
    try {
      const r = await retireCanonical(activeId, key, version);
      if (!r.ok) {
        flash(
          `Can't remove "${label}" — ${r.variants} raw value${r.variants === 1 ? "" : "s"} still map here. Merge or remap them first.`,
        );
        return;
      }
      dismissConflict(key);
      undo.push({
        label: `remove "${label}"`,
        surface: "Records",
        apply: () => {
          const v = getCanonical(activeId, key)?.version ?? 1;
          return retireCanonical(activeId, key, v).then(() => undefined);
        },
        inverse: () => addCanonical(activeId, label),
      });
    } catch (err) {
      if (!surfaceConflict(key, err)) {
        flash(`Remove failed — ${err instanceof Error ? err.message : "network error"}`);
      }
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

  const navigate = useNavigate();
  const navLinks = useNavLinks();
  const { openTab } = useOpenTabs();

  /** Right-click "Show linked fields…" on an FK column header. Anchors the
   *  picker to the header's bounding box (resolved at click time so the
   *  popover stays put even after subsequent re-renders shift things). */
  const handleShowLinkedFields = (fkField: string): void => {
    if (!canEdit) return;
    const headerEl = document.querySelector(`[data-header="${CSS.escape(fkField)}"]`);
    const rect = headerEl?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
    setLinkPicker({ fkField, anchorRect: rect });
  };

  /** Right-click "Open target dimension →" on an FK column header. Opens the
   *  target dim in a new tab and navigates to /tables; MasterTables's
   *  searchParams effect picks up the active-tab change and updates the URL. */
  const handleOpenTargetDimension = (fkField: string): void => {
    const f = fields.find((x) => x.field === fkField);
    const target = f?.referencedDimId;
    if (!target) return;
    openTab(target);
    navigate(navLinks.tables);
  };

  /** Right-click "Manage linked fields…" on a lookup column header. The lookup
   *  column's field is `${fkField.field}__${targetField}`, so we resolve the
   *  owning FK and reuse the FK-flow popover (same picker handles add/remove
   *  uniformly per spec §3.2). */
  const handleManageLinkedFields = (lookupField: string): void => {
    const fkField = fields.find(
      (f) => f.type === "linked" && lookupField.startsWith(`${f.field}__`),
    );
    if (!fkField) return;
    handleShowLinkedFields(fkField.field);
  };

  /** Right-click "Change displayed field…" on a lookup column header. Per spec
   *  §3.2 the picker handles add/remove uniformly, so route to the same flow. */
  const handleChangeDisplayedField = (lookupField: string): void => {
    handleManageLinkedFields(lookupField);
  };

  /** Right-click "Remove this lookup" on a lookup column header. Drops the one
   *  target field from the owning FK's `displayFields` and persists. */
  const handleRemoveLookup = async (lookupField: string): Promise<void> => {
    if (!canEdit) return;
    const fkField = fields.find(
      (f) => f.type === "linked" && lookupField.startsWith(`${f.field}__`),
    );
    if (!fkField) return;
    // `__` separator from buildLinkedColumns is 2 chars.
    const targetField = lookupField.slice(fkField.field.length + 2);
    const next = (fkField.displayFields ?? ["label"]).filter((d) => d !== targetField);
    try {
      await updateFieldDisplayFields(activeId, fkField.field, next);
    } catch (err) {
      toast(
        `Couldn't remove lookup — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  /** Right-click "Jump to source column →" on a lookup column header. The
   *  DataGrid passes the FK column's `field` (via `sourceField`), so we just
   *  scroll its header into view and flash it. Header cells aren't focusable
   *  (no tabIndex), so we use the same accent-wash class records use for
   *  Cmd-K "focus a record" — visual cue stands in for keyboard focus. */
  const handleJumpToSourceColumn = (sourceField: string): void => {
    const headerEl = document.querySelector<HTMLElement>(
      `[data-header="${CSS.escape(sourceField)}"]`,
    );
    if (!headerEl) return;
    headerEl.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    headerEl.classList.add("zz-row-flash");
    window.setTimeout(() => headerEl.classList.remove("zz-row-flash"), 1700);
  };

  const performBulkRemove = async () => {
    const targets = sel
      .map((k) => list.find((x) => x.key === k))
      .filter((c): c is NonNullable<typeof c> => c != null);
    if (targets.length === 0) return;
    setSel([]);
    const label =
      targets.length === 1 ? `remove "${targets[0].label}"` : `remove ${targets.length} records`;
    undo.beginTransaction(label);
    try {
      await Promise.all(targets.map((c) => retire(c.key, c.label)));
    } finally {
      undo.endTransaction();
    }
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
          <PresenceStrip peers={presence.peers} />
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
          {canEdit && (
            <>
              <input
                ref={importFileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => void onImportFile(e.target.files?.[0] ?? null, e.target)}
              />
              <Button variant="ghost" size="sm" onClick={() => importFileRef.current?.click()}>
                ↑ Import CSV
              </Button>
            </>
          )}
          <a
            href={`/api/dimensions/${dim.id}/snapshot.parquet`}
            download={`${dim.id}-map.parquet`}
            className="text-xs text-ink-3 hover:text-ink-1 hover:underline"
            title="Download the map table as Parquet"
          >
            ↓ Download snapshot
          </a>
          {sourceOpts.length > 0 && !external && canEdit && (
            <div className="w-full md:w-56">
              <ComboSelect
                options={sourceOpts}
                value={null}
                placeholder="import from source…"
                onPick={derive}
              />
            </div>
          )}
          {external && sourceOpts.length > 0 && canEdit && (
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
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-2.5">
          <span className="font-mono text-[11.5px] text-ink-3">
            {list.length >= 5 ? "Tip — select two or more records to merge them into one." : ""}
          </span>
        </div>

        {conflicts.size > 0 && (
          <div className="flex flex-col gap-1 px-5 pt-2 pb-3">
            {Array.from(conflicts.entries()).map(([rowKey, c]) => (
              <ConflictBanner
                key={rowKey}
                conflict={c.current}
                conflictedKeys={c.conflictedKeys}
                onRefresh={async () => {
                  await refreshDimAndNotify(activeId);
                  dismissConflict(rowKey);
                }}
                onKeepEditing={() => dismissConflict(rowKey)}
              />
            ))}
          </div>
        )}

        <DataGrid<CanonicalValue>
          rows={rowsForGrid}
          rowKey={(c) => c.key}
          columns={columns}
          showRowNumbers
          selection={{ selected: sel, onChange: setSel }}
          onCommit={
            canEdit
              ? async (rowKey, field, value) => {
                  if (field === "label") {
                    const currentRow = list.find((c) => c.key === rowKey);
                    const prev = currentRow?.label;
                    if (typeof value !== "string" || !value.trim() || value === prev) return;
                    try {
                      await renameCanonical(activeId, rowKey, value, currentRow?.version ?? 1);
                      dismissConflict(rowKey);
                    } catch (e) {
                      if (!surfaceConflict(rowKey, e)) throw e;
                      return;
                    }
                    if (prev) {
                      undo.push({
                        label: `rename "${prev}" → "${value}"`,
                        surface: "Records",
                        apply: () => {
                          const v = getCanonical(activeId, rowKey)?.version ?? 1;
                          return renameCanonical(activeId, rowKey, value, v).then(() => undefined);
                        },
                        inverse: () => {
                          const v = getCanonical(activeId, rowKey)?.version ?? 1;
                          return renameCanonical(activeId, rowKey, prev, v).then(() => undefined);
                        },
                      });
                      void fetchVariants(activeId, rowKey).then((vs) => {
                        setRenameFlash({ prev, next: value, variants: vs.length });
                        if (renameFlashTimer.current) window.clearTimeout(renameFlashTimer.current);
                        renameFlashTimer.current = window.setTimeout(
                          () => setRenameFlash(null),
                          8000,
                        );
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
                }
              : undefined
          }
          onAddColumnOption={
            canEdit
              ? (field, label, color) => addColumnOption(activeId, field, label, color ?? null)
              : undefined
          }
          onRenameColumn={
            canEdit
              ? (field, label) => {
                  if (field.includes("__")) return;
                  void renameColumn(activeId, field, label);
                }
              : undefined
          }
          onChangeColumnType={
            canEdit
              ? (field, newConfig, opts) => {
                  if (field.includes("__")) return Promise.resolve({ ok: false });
                  return changeColumnType(
                    activeId,
                    field,
                    newConfig.type,
                    newConfig.type === "select" ? newConfig.options : undefined,
                    opts?.coerceInvalidToNull ?? false,
                    newConfig.type === "number" ? newConfig.numberFormat : undefined,
                    newConfig.type === "rating" ? newConfig.ratingMax : undefined,
                  );
                }
              : undefined
          }
          onDeleteColumn={
            canEdit
              ? (field) => {
                  if (field.includes("__")) return;
                  void deleteColumn(activeId, field);
                }
              : undefined
          }
          onSaveColumnRules={
            canEdit
              ? (field, rules) => {
                  if (field.includes("__")) return;
                  void updateFieldRules(activeId, field, rules);
                }
              : undefined
          }
          onSaveColumnDescription={
            canEdit
              ? (field, description) => {
                  if (field.includes("__")) return;
                  void updateFieldDescription(activeId, field, description);
                }
              : undefined
          }
          onShowLinkedFields={canEdit ? handleShowLinkedFields : undefined}
          onOpenTargetDimension={handleOpenTargetDimension}
          onChangeDisplayedField={canEdit ? handleChangeDisplayedField : undefined}
          onManageLinkedFields={canEdit ? handleManageLinkedFields : undefined}
          onRemoveLookup={canEdit ? handleRemoveLookup : undefined}
          onJumpToSourceColumn={handleJumpToSourceColumn}
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
          onAddFieldClick={canEdit ? () => setAddOpen((v) => !v) : undefined}
          addFieldRef={addFieldRef as React.MutableRefObject<HTMLElement | null>}
          onInsertRow={
            external || !canEdit
              ? undefined
              : () => {
                  addInputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                  addInputRef.current?.focus();
                }
          }
          onDeleteRow={
            external || !canEdit
              ? undefined
              : (key) => {
                  const target = list.find((c) => c.key === key);
                  if (!target) return;
                  setSingleDeleteConfirm({ key, label: target.label });
                }
          }
          activity={activity}
          presence={presence}
        />

        {addOpen && canEdit && (
          <AddFieldPopover
            anchorRef={addFieldRef as React.RefObject<HTMLElement | null>}
            onClose={() => setAddOpen(false)}
            allDims={allDims.map((d) => ({ id: d.id, dimension: d.dimension }))}
            currentDimId={activeId}
            onSubmit={async ({ label, config }) => {
              if (config.type === "linked") {
                await addField(activeId, label, "linked", undefined, {
                  referencedDimId: config.targetDimId,
                  displayFields: config.displayFields,
                });
              } else if (config.type === "number") {
                await addField(activeId, label, "number", undefined, {
                  numberFormat: config.numberFormat,
                });
              } else if (config.type === "select") {
                await addField(activeId, label, "select", config.options);
              } else if (config.type === "rating") {
                await addField(activeId, label, "rating", undefined, {
                  ratingMax: config.ratingMax,
                });
              } else {
                await addField(activeId, label, config.type);
              }
            }}
          />
        )}

        {linkPicker &&
          (() => {
            const fkField = fields.find((f) => f.field === linkPicker.fkField);
            // Derive target dim from allDims (the same source useLinkedCandidates
            // walks). We need the full field list — `field`, `label`, `type` —
            // so the picker can render checkboxes + disable nested links.
            const targetDim = fkField?.referencedDimId
              ? allDims.find((d) => d.id === fkField.referencedDimId)
              : undefined;
            if (!fkField || !targetDim) return null;
            const targetFields = (targetDim.fields ?? []).map((f) => ({
              field: f.field,
              label: f.label,
              type: f.type,
            }));
            // The target's `label` column isn't in `fields` (it's a built-in
            // canonical column), so prepend it — the picker always pins label
            // first and uses it for the FK cell display.
            const fieldsWithLabel = [
              { field: "label", label: "Record", type: "text" },
              ...targetFields.filter((f) => f.field !== "label"),
            ];
            return (
              <ManageLinkedFieldsPopover
                fkLabel={fkField.label}
                targetFields={fieldsWithLabel}
                current={fkField.displayFields ?? ["label"]}
                anchorRect={linkPicker.anchorRect}
                onCancel={() => setLinkPicker(null)}
                onApply={async (next) => {
                  setLinkPicker(null);
                  try {
                    await updateFieldDisplayFields(activeId, fkField.field, next);
                  } catch (err) {
                    toast(
                      err instanceof Error
                        ? `Couldn't update linked fields — ${err.message}`
                        : "Couldn't update linked fields.",
                      "error",
                    );
                  }
                }}
              />
            );
          })()}

        {!external && canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <input
              ref={addInputRef}
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

        {/* Floating bulk-action bar — sticky so it stays visible at the bottom
            of the pane viewport regardless of scroll position. */}
        {sel.length > 0 && canEdit && (
          <div className="zz-pop-in sticky bottom-4 z-30 mx-auto my-3 flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-3 rounded-sm border border-accent/40 bg-[var(--surface-elevated)] px-4 py-2.5 shadow-lg">
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
            <span className="h-5 w-px bg-line-2" aria-hidden />
            <label className="flex items-center gap-2 font-mono text-[11.5px] text-ink-2">
              Merge into
              <span className="w-48">
                <ComboSelect
                  options={list.filter((c) => sel.includes(c.key)).map((c) => c.label)}
                  value={null}
                  placeholder={sel.length < 2 ? "select 2+" : "pick survivor…"}
                  onPick={(survivorLabel) => {
                    if (sel.length >= 5) {
                      setMergeConfirm({ survivorLabel, loserCount: sel.length - 1 });
                    } else {
                      void merge(survivorLabel);
                    }
                  }}
                />
              </span>
            </label>
            <Button
              size="sm"
              variant="secondary"
              icon={<IconX className="h-3.5 w-3.5" />}
              onClick={() => setBulkRemoveConfirm({ count: sel.length })}
              disabled={busy}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingImport !== null}
        title={`Import into ${dim.dimension}?`}
        body={
          pendingImport && (
            <ul className="flex flex-col gap-1 font-mono text-[12px]">
              {pendingImport.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
              <li className="mt-1 text-ink-3">
                New keys are created; existing keys get field updates. Labels are never renamed.
              </li>
            </ul>
          )
        }
        confirmLabel="Import"
        onConfirm={async () => {
          if (!pendingImport) return;
          const toImport = pendingImport.rows;
          setPendingImport(null);
          try {
            const r = await importRows(activeId, toImport);
            toast(`Imported — ${r.created} created · ${r.updated} updated · ${r.skipped} skipped`);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Couldn't import.", "error");
          }
        }}
        onCancel={() => setPendingImport(null)}
      />

      <ConfirmDialog
        open={bulkRemoveConfirm !== null}
        title="Remove these records?"
        body={
          bulkRemoveConfirm && (
            <>
              {bulkRemoveConfirm.count} record{bulkRemoveConfirm.count === 1 ? "" : "s"} will be
              retired. Mapped raw values will lose their target. Use Undo if you change your mind.
            </>
          )
        }
        confirmLabel={`Remove ${bulkRemoveConfirm?.count ?? 0}`}
        danger
        onConfirm={async () => {
          await performBulkRemove();
          setBulkRemoveConfirm(null);
        }}
        onCancel={() => setBulkRemoveConfirm(null)}
      />

      <ConfirmDialog
        open={singleDeleteConfirm !== null}
        title="Delete this record?"
        body={
          singleDeleteConfirm && (
            <>
              <code className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">
                {singleDeleteConfirm.label}
              </code>{" "}
              will be retired. Use Undo if you change your mind.
            </>
          )
        }
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!singleDeleteConfirm) return;
          await retire(singleDeleteConfirm.key, singleDeleteConfirm.label);
          setSingleDeleteConfirm(null);
        }}
        onCancel={() => setSingleDeleteConfirm(null)}
      />

      <ConfirmDialog
        open={mergeConfirm !== null}
        title={`Merge into "${mergeConfirm?.survivorLabel ?? ""}"?`}
        body={
          mergeConfirm && (
            <>
              {mergeConfirm.loserCount} record{mergeConfirm.loserCount === 1 ? "" : "s"} will be
              merged into{" "}
              <code className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">
                {mergeConfirm.survivorLabel}
              </code>
              . Their raw values will be re-pointed. Use Undo if you change your mind.
            </>
          )
        }
        confirmLabel="Merge"
        onConfirm={async () => {
          if (!mergeConfirm) return;
          await merge(mergeConfirm.survivorLabel);
          setMergeConfirm(null);
        }}
        onCancel={() => setMergeConfirm(null)}
      />
    </div>
  );
}
