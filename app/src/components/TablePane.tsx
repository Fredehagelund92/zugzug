import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { Checkbox } from "./Checkbox";
import { ComboSelect } from "./ComboSelect";
import { AddFieldPopover } from "./AddFieldPopover";
import { RenameConfirmation } from "./RenameConfirmation";
import { IconPlus, IconX, IconFilter } from "./Icons";
import {
  slug,
  useSources,
  useDimensions,
  useDrafts,
  discardDraft,
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
  updateFieldValidation,
  updateFieldDescription,
  updateFieldDisplayFields,
  getGridLayout,
  getCachedGridLayout,
  setGridLayout,
  insertCanonicalAt,
  reorderCanonical,
  patchDimension,
  rebalancePositions,
  useCanEdit,
  useCurrentUser,
  ConflictError,
  ApiCodeError,
  refreshDimAndNotify,
  commit,
  fetchPublishState,
  revertChanges,
  type PublishState,
  type GridLayoutConfig,
} from "../store";
import { apiFetch } from "../api";
import { cx } from "../lib/cx";
import { usePresence } from "../lib/use-presence";
import { useLinkedCandidates } from "../lib/use-linked-candidates";
import { useOpenTabs } from "../lib/open-tabs";
import { useNavLinks } from "../lib/use-tenant-navigate";
import { ManageLinkedFieldsPopover } from "./linked/ManageLinkedFieldsPopover";
import { ConflictBanner, type FieldDiff } from "./ConflictBanner";
import { useRowActivity } from "../lib/use-row-activity";
import { DataGrid, UndoStackProvider, useUndoStack } from "./datagrid";
import type { ColumnDef, ColumnConfig } from "./datagrid";
import { pruneValidationForType } from "./datagrid/validation";
import type { CanonicalValue, MappingDimension, FieldDef } from "../data";
import { buildLinkedColumns } from "./linked/buildLinkedColumns";
import { ModeStrip } from "./modes/ModeStrip";
import { MapValuesBody } from "./modes/MapValuesBody";
import { SourcesMonitorBody } from "./modes/SourcesMonitorBody";
import type { Mode } from "../lib/available-modes";
import { ConfirmDialog } from "./ConfirmDialog";
import { PublishPreviewDialog, type PublishGroup } from "./PublishPreviewDialog";
import { RecordHistoryDrawer } from "./RecordHistoryDrawer";
import { VersionHistory } from "./VersionHistory";
import { toast } from "./Toast";
import { parseCsv, prepareImport, type ParsedImport } from "../lib/csv";
import { ImportPreviewDialog } from "./ImportPreviewDialog";
import { useAddQueue } from "../hooks/use-add-queue";
import { PresenceStrip } from "./datagrid/PresenceStrip";
import { ToolbarMenu, MenuItem, MenuSection, MenuSep } from "./ToolbarMenu";
import { OwnerPicker } from "./OwnerPicker";
import { PALETTE, defaultTintFor } from "../lib/palette";

/** Convert a FieldDef (server shape) into a ColumnConfig discriminated union. */
function fieldDefToColumnConfig(f: FieldDef): ColumnConfig {
  const config: ColumnConfig = (() => {
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
  })();
  config.required = f.required;
  if (f.validation) config.validation = f.validation;
  return config;
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
  return dim.counts.newCount;
}

function TablePaneInner({ dim, isActive, mode, modes, onModeChange }: TablePaneProps) {
  const sources = useSources();
  const wired = useMemo(() => sources.filter((s) => s.dimId === dim.id), [sources, dim.id]);
  const activeModes: readonly Mode[] = modes ?? ["records"];
  const activeMode: Mode = mode ?? "records";

  return (
    <div
      className="relative flex flex-1 flex-col min-h-0"
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
        {activeMode === "records" && (
          <RecordsBody dim={dim} isActive={isActive} onModeChange={onModeChange} />
        )}
        {activeMode === "match" && <MapValuesBody dim={dim} isActive={isActive} />}
        {activeMode === "sources" && <SourcesMonitorBody dim={dim} />}
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
function RecordsBody({
  dim,
  isActive,
  onModeChange,
}: {
  dim: MappingDimension;
  isActive: boolean;
  onModeChange?: (m: Mode) => void;
}) {
  const sources = useSources();
  const allDims = useDimensions();
  const drafts = useDrafts();
  const canEdit = useCanEdit();
  const [searchParams] = useSearchParams();
  const activeId = dim.id;
  // Presence pushes a `row_touched` hint when a peer writes a row; bump this
  // nonce to trigger useRowActivity's debounced refetch (replaces the 5s poll).
  const [activityNonce, setActivityNonce] = useState(0);
  const activity = useRowActivity(activeId, { refetchNonce: activityNonce });
  const currentUser = useCurrentUser();
  const presence = usePresence(currentUser ? activeId : null, {
    userId: currentUser?.id ?? "",
    displayName: currentUser?.name ?? "",
    onRowTouched: () => setActivityNonce((n) => n + 1),
  });
  const undo = useUndoStack();

  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [sel, setSel] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<{ msg: string; tone: "info" | "danger" } | null>(null);
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

  const [bulkRemoveConfirm, setBulkRemoveConfirm] = useState<{
    count: number;
    variantSum: number | null;
  } | null>(null);
  const [singleDeleteConfirm, setSingleDeleteConfirm] = useState<{
    key: string;
    label: string;
  } | null>(null);
  // FK column delete needs its own confirm — the existing singleDeleteConfirm is
  // for retiring records. A linked column carries its lookups with it; surface
  // that count so deletes aren't silent cascades.
  const [deleteColumnConfirm, setDeleteColumnConfirm] = useState<{
    field: string;
    label: string;
    lookupCount: number;
  } | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState<{
    survivorLabel: string;
    loserCount: number;
    loserVariantSum: number | null;
  } | null>(null);
  const [orderingOpen, setOrderingOpen] = useState(false);
  const [rescanOpen, setRescanOpen] = useState(false);
  const [orderingConfirm, setOrderingConfirm] = useState<"derived" | "manual" | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recordHistory, setRecordHistory] = useState<{
    rowKey: string;
    label: string;
    field: string | null;
  } | null>(null);
  const [members, setMembers] = useState<{ user_id: string; name: string | null }[] | null>(null);
  const [pubState, setPubState] = useState<PublishState | null>(null);
  const [changedOnly, setChangedOnly] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [rebalanceConfirm, setRebalanceConfirm] = useState(false);
  const [publishPreview, setPublishPreview] = useState(false);
  const [publishGroups, setPublishGroups] = useState<PublishGroup[]>([]);
  const [linkPicker, setLinkPicker] = useState<{
    fkField: string;
    anchorRect: DOMRect;
  } | null>(null);

  const [conflicts, setConflicts] = useState<
    Map<
      string,
      { current: ConflictError["current"]; conflictedKeys?: string[]; diff?: FieldDiff[] }
    >
  >(new Map());

  const surfaceConflict = useCallback((rowKey: string, err: unknown, diff?: FieldDiff[]) => {
    if (err instanceof ConflictError) {
      setConflicts((prev) => {
        const next = new Map(prev);
        next.set(rowKey, { current: err.current, conflictedKeys: err.conflictedKeys, diff });
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
  const [dismissedSortBanner, setDismissedSortBanner] = useState<Set<string>>(new Set());

  const importFileRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<
    (ParsedImport & { headers: string[]; rawRows: string[][] }) | null
  >(null);
  const [importing, setImporting] = useState(false);
  const onImportFile = async (file: File | null, input: HTMLInputElement) => {
    input.value = ""; // allow re-picking the same file
    if (!file) return;
    const text = await file.text();
    try {
      const grid = parseCsv(text);
      const headers = grid[0] ?? [];
      const rawRows = grid.slice(1);
      const parsed = prepareImport(text, { keyCol: dim.keyCol, dimension: dim.dimension, fields });
      setPendingImport({ ...parsed, headers, rawRows });
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
        // `initial` is set when type-to-edit seeded us with a character — it
        // replaces the label (Excel/Sheets); otherwise edit the existing label.
        edit: (c, { initial, commit, cancel }) => (
          <input
            autoFocus
            defaultValue={initial ?? c.label}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value.trim());
              if (e.key === "Escape") cancel();
            }}
            onBlur={(e) => commit(e.target.value.trim())}
            className="w-full bg-transparent px-1 font-display text-[14px] font-semibold text-ink outline-none"
          />
        ),
      },
      {
        field: "key",
        label: "Key",
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
  }, [fields, external, layout, linkedTargets, canEdit]);

  const changedKeySet = useMemo(() => new Set(pubState?.changedKeys ?? []), [pubState]);
  const visibleFields = useMemo(
    () => columns.filter((c) => !c.hidden).map((c) => c.field),
    [columns],
  );

  const rowsForGrid = useMemo(() => {
    const src = changedOnly ? list.filter((c) => changedKeySet.has(c.key)) : list;
    const all = src.map((c): CanonicalValue & Record<string, unknown> => ({
      ...c,
      ...(c.fields ?? {}),
    }));
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((row) =>
      visibleFields.some((f) => {
        const v = (row as Record<string, unknown>)[f];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }, [list, changedOnly, changedKeySet, search, visibleFields]);

  const flash = (m: string, tone: "info" | "danger" = "info") => {
    setNotice({ msg: m, tone });
    setTimeout(() => setNotice(null), 3000);
  };

  useEffect(() => {
    let alive = true;
    fetchPublishState(activeId)
      .then((s) => {
        if (alive) setPubState(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // `dim` identity changes on every store refresh — exactly when the
    // pending-work counts may have moved.
  }, [activeId, dim]);

  useEffect(() => setChangedOnly(false), [activeId]);

  const unpublished = pubState ? pubState.pendingDrafts + pubState.changedKeys.length : 0;

  const doRevert = async () => {
    if (reverting) return;
    setReverting(true);
    try {
      const r = await revertChanges(activeId);
      const s = await fetchPublishState(activeId);
      setPubState(s);
      setChangedOnly(false);
      setRevertConfirm(false);
      flash(`Reverted ${r.reverted} record${r.reverted === 1 ? "" : "s"} to Version ${s.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      flash(`Revert failed — ${msg}`, "danger");
    } finally {
      setReverting(false);
    }
  };

  const doPublish = async (draftKeys?: string[]) => {
    if (publishing || unpublished === 0) return;
    setPublishing(true);
    try {
      await commit(activeId, draftKeys);
      const s = await fetchPublishState(activeId);
      setPubState(s);
      flash(`Published v${s.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      flash(
        err instanceof ApiCodeError && err.code === "SECOND_PUBLISHER_REQUIRED"
          ? "These drafts need a second publisher — another editor has to press Publish (workspace setting: Four eyes on publish)."
          : `Publish failed — ${msg}`,
        "danger",
      );
    } finally {
      setPublishing(false);
    }
  };

  const addQueue = useAddQueue(
    async (label) => {
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
    },
    (label, err) => {
      toast(
        `Couldn't add "${label}" — ${err instanceof Error ? err.message : "please try again"}`,
        "error",
      );
    },
  );

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    setDraft("");
    addQueue.enqueue(label);
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
    flash(
      `Merged ${n} record${n === 1 ? "" : "s"} into ${survivorLabel} — source values re-pointed · applies on next publish`,
    );
  };

  const retire = async (key: string, label: string) => {
    const row = list.find((c) => c.key === key);
    const version = row?.version ?? 1;
    setBusy(true);
    try {
      const r = await retireCanonical(activeId, key, version);
      if (!r.ok) {
        flash(
          `Can't remove "${label}" — ${r.variants} source value${r.variants === 1 ? "" : "s"} still map here. Merge or remap them first.`,
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

  const outcomeText = (result: {
    mode: "seed" | "connect";
    derived?: number;
    matched?: number;
    unmatched?: number;
  }): string => {
    if (result.mode === "seed") {
      if ((result.derived ?? 0) > 0) {
        return `${result.derived} record${result.derived === 1 ? "" : "s"} created`;
      }
      return "no values yet";
    }
    const m = result.matched ?? 0;
    const u = result.unmatched ?? 0;
    if (m > 0 && u > 0) {
      return `${m} matched, ${u} to review`;
    }
    if (m > 0) {
      return `${m} matched, all done`;
    }
    if (u > 0) {
      return `${u} to review`;
    }
    return "no new values";
  };

  const derive = async (opt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === opt);
    if (!s || busy) return;
    setBusy(true);
    const result = await deriveCanonical(activeId, s.table, s.column);
    setBusy(false);
    flash(`Re-scanned ${s.table}.${s.column} · ${outcomeText(result)} · drafts untouched`);
  };

  const deriveExternal = async (idColOpt: string, nameColOpt: string) => {
    const s = wired.find((w) => `${w.table}.${w.column}` === idColOpt);
    const nameCol = nameColOpt.split(".").slice(1).join(".");
    if (!s || !nameCol || busy) return;
    setBusy(true);
    const result = await deriveCanonical(activeId, s.table, s.column, nameCol);
    setBusy(false);
    flash(
      `Re-scanned ${s.table}.${s.column} (names ← ${nameCol}) · ${outcomeText(result)} · drafts untouched`,
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

  const openOwnerPanel = async () => {
    setOwnerOpen((v) => !v);
    if (members === null) {
      try {
        const r = await apiFetch("/team/members");
        if (r.ok) {
          setMembers((await r.json()) as { user_id: string; name: string | null }[]);
        } else {
          setMembers([]);
        }
      } catch {
        setMembers([]);
      }
    }
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

  const palette = PALETTE[dim.color ?? defaultTintFor(dim.id)];
  const initials = (name: string) =>
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const publishedTitle = pubState
    ? `Version ${pubState.version}${
        pubState.publishedAt != null
          ? ` · published ${new Date(pubState.publishedAt).toLocaleString()}${
              pubState.publishedByName ? ` by ${pubState.publishedByName}` : ""
            }`
          : ""
      }`
    : undefined;
  // Plain-language breakdown of what a publish would include — only the parts
  // that actually exist (no "0 …"), no system jargon.
  const publishParts: string[] = [];
  if (pubState && pubState.pendingDrafts > 0)
    publishParts.push(
      `${pubState.pendingDrafts} new mapping${pubState.pendingDrafts === 1 ? "" : "s"}`,
    );
  if (pubState && pubState.changedKeys.length > 0)
    publishParts.push(
      `${pubState.changedKeys.length} edited record${pubState.changedKeys.length === 1 ? "" : "s"}`,
    );
  const publishSummary = publishParts.join(" and ");
  // A single readout gauge: bold count + muted unit, hairline-divided.
  const gauge = (value: React.ReactNode, unit: string) => (
    <div className="flex items-baseline gap-1.5 border-r border-line px-3 first:pl-0 last:border-r-0">
      <span className="text-[13px] font-semibold tabular-nums text-ink">{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-ink-3">{unit}</span>
    </div>
  );

  // Set a cell to a value — the single write path shared by the grid's inline
  // edit and the history drawer's "restore". field === "label" renames the
  // record; anything else writes a field. Optimistic, with conflict handling,
  // undo, and a toast on failure.
  const commitCell = async (rowKey: string, field: string, value: unknown): Promise<void> => {
    if (field === "label") {
      const currentRow = list.find((c) => c.key === rowKey);
      const prev = currentRow?.label;
      if (typeof value !== "string" || !value.trim() || value === prev) return;
      try {
        await renameCanonical(activeId, rowKey, value, currentRow?.version ?? 1);
        dismissConflict(rowKey);
      } catch (e) {
        const serverRow = getCanonical(activeId, rowKey);
        const labelDiff: FieldDiff[] = [];
        if (serverRow && serverRow.label !== value) {
          labelDiff.push({ field: "label", theirs: serverRow.label, yours: value });
        }
        if (!surfaceConflict(rowKey, e, labelDiff.length > 0 ? labelDiff : undefined)) {
          // Not a version conflict (e.g. network / server error). The
          // store already reverted the optimistic label; tell the user
          // instead of failing silently.
          toast("Couldn't rename that record — try again.", "error");
        }
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
          renameFlashTimer.current = window.setTimeout(() => setRenameFlash(null), 8000);
        });
      }
      return;
    }
    const v = value == null ? null : String(value);
    const prev = list.find((c) => c.key === rowKey)?.fields?.[field] ?? null;
    try {
      await setFieldValue(activeId, rowKey, field, v);
    } catch (e) {
      // Store reverted the optimistic value; surface the failure.
      // A cycle rejection carries a specific, user-ready message.
      const msg =
        e instanceof ApiCodeError && e.code === "HIERARCHY_CYCLE"
          ? e.message
          : "Couldn't save that change — try again.";
      toast(msg, "error");
      return;
    }
    if (prev !== v)
      undo.push({
        label: `edit ${field} on "${rowKey}"`,
        surface: "Records",
        apply: () => setFieldValue(activeId, rowKey, field, v),
        inverse: () => setFieldValue(activeId, rowKey, field, prev),
      });
  };

  return (
    <div
      className="@container flex flex-1 flex-col min-h-0"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
        if (e.key === "/") {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      <div
        className="flex items-center gap-3 border-b border-line bg-surface py-2 pl-3 pr-3 @max-3xl:flex-wrap @max-3xl:gap-2"
        style={{ borderLeft: `3px solid ${palette.bg}` }}
      >
        <div className="flex shrink-0 items-center gap-2.5">
          <span
            className="h-2 w-2 shrink-0 rounded-pill"
            style={{ background: palette.bg, boxShadow: `0 0 0 3px ${palette.wash}` }}
          />
          <span className="max-w-[22ch] truncate font-display text-[14px] font-semibold tracking-tight text-ink">
            {dim.dimension}
          </span>
          <div className="hidden shrink-0 items-center border-l border-line pl-2.5 font-mono text-ink-2 @5xl:flex">
            {gauge(list.length, list.length === 1 ? "record" : "records")}
            {gauge(fields.length, fields.length === 1 ? "field" : "fields")}
            {gauge(totalVariants.toLocaleString(), "source values")}
          </div>
          {dim.ownerName && (
            <span className="hidden shrink-0 items-center gap-1.5 rounded-pill border border-line bg-surface-2 py-0.5 pl-0.5 pr-2.5 text-[12px] text-ink-2 @6xl:inline-flex">
              <span
                className="grid h-[18px] w-[18px] place-items-center rounded-pill text-[9px] font-bold text-white"
                style={{ background: palette.bg }}
              >
                {initials(dim.ownerName)}
              </span>
              {dim.ownerName}
            </span>
          )}
        </div>

        <div className="flex min-w-[120px] max-w-md flex-1 items-center gap-2 rounded-sm border border-line-2 bg-bg px-2.5 py-1.5 transition-colors focus-within:border-accent @max-3xl:order-last @max-3xl:max-w-none @max-3xl:basis-full">
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-ink-3"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search records…"
            className="w-full min-w-0 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {presence.peers.length > 0 && <PresenceStrip peers={presence.peers} />}
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2"
              onClick={() => setOrderingOpen((v) => !v)}
              title="Sort & order rows"
            >
              <span className="text-[13px] leading-none">⇅</span>
            </Button>
          )}
          {pubState && pubState.changedKeys.length > 0 && (
            <button
              type="button"
              aria-pressed={changedOnly}
              onClick={() => setChangedOnly((v) => !v)}
              title={
                changedOnly
                  ? "Showing only changed records — click to show all"
                  : "Show only records changed since the last version"
              }
              className={cx(
                "inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1.5 text-xs font-semibold transition-colors",
                changedOnly
                  ? "border-accent bg-accent-wash text-accent"
                  : "border-line-2 text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              <IconFilter className="h-3.5 w-3.5 shrink-0" />
              <span className="tabular-nums">{pubState.changedKeys.length}</span>
              <span className="@max-5xl:hidden">changed</span>
              {changedOnly && <IconX className="h-3 w-3 shrink-0 opacity-70" />}
            </button>
          )}
          {canEdit && pubState && pubState.canRevert && pubState.changedKeys.length > 0 && (
            <button
              type="button"
              onClick={() => setRevertConfirm(true)}
              title={`Restore Version ${pubState.version} — undo the ${pubState.changedKeys.length} record change${pubState.changedKeys.length === 1 ? "" : "s"}`}
              className="inline-flex shrink-0 items-center rounded-sm border border-line-2 px-2 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
            >
              Revert
            </button>
          )}

          <span className="mx-0.5 h-6 w-px shrink-0 bg-line @max-3xl:hidden" />

          <div className="inline-flex overflow-hidden rounded-sm border border-line @max-3xl:hidden">
            <button
              type="button"
              disabled={!undo.canUndo}
              onClick={() => void undo.undo()}
              title={undo.topLabel ? `Undo — ${undo.topLabel} (⌘Z)` : "Undo (⌘Z)"}
              className="px-2.5 py-1.5 text-[13px] leading-none text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              ↶
            </button>
            <button
              type="button"
              disabled={!undo.canRedo}
              onClick={() => void undo.redo()}
              title="Redo"
              className="border-l border-line px-2.5 py-1.5 text-[13px] leading-none text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              ↷
            </button>
          </div>

          {canEdit && (
            <input
              ref={importFileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => void onImportFile(e.target.files?.[0] ?? null, e.target)}
            />
          )}
          <ToolbarMenu
            title="More actions"
            className="px-2"
            leading={<span className="text-[15px] leading-none text-ink-2">⋯</span>}
          >
            {(canEdit || list.length > 0) && (
              <>
                <MenuSection>Import / export</MenuSection>
                {canEdit && (
                  <MenuItem
                    glyph="↑"
                    title="Import CSV"
                    desc="Map columns onto records & source values"
                    onClick={() => importFileRef.current?.click()}
                  />
                )}
                {list.length > 0 && (
                  <MenuItem
                    glyph="↓"
                    title="Export records (CSV)"
                    desc="Key, label and fields as a spreadsheet"
                    onClick={() => exportToCSV(dim)}
                  />
                )}
                <MenuSep />
              </>
            )}
            <MenuSection>Table</MenuSection>
            {canEdit && (
              <MenuItem
                glyph="⍟"
                title="Assign owner"
                desc={dim.ownerName ? `Currently: ${dim.ownerName}` : "Unassigned"}
                onClick={() => void openOwnerPanel()}
              />
            )}
            <MenuItem
              glyph="⌛"
              title="Version history"
              desc="Roll back to a previous publish"
              onClick={() => setHistoryOpen(true)}
              testId="version-history-button"
            />
            {canEdit && sourceOpts.length > 0 && (
              <MenuItem
                glyph="⟳"
                title="Re-scan source"
                desc="Pull new distinct values from wired columns"
                onClick={() => setRescanOpen((v) => !v)}
              />
            )}
          </ToolbarMenu>

          {canEdit && pubState && unpublished > 0 ? (
            <Button
              size="sm"
              disabled={publishing}
              onClick={() => {
                setPublishGroups(
                  pubState
                    ? [
                        {
                          dimId: activeId,
                          dimName: dim.dimension,
                          nextVersion: pubState.version + 1,
                          drafts: Object.values(drafts).filter(
                            (d) => d.dimId === activeId && d.status === "mapped",
                          ),
                          changedKeys: pubState.changedKeys,
                        },
                      ]
                    : [],
                );
                setPublishPreview(true);
              }}
              title={
                publishSummary ? `Publish ${publishSummary} since the last version` : undefined
              }
              data-testid="publish-button"
            >
              Publish {unpublished} change{unpublished === 1 ? "" : "s"}
            </Button>
          ) : pubState && pubState.version > 0 ? (
            <span
              className="inline-flex items-center gap-1.5 whitespace-nowrap px-1.5 text-[11px] text-ink-3"
              title={publishedTitle}
            >
              {unpublished > 0 ? (
                `${unpublished} unpublished`
              ) : (
                <>
                  <span style={{ color: "var(--ak-ok)" }}>✓</span> Up to date
                </>
              )}
            </span>
          ) : null}
        </div>
      </div>

      {orderingOpen && (
        <div className="border-b border-line bg-surface-2 px-4 py-3 text-[13px]">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Ordering
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={`ordering-${activeId}`}
                value="derived"
                checked={dim.orderingMode !== "manual"}
                onChange={() => {
                  if (dim.orderingMode === "manual") setOrderingConfirm("derived");
                }}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium">Derived</div>
                <div className="text-[12px] text-ink-3">
                  Sort by variant count, then alphabetically. Best for reference data.
                </div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={`ordering-${activeId}`}
                value="manual"
                checked={dim.orderingMode === "manual"}
                onChange={() => {
                  if (dim.orderingMode !== "manual") setOrderingConfirm("manual");
                }}
                className="mt-0.5"
              />
              <div>
                <div className="font-medium">Manual</div>
                <div className="text-[12px] text-ink-3">
                  Persisted drag-orderable order. Best for workflow stages.
                  {dim.orderingMode === "manual" && (
                    <>
                      {" "}
                      Currently {list.length} row{list.length === 1 ? "" : "s"} positioned.
                    </>
                  )}
                </div>
              </div>
            </label>
            {dim.orderingMode === "manual" && canEdit && (
              <button
                className="mt-1 self-start text-[12px] text-ink-3 underline hover:text-ink"
                onClick={() => setRebalanceConfirm(true)}
              >
                Rebalance positions
              </button>
            )}
          </div>
        </div>
      )}

      {ownerOpen && (
        <div className="border-b border-line bg-surface-2 px-4 py-3 text-[13px]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Owner
            </span>
            <button
              className="text-ink-3 hover:text-ink"
              onClick={() => setOwnerOpen(false)}
              title="Close"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
          {members === null ? (
            <div className="text-[12px] text-ink-3">Loading members…</div>
          ) : (
            <OwnerPicker
              members={members}
              currentId={dim.ownerUserId ?? null}
              onPick={async (id) => {
                if (dim.ownerUserId !== id) await patchDimension(activeId, { ownerUserId: id });
                setOwnerOpen(false);
              }}
            />
          )}
        </div>
      )}

      {rescanOpen && canEdit && sourceOpts.length > 0 && (
        <div className="border-b border-line bg-surface-2 px-4 py-3 text-[13px]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Re-scan source
            </span>
            <button
              className="text-ink-3 hover:text-ink"
              onClick={() => setRescanOpen(false)}
              title="Close"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
          {!external ? (
            <div className="max-w-xs">
              <ComboSelect
                options={sourceOpts}
                value={null}
                placeholder="pick a source column…"
                onPick={derive}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-full md:w-44">
                <ComboSelect
                  options={sourceOpts}
                  value={idOpt}
                  placeholder="id column…"
                  onPick={setIdOpt}
                />
              </div>
              <div className="w-full md:w-44">
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
                Re-scan
              </Button>
            </div>
          )}
        </div>
      )}

      {historyOpen && (
        <VersionHistory
          dimId={activeId}
          onClose={() => setHistoryOpen(false)}
          onRollbackSuccess={() => setHistoryOpen(false)}
          flash={flash}
        />
      )}

      {notice && (
        <div
          className={
            notice.tone === "danger"
              ? "border-b border-danger/40 bg-danger-soft px-4 py-2 font-mono text-[12px] text-danger"
              : "border-b border-line bg-accent-wash px-4 py-2 font-mono text-[12px] text-accent"
          }
        >
          {notice.msg}
        </div>
      )}
      {renameFlash && (
        <RenameConfirmation
          prev={renameFlash.prev}
          next={renameFlash.next}
          variants={renameFlash.variants}
          canUndo={undo.canUndo}
          onUndo={() => {
            void undo.undo();
            setRenameFlash(null);
          }}
          onDismiss={() => setRenameFlash(null)}
        />
      )}

      <div className="zz-fade-in flex flex-1 flex-col min-h-0" style={{ animationDelay: "60ms" }}>
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
                diff={c.diff}
                onRefresh={async () => {
                  await refreshDimAndNotify(activeId);
                  dismissConflict(rowKey);
                }}
                onKeepEditing={() => dismissConflict(rowKey)}
              />
            ))}
          </div>
        )}

        {dim.orderingMode === "manual" && !!layout.sort && !dismissedSortBanner.has(activeId) && (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule bg-surface-2 px-3 text-[12px] text-ink-2">
            <span className="flex-1 truncate">
              ⇅ Sorted by {layout.sort.column} {layout.sort.direction === "asc" ? "↑" : "↓"} —
              manual order is hidden
            </span>
            <button
              className="shrink-0 text-accent hover:underline"
              onClick={() => {
                setLayout((cur) => {
                  const next = { ...cur, sort: null };
                  setGridLayout(activeId, next);
                  return next;
                });
              }}
            >
              Restore
            </button>
            <button
              className="shrink-0 text-ink-3 hover:text-ink"
              onClick={() => setDismissedSortBanner((s) => new Set([...s, activeId]))}
            >
              Dismiss
            </button>
          </div>
        )}

        <DataGrid<CanonicalValue>
          rows={rowsForGrid}
          rowKey={(c) => c.key}
          columns={columns}
          showRowNumbers
          selection={{ selected: sel, onChange: setSel }}
          onCommit={canEdit ? commitCell : undefined}
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
              ? async (field, newConfig, opts) => {
                  if (field.includes("__")) return { ok: false };
                  const result = await changeColumnType(
                    activeId,
                    field,
                    newConfig.type,
                    newConfig.type === "select" ? newConfig.options : undefined,
                    opts?.coerceInvalidToNull ?? false,
                    newConfig.type === "number" ? newConfig.numberFormat : undefined,
                    newConfig.type === "rating" ? newConfig.ratingMax : undefined,
                  );
                  // Prune now-inapplicable validation when type changes
                  if (result.ok) {
                    const existingField = fields.find((f) => f.field === field);
                    if (
                      existingField?.validation &&
                      Object.keys(existingField.validation).length > 0
                    ) {
                      const pruned = pruneValidationForType(
                        existingField.validation,
                        newConfig.type,
                      );
                      const hasValues = Object.values(pruned).some((v) => v !== undefined);
                      if (hasValues) {
                        void updateFieldValidation(activeId, field, { validation: pruned });
                      }
                    }
                  }
                  return result;
                }
              : undefined
          }
          onDeleteColumn={
            canEdit
              ? (field) => {
                  if (field.includes("__")) return;
                  const target = fields.find((f) => f.field === field);
                  if (target?.type === "linked") {
                    // Lookup columns mirror displayFields minus "label". The FK
                    // column carries them; deleting it nukes them all.
                    const lookupCount = (target.displayFields ?? []).filter(
                      (d) => d !== "label",
                    ).length;
                    setDeleteColumnConfirm({
                      field,
                      label: target.label,
                      lookupCount,
                    });
                    return;
                  }
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
          onSaveColumnValidation={
            canEdit
              ? (field, next) => {
                  if (field.includes("__")) return;
                  void updateFieldValidation(activeId, field, next);
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
              {list.length > 0 ? (
                <>
                  No records match
                  {search.trim() ? ` “${search.trim()}”` : " the current filter"}.
                  {search.trim() && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="ml-2 text-accent hover:underline"
                    >
                      Clear search
                    </button>
                  )}
                </>
              ) : (
                "no records yet — import from a source above, or add one below"
              )}
            </div>
          }
          onAddFieldClick={canEdit ? () => setAddOpen((v) => !v) : undefined}
          addFieldRef={addFieldRef as React.MutableRefObject<HTMLElement | null>}
          onInsertRow={
            external || !canEdit
              ? undefined
              : (key, where) => {
                  if (dim.orderingMode === "manual") {
                    void insertCanonicalAt(activeId, "(new)", key, where);
                  } else {
                    addInputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                    addInputRef.current?.focus();
                  }
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
          onReorderRow={
            dim.orderingMode === "manual" && canEdit
              ? (rowKey, before, after) => {
                  void reorderCanonical(activeId, rowKey, { before, after });
                }
              : undefined
          }
          onCellKeyDown={
            dim.orderingMode === "manual" && canEdit
              ? (e, ctx) => {
                  const isMac = navigator.platform.toUpperCase().includes("MAC");
                  const mod = isMac ? e.metaKey : e.ctrlKey;
                  if (!mod || !e.shiftKey) return;
                  const focused = ctx.cursor?.rowKey;
                  if (!focused) return;
                  const idx = list.findIndex((r) => r.key === focused);
                  if (idx === -1) return;
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    const before = idx > 1 ? (list[idx - 2]?.key ?? null) : null;
                    const after = idx > 0 ? (list[idx - 1]?.key ?? null) : null;
                    void reorderCanonical(activeId, focused, { before, after });
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    const before = idx < list.length - 1 ? (list[idx + 1]?.key ?? null) : null;
                    const after = idx < list.length - 2 ? (list[idx + 2]?.key ?? null) : null;
                    void reorderCanonical(activeId, focused, { before, after });
                    return;
                  }
                  if (e.key === "Home") {
                    e.preventDefault();
                    void reorderCanonical(activeId, focused, {
                      before: null,
                      after: list[0]?.key ?? null,
                    });
                    return;
                  }
                  if (e.key === "End") {
                    e.preventDefault();
                    void reorderCanonical(activeId, focused, {
                      before: list[list.length - 1]?.key ?? null,
                      after: null,
                    });
                  }
                }
              : undefined
          }
          activity={activity}
          presence={presence}
          initialFilterSet={layout.filterSet ?? null}
          onFilterSetChange={(fs) => {
            setLayout((cur) => {
              const next = { ...cur, filterSet: fs };
              setGridLayout(activeId, next);
              return next;
            });
          }}
          initialSort={layout.sort ?? undefined}
          onViewHistory={(rowKey, field) => {
            const row = list.find((c) => c.key === rowKey);
            if (!row) return;
            setRecordHistory({ rowKey, label: row.label, field: field ?? null });
          }}
          onSortChange={(sort) => {
            setLayout((cur) => {
              const next = { ...cur, sort: sort ?? null };
              setGridLayout(activeId, next);
              return next;
            });
            // Clear the per-session dismiss so the banner reappears if sort is re-applied
            if (sort) {
              setDismissedSortBanner((s) => {
                const next = new Set(s);
                next.delete(activeId);
                return next;
              });
            }
          }}
          onMapValuesToRecord={(recordKey) => {
            const next = new URLSearchParams(window.location.search);
            next.set("mode", "match");
            next.set("target", recordKey);
            navigate(`?${next.toString()}`);
            // Switch perTabMode directly — writing ?mode= to the URL is NOT
            // sufficient for already-open tabs because foldUrlMode is gated by
            // foldedDimsRef and only runs once per dim per session.
            onModeChange?.("match");
          }}
        />

        {addOpen && canEdit && (
          <AddFieldPopover
            anchorRef={addFieldRef as React.RefObject<HTMLElement | null>}
            onClose={() => setAddOpen(false)}
            allDims={allDims.map((d) => ({ id: d.id, dimension: d.dimension }))}
            currentDimId={activeId}
            onSubmit={async ({ label, config }) => {
              const required = config.required;
              const validation = config.validation;
              if (config.type === "linked") {
                await addField(activeId, label, "linked", undefined, {
                  referencedDimId: config.targetDimId,
                  displayFields: config.displayFields,
                  required,
                });
              } else if (config.type === "number") {
                await addField(activeId, label, "number", undefined, {
                  numberFormat: config.numberFormat,
                  required,
                  validation,
                });
              } else if (config.type === "select") {
                await addField(activeId, label, "select", config.options, { required });
              } else if (config.type === "rating") {
                await addField(activeId, label, "rating", undefined, {
                  ratingMax: config.ratingMax,
                  required,
                });
              } else {
                await addField(activeId, label, config.type, undefined, { required, validation });
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
            <Button
              size="sm"
              icon={<IconPlus className="h-3.5 w-3.5" />}
              onClick={add}
              disabled={!draft.trim()}
              loading={addQueue.pending > 0}
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
                  placeholder={sel.length < 2 ? "select 2+" : "Keep which record?"}
                  onPick={(survivorLabel) => {
                    if (sel.length < 2) return;
                    const survivorKey = list.find((c) => c.label === survivorLabel)?.key;
                    if (!survivorKey) return;
                    const loserKeys = sel.filter((k) => k !== survivorKey);
                    const loserRows = dim.canonical.filter((c) => loserKeys.includes(c.key));
                    const allUndefined = loserRows.every((c) => c.variants === undefined);
                    const loserVariantSum = allUndefined
                      ? null
                      : loserRows.reduce((n, c) => n + (c.variants ?? 0), 0);
                    setMergeConfirm({ survivorLabel, loserCount: sel.length - 1, loserVariantSum });
                  }}
                />
              </span>
            </label>
            <Button
              size="sm"
              variant="secondary"
              icon={<IconX className="h-3.5 w-3.5" />}
              onClick={() => {
                const selRows = dim.canonical.filter((c) => sel.includes(c.key));
                const allUndefined = selRows.every((c) => c.variants === undefined);
                const variantSum = allUndefined
                  ? null
                  : selRows.reduce((n, c) => n + (c.variants ?? 0), 0);
                setBulkRemoveConfirm({ count: sel.length, variantSum });
              }}
              disabled={busy}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      <ImportPreviewDialog
        open={pendingImport !== null}
        headers={pendingImport?.headers ?? []}
        rows={pendingImport?.rawRows ?? []}
        mapping={pendingImport?.mapping ?? { labelIdx: -1, keyIdx: -1, fieldIdx: {}, ignored: [] }}
        fields={fields}
        importing={importing}
        tableName={dim.dimension}
        onConfirm={async (mapped) => {
          setPendingImport(null);
          setImporting(true);
          try {
            const toImport = mapped.map((r) => ({
              key: r.key || undefined,
              label: r.label || undefined,
              fields:
                Object.keys(r.fields).length > 0
                  ? Object.fromEntries(
                      Object.entries(r.fields).map(([k, v]) => [k, v === "" ? null : v]),
                    )
                  : undefined,
            }));
            const r = await importRows(activeId, toImport);
            toast(`Imported — ${r.created} created · ${r.updated} updated · ${r.skipped} skipped`);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Couldn't import.", "error");
          } finally {
            setImporting(false);
          }
        }}
        onCancel={() => setPendingImport(null)}
      />

      <ConfirmDialog
        open={revertConfirm}
        title={`Revert ${pubState?.changedKeys.length ?? 0} change${(pubState?.changedKeys.length ?? 0) === 1 ? "" : "s"}?`}
        body={
          <>
            Every changed record goes back to Version {pubState?.version}: edits are undone, records
            added since are removed, and records removed since come back. This can&apos;t be undone.
          </>
        }
        confirmLabel="Revert changes"
        danger
        loading={reverting}
        onConfirm={doRevert}
        onCancel={() => setRevertConfirm(false)}
      />

      <ConfirmDialog
        open={bulkRemoveConfirm !== null}
        title="Remove these records?"
        body={
          bulkRemoveConfirm && (
            <>
              {bulkRemoveConfirm.count} record{bulkRemoveConfirm.count === 1 ? "" : "s"} will be
              retired.{" "}
              {bulkRemoveConfirm.variantSum !== null && (
                <>
                  {bulkRemoveConfirm.variantSum} source value
                  {bulkRemoveConfirm.variantSum === 1 ? "" : "s"} will lose their record and
                  reappear in Review.{" "}
                </>
              )}
              Use Undo if you change your mind.
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
        open={deleteColumnConfirm !== null}
        title={deleteColumnConfirm ? `Delete "${deleteColumnConfirm.label}"?` : "Delete column?"}
        body={
          deleteColumnConfirm && (
            <>
              {deleteColumnConfirm.lookupCount > 0 ? (
                <>
                  This will also remove {deleteColumnConfirm.lookupCount} linked column
                  {deleteColumnConfirm.lookupCount === 1 ? "" : "s"} that depend on it.
                </>
              ) : (
                <>This will remove the linked column.</>
              )}
            </>
          )
        }
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!deleteColumnConfirm) return;
          const { field } = deleteColumnConfirm;
          setDeleteColumnConfirm(null);
          await deleteColumn(activeId, field);
        }}
        onCancel={() => setDeleteColumnConfirm(null)}
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
              .{" "}
              {mergeConfirm.loserVariantSum !== null ? (
                <>
                  {mergeConfirm.loserVariantSum} source value
                  {mergeConfirm.loserVariantSum === 1 ? "" : "s"} currently mapped to them will
                  re-point to{" "}
                  <code className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">
                    {mergeConfirm.survivorLabel}
                  </code>{" "}
                  on next publish.{" "}
                </>
              ) : (
                <>Their source values will be re-pointed. </>
              )}
              Use Undo if you change your mind.
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

      <ConfirmDialog
        open={orderingConfirm === "manual"}
        title="Switch to manual ordering?"
        body={`This will assign positions to all ${list.length} rows in their current display order. You can drag rows to reorder them afterwards.`}
        confirmLabel="Switch to manual"
        onConfirm={async () => {
          await patchDimension(activeId, { orderingMode: "manual" });
          setOrderingConfirm(null);
        }}
        onCancel={() => setOrderingConfirm(null)}
      />

      <ConfirmDialog
        open={orderingConfirm === "derived"}
        title="Switch to derived ordering?"
        body={
          <>
            <div>
              This will null the positions on all {list.length} rows. Switching back to manual later
              will assign new positions — your current manual order cannot be recovered.
            </div>
            <button
              type="button"
              onClick={() => exportToCSV(dim)}
              className="mt-2 text-[12px] text-accent hover:underline"
            >
              Export the current order to CSV first
            </button>
          </>
        }
        confirmLabel="Switch to derived"
        danger
        onConfirm={async () => {
          await patchDimension(activeId, { orderingMode: "derived" });
          setOrderingConfirm(null);
        }}
        onCancel={() => setOrderingConfirm(null)}
      />

      <ConfirmDialog
        open={rebalanceConfirm}
        title="Rebalance positions?"
        body="Reassign positions in evenly-spaced steps of 1024. This is safe to do at any time."
        confirmLabel="Rebalance"
        onConfirm={async () => {
          await rebalancePositions(activeId);
          setRebalanceConfirm(false);
        }}
        onCancel={() => setRebalanceConfirm(false)}
      />

      <PublishPreviewDialog
        open={publishPreview}
        publishing={publishing}
        groups={publishGroups}
        onDiscardDraft={(d) => {
          void discardDraft(d.dimId, d.raw);
          setPublishGroups((gs) =>
            gs
              .map((g) =>
                g.dimId === d.dimId ? { ...g, drafts: g.drafts.filter((x) => x.raw !== d.raw) } : g,
              )
              .filter((g) => g.drafts.length > 0 || g.changedKeys.length > 0),
          );
        }}
        onConfirm={() => {
          const draftKeys = publishGroups.flatMap((g) => g.drafts.map((d) => d.raw));
          void doPublish(draftKeys).then(() => setPublishPreview(false));
        }}
        onCancel={() => setPublishPreview(false)}
      />

      <RecordHistoryDrawer
        open={recordHistory != null}
        tableId={activeId}
        rowKey={recordHistory?.rowKey ?? null}
        recordLabel={recordHistory?.label ?? null}
        tableName={dim.dimension}
        field={recordHistory?.field ?? null}
        canRestore={canEdit}
        onRestore={
          recordHistory
            ? (field, value) => commitCell(recordHistory.rowKey, field, value)
            : undefined
        }
        onClose={() => setRecordHistory(null)}
      />
    </div>
  );
}
