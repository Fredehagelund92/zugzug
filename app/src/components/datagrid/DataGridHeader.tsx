import React, { useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { Checkbox } from "../Checkbox";
import {
  IconEye,
  IconFieldBoolean,
  IconFieldDate,
  IconFieldNumber,
  IconFieldSelect,
  IconFieldText,
} from "../Icons";
import { ColumnHeaderMenu } from "./ColumnHeaderMenu";
import { HiddenFieldsPopover } from "./HiddenFieldsPopover";
import type { CellType, ColumnDef, FilterSet, ColumnConfig, ConditionalRule } from "./types";

type LayoutChange = {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
};
import { attrEsc } from "./util";

const IconFieldUrl = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ↗
  </span>
);
const IconFieldEmail = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    @
  </span>
);
const IconFieldRating = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ★
  </span>
);
const IconFieldLinked = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ⇢
  </span>
);

const FIELD_TYPE_ICONS: Record<CellType, React.ComponentType<{ className?: string }>> = {
  text: IconFieldText,
  number: IconFieldNumber,
  boolean: IconFieldBoolean,
  date: IconFieldDate,
  select: IconFieldSelect,
  url: IconFieldUrl,
  email: IconFieldEmail,
  rating: IconFieldRating,
  linked: IconFieldLinked,
};

interface DragState {
  field: string;
  overIndex: number | null;
}

interface SelectionAPI {
  selected: string[];
  onChange: (next: string[]) => void;
}

interface SortState {
  field: string;
  dir: "asc" | "desc";
}

interface DataGridHeaderProps<Row> {
  columns: ColumnDef<Row>[]; // ordered visible
  allColumns: ColumnDef<Row>[]; // full list (for hidden-list merging)
  gridStyle: React.CSSProperties;
  cellPadY: string;
  showRowNumbers: boolean;
  selectionCol: boolean;

  // Select-all checkbox (only used when selectionCol)
  selection: SelectionAPI | undefined;
  sortedRows: Row[];
  rowKey: (row: Row) => string;

  // Sort
  sort: SortState | null;
  setSort: React.Dispatch<React.SetStateAction<SortState | null>>;

  // Filter
  filterSet: FilterSet | null;
  setFilterSet: React.Dispatch<React.SetStateAction<FilterSet | null>>;

  // Widths
  setWidths: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  /** Ref mirror of the widths state — lets event handlers read the latest
   *  committed widths without accessing state inside an updater function. */
  widthsRef: React.MutableRefObject<Record<string, number>>;

  // Order / drag
  setOrder: React.Dispatch<React.SetStateAction<string[] | null>>;
  drag: DragState | null;
  setDrag: React.Dispatch<React.SetStateAction<DragState | null>>;
  dragRef: React.MutableRefObject<DragState | null>;

  // Column-header menu
  menuFor: string | null;
  setMenuFor: React.Dispatch<React.SetStateAction<string | null>>;
  menuAnchorRef: React.MutableRefObject<HTMLElement | null>;
  menuAnchorRect: DOMRect | null;
  setMenuAnchorRect: React.Dispatch<React.SetStateAction<DOMRect | null>>;
  setRulesEditor: React.Dispatch<React.SetStateAction<string | null>>;
  setDescEditor: React.Dispatch<React.SetStateAction<string | null>>;

  // Column-hover highlight (shared with body)
  onColumnHover: (field: string | null) => void;

  // Scroll container (used to focus on plain-click column select + measure
  // cells for fit-to-content double-click).
  scrollContainerRef: React.RefObject<HTMLDivElement>;

  // Range / cursor (column-click whole-column-select)
  rangeRef: React.MutableRefObject<{
    anchor: { rowKey: string; field: string };
    focus: { rowKey: string; field: string };
  } | null>;
  setRange: React.Dispatch<
    React.SetStateAction<{
      anchor: { rowKey: string; field: string };
      focus: { rowKey: string; field: string };
    } | null>
  >;
  setCursor: (cur: { rowKey: string; field: string; editing: boolean }) => void;

  // Add-field affordance
  onAddFieldClick: (() => void) | undefined;
  addFieldRef: React.RefObject<HTMLButtonElement> | undefined;

  // Host wiring
  onLayoutChange?: (change: LayoutChange) => void;
  onRenameColumn?: (field: string, label: string) => void;
  onSaveColumnRules?: (field: string, rules: ConditionalRule[]) => void;
  onSaveColumnDescription?: (field: string, desc: string | null) => void;
  onChangeColumnType?: (
    field: string,
    newConfig: ColumnConfig,
    opts?: { coerceInvalidToNull?: boolean },
  ) => Promise<{ ok: boolean; invalidCount?: number }>;
  onDeleteColumn?: (field: string) => void;
}

export function DataGridHeader<Row>(props: DataGridHeaderProps<Row>): React.ReactElement {
  const {
    columns,
    allColumns,
    gridStyle,
    cellPadY,
    showRowNumbers,
    selectionCol,
    selection,
    sortedRows,
    rowKey,
    sort,
    setSort,
    filterSet,
    setFilterSet,
    setWidths,
    widthsRef,
    setOrder,
    drag,
    setDrag,
    dragRef,
    menuFor,
    setMenuFor,
    menuAnchorRef,
    menuAnchorRect,
    setMenuAnchorRect,
    setRulesEditor,
    setDescEditor,
    onColumnHover,
    scrollContainerRef,
    rangeRef,
    setRange,
    setCursor,
    onAddFieldClick,
    addFieldRef,
    onLayoutChange,
    onRenameColumn,
    onSaveColumnRules,
    onSaveColumnDescription,
    onChangeColumnType,
    onDeleteColumn,
  } = props;

  // Hidden-fields popover is local to the header — no other surface reads it.
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const hiddenAnchorRef = useRef<HTMLButtonElement | null>(null);
  const hiddenList = allColumns.filter((c) => c.hidden);

  return (
    <>
      <div
        role="row"
        aria-rowindex={1}
        className="zz-grid-header grid sticky top-0 z-10 items-stretch border-b border-line bg-surface text-[12px] font-medium text-ink-2"
        style={gridStyle}
      >
        {showRowNumbers && (
          <div
            className={cx(
              "flex items-center justify-end border-r border-line pr-2 font-mono text-[10px] text-ink-3",
              cellPadY,
            )}
          >
            #
          </div>
        )}
        {selectionCol && (
          <div className={cx("flex items-center justify-center border-r border-line", cellPadY)}>
            <Checkbox
              state={
                selection!.selected.length === sortedRows.length && sortedRows.length > 0
                  ? "on"
                  : selection!.selected.length > 0
                    ? "mixed"
                    : "off"
              }
              onClick={() =>
                selection!.onChange(
                  selection!.selected.length === sortedRows.length ? [] : sortedRows.map(rowKey),
                )
              }
              aria-label="Select all"
            />
          </div>
        )}
        {columns.map((c, idx) => {
          const sortGlyph = sort?.field === c.field ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
          const TypeIcon = FIELD_TYPE_ICONS[c.config.type];
          const isLastCol = idx === columns.length - 1;
          return (
            <div
              key={c.field}
              role="columnheader"
              aria-colindex={idx + 1}
              aria-sort={
                sort?.field === c.field ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
              }
              className={cx(
                "group relative flex items-center gap-1.5 px-3",
                cellPadY,
                !isLastCol && "border-r border-line",
                c.pinnedLeft && idx === 0 && "sticky left-0 z-10 bg-surface",
              )}
              data-header={c.field}
              onMouseEnter={() => onColumnHover(c.field)}
              onMouseLeave={() => onColumnHover(null)}
            >
              {TypeIcon && <TypeIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
              {/* Task 21: dragged-column wash + drop-target line */}
              {drag?.field === c.field && (
                <span className="absolute inset-0 bg-accent-wash" aria-hidden />
              )}
              {drag?.overIndex != null && columns[drag.overIndex]?.field === c.field && (
                <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" aria-hidden />
              )}

              {/* Task 21: hold-then-drag label — always left-aligned, even on
                right-aligned (numeric) columns. Spreadsheet convention:
                headers read uniformly left-to-right while the body cells
                themselves right-align their numbers for tabular comparison. */}
              <span
                className={cx(
                  "min-w-0 flex-1 truncate cursor-grab select-none",
                  c.pinnedLeft && "cursor-default",
                )}
                onPointerDown={(e) => {
                  if (c.pinnedLeft) return;
                  let holding = true;
                  let moved = false;
                  const startTime = Date.now();
                  const holdTimer = window.setTimeout(() => {
                    if (!holding) return;
                    setDrag({ field: c.field, overIndex: null });
                  }, 200);
                  const onMove = (ev: PointerEvent) => {
                    moved = true;
                    if (!dragRef.current) return;
                    // determine which header column we're over via element-at-point
                    const target = document.elementFromPoint(
                      ev.clientX,
                      ev.clientY,
                    ) as HTMLElement | null;
                    const headerEl = target?.closest<HTMLElement>("[data-header]");
                    const overField = headerEl?.dataset.header ?? null;
                    if (overField == null) return;
                    const next = columns.findIndex((x) => x.field === overField);
                    setDrag((d) => (d ? { ...d, overIndex: next } : d));
                  };
                  const onUp = () => {
                    holding = false;
                    window.clearTimeout(holdTimer);
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    const elapsed = Date.now() - startTime;
                    if (!moved && elapsed < 200 && !dragRef.current) {
                      // Plain click — select whole column
                      scrollContainerRef.current?.focus({ preventScroll: true });
                      const firstRow = sortedRows[0];
                      const lastRow = sortedRows[sortedRows.length - 1];
                      if (firstRow && lastRow) {
                        const anchor = { rowKey: rowKey(firstRow), field: c.field };
                        const focus = { rowKey: rowKey(lastRow), field: c.field };
                        if (e.shiftKey && rangeRef.current) {
                          setRange({ anchor: rangeRef.current.anchor, focus });
                        } else {
                          setRange({ anchor, focus });
                        }
                        setCursor({
                          rowKey: anchor.rowKey,
                          field: c.field,
                          editing: false,
                        });
                      }
                      return;
                    }
                    // Read drag state synchronously then clear it — avoids calling
                    // setOrder/onLayoutChange inside a setDrag updater (setState-in-render).
                    const d = dragRef.current;
                    setDrag(null);
                    if (d && d.overIndex != null) {
                      const from = columns.findIndex((x) => x.field === d.field);
                      if (from >= 0 && from !== d.overIndex) {
                        const next = [...columns.map((x) => x.field)];
                        next.splice(from, 1);
                        next.splice(d.overIndex, 0, d.field);
                        setOrder(next);
                        onLayoutChange?.({ order: next });
                      }
                    }
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
              >
                {c.label}
                {c.linkedStale && (
                  <span
                    className="ml-1 text-warn"
                    title="Source field was renamed — reconfigure"
                    aria-label="Stale lookup"
                  >
                    ⚠
                  </span>
                )}
                {sortGlyph}
              </span>
              {filterSet?.conditions.some((fc) => fc.field === c.field) && (
                <span
                  className="rounded-pill bg-accent-wash px-1 font-mono text-[9px] text-accent"
                  title="column filtered"
                >
                  ▣
                </span>
              )}

              {/* description info badge — paired with the ⋯ menu in the
                right-side metadata cluster so the label stays left-aligned
                across columns regardless of whether a description exists. */}
              {c.description && (
                <span
                  data-field-info
                  title={c.description}
                  className="ml-auto inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-line-2 text-[8px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  aria-label={`Description: ${c.description}`}
                >
                  i
                </span>
              )}

              {/* Task 19: ⋯ menu button — pinned to the right cluster. When the
                info badge is present it owns ml-auto; otherwise the button does. */}
              <button
                type="button"
                aria-label="Column menu"
                className={cx(
                  "opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 max-md:opacity-40",
                  !c.description && "ml-auto",
                )}
                onClick={(e) => {
                  menuAnchorRef.current = e.currentTarget;
                  setMenuAnchorRect(null);
                  setMenuFor((s) => (s === c.field ? null : c.field));
                }}
              >
                ⋯
              </button>

              {/* Task 19: ColumnHeaderMenu */}
              {menuFor === c.field && (
                <ColumnHeaderMenu
                  column={c}
                  anchorRef={menuAnchorRef}
                  anchorRect={menuAnchorRect}
                  sortDir={sort?.field === c.field ? sort.dir : null}
                  filterValue={
                    filterSet?.conditions.find(
                      (fc) => fc.field === c.field && fc.operator === "contains",
                    )?.value ?? null
                  }
                  onClose={() => {
                    setMenuFor(null);
                    setMenuAnchorRect(null);
                  }}
                  onRename={(label) => onRenameColumn?.(c.field, label)}
                  onSort={(dir) => setSort(dir ? { field: c.field, dir } : null)}
                  onOpenRules={
                    onSaveColumnRules
                      ? () => {
                          setMenuFor(null);
                          setRulesEditor(c.field);
                        }
                      : undefined
                  }
                  onEditDescription={
                    onSaveColumnDescription
                      ? () => {
                          setMenuFor(null);
                          setDescEditor(c.field);
                        }
                      : undefined
                  }
                  onFilter={(v) =>
                    setFilterSet((cur) => {
                      const existing = cur?.conditions ?? [];
                      const withoutThis = existing.filter(
                        (fc) => !(fc.field === c.field && fc.operator === "contains"),
                      );
                      if (!v) {
                        return withoutThis.length === 0
                          ? null
                          : { conjunction: cur?.conjunction ?? "and", conditions: withoutThis };
                      }
                      const conditions = [
                        ...withoutThis,
                        {
                          id: `${c.field}-contains`,
                          field: c.field,
                          operator: "contains" as const,
                          value: v,
                        },
                      ];
                      return { conjunction: cur?.conjunction ?? "and", conditions };
                    })
                  }
                  onChangeType={async (newConfig) => {
                    if (!onChangeColumnType) return;
                    const res = await onChangeColumnType(c.field, newConfig);
                    if (!res.ok && res.invalidCount) {
                      if (
                        confirm(
                          `${res.invalidCount} value(s) won't parse as ${newConfig.type}. Coerce to empty?`,
                        )
                      ) {
                        await onChangeColumnType(c.field, newConfig, {
                          coerceInvalidToNull: true,
                        });
                      }
                    }
                  }}
                  onHide={() => {
                    // include any already-hidden columns from the full prop list — `visible`
                    // is the post-filter set and never contains them
                    const hidden = [
                      ...allColumns.filter((v) => v.hidden).map((v) => v.field),
                      c.field,
                    ];
                    onLayoutChange?.({ hidden });
                  }}
                  onDelete={() => onDeleteColumn?.(c.field)}
                />
              )}

              {/* Task 20: right-edge resize grip — 8px hit area straddling the
                column boundary (4px each side); the visible 2px bar appears on
                hover only. Sheets/Airtable pattern. Narrower than 12px so it
                doesn't overlap the ⋯ menu trigger's right edge. */}
              {!c.pinnedLeft && (
                <span
                  aria-hidden
                  className="absolute right-[-4px] top-0 bottom-0 w-2 z-[2] cursor-col-resize group/grip"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const headerEl = e.currentTarget.parentElement as HTMLElement;
                    const startW = headerEl.getBoundingClientRect().width;
                    // Track the latest width for this column in a closure variable.
                    // onUp uses it (plus the widthsRef for other columns) to call
                    // onLayoutChange outside any setState updater — avoiding the
                    // "setState-in-render" anti-pattern where onLayoutChange (which
                    // may setState in a parent) fires during React's reconciliation.
                    let latestWidth: number = startW;
                    const onMove = (ev: PointerEvent) => {
                      const next = Math.max(60, Math.min(600, startW + (ev.clientX - startX)));
                      latestWidth = next;
                      setWidths((w) => ({ ...w, [c.field]: next }));
                    };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      // Notify the host outside any setState updater. Build the widths
                      // map from the ref (always current) plus the closure-tracked
                      // final width for the dragged column.
                      const finalWidths = { ...widthsRef.current, [c.field]: latestWidth };
                      onLayoutChange?.({ widths: finalWidths });
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }}
                  onDoubleClick={(e) => {
                    // Fit column to widest visible rendered cell (header + body).
                    // Airtable-style: measure only what's in the DOM. Body cells
                    // are selected by an exact data-field match (no suffix collisions,
                    // attribute value escaped). Header is the grip's parent.
                    //
                    // Renderers truncate their inner span (overflow:hidden +
                    // text-overflow:ellipsis + white-space:nowrap), so the wrapper's
                    // scrollWidth reflects its current rendered width, not the natural
                    // content width. We temporarily relax the truncating styles on
                    // the inner span, read scrollWidth, then restore. We mutate/restore
                    // inline (rather than cloning the subtree) because cloning is more
                    // expensive and this runs only once per double-click; a synchronous
                    // mutate→read→restore stays within one task, so no flash is visible.
                    const root = scrollContainerRef.current;
                    if (!root) return;
                    const measureNatural = (el: HTMLElement): number => {
                      const inner = el.firstElementChild as HTMLElement | null;
                      const target = inner ?? el;
                      const prev = {
                        maxWidth: target.style.maxWidth,
                        overflow: target.style.overflow,
                        textOverflow: target.style.textOverflow,
                        whiteSpace: target.style.whiteSpace,
                      };
                      target.style.maxWidth = "none";
                      target.style.overflow = "visible";
                      target.style.textOverflow = "clip";
                      target.style.whiteSpace = "nowrap";
                      const w = target.scrollWidth;
                      target.style.maxWidth = prev.maxWidth;
                      target.style.overflow = prev.overflow;
                      target.style.textOverflow = prev.textOverflow;
                      target.style.whiteSpace = prev.whiteSpace;
                      return w;
                    };
                    // Wrappers use px-3 = 12px horizontal padding each side = 24px total.
                    const PAD = 24;
                    const headerEl = e.currentTarget.parentElement as HTMLElement | null;
                    const cells = root.querySelectorAll<HTMLElement>(
                      `[data-field="${attrEsc(c.field)}"]`,
                    );
                    let max = 60;
                    if (headerEl) {
                      const hw = measureNatural(headerEl) + PAD;
                      if (hw > max) max = hw;
                    }
                    for (const cell of cells) {
                      const w = measureNatural(cell) + PAD;
                      if (w > max) max = w;
                    }
                    const next = Math.min(600, Math.max(60, max));
                    // Compute the full updated widths map from the ref (which always
                    // holds the latest committed state) before calling setWidths, so
                    // onLayoutChange can fire outside any setState updater and avoid
                    // the setState-in-render anti-pattern.
                    const updatedWidths = { ...widthsRef.current, [c.field]: next };
                    setWidths(updatedWidths);
                    onLayoutChange?.({ widths: updatedWidths });
                  }}
                >
                  <span
                    aria-hidden
                    className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-[2px] bg-line-2 opacity-0 transition-opacity group-hover/grip:opacity-100"
                  />
                </span>
              )}
            </div>
          );
        })}
        {onAddFieldClick && (
          <div className="flex items-center">
            {hiddenList.length > 0 && (
              <button
                ref={hiddenAnchorRef}
                type="button"
                onClick={() => setHiddenOpen((s) => !s)}
                className="flex items-center gap-1.5 px-2 py-2 text-[12px] font-medium text-ink-3 transition-colors hover:text-accent"
                aria-label="Show hidden fields"
              >
                <IconEye className="h-3.5 w-3.5" />
                <span className="tabular-nums">{hiddenList.length} hidden</span>
              </button>
            )}
            <button
              ref={addFieldRef as React.RefObject<HTMLButtonElement>}
              type="button"
              onClick={onAddFieldClick}
              className="px-3 py-2 text-[12px] font-medium text-accent transition-colors hover:brightness-110"
              aria-label="Add field"
            >
              + Field
            </button>
          </div>
        )}
      </div>
      {hiddenOpen && hiddenList.length > 0 && (
        <HiddenFieldsPopover
          hidden={hiddenList}
          anchorRef={hiddenAnchorRef}
          onUnhide={(field) => {
            const next = allColumns
              .filter((v) => v.hidden && v.field !== field)
              .map((v) => v.field);
            onLayoutChange?.({ hidden: next });
          }}
          onClose={() => setHiddenOpen(false)}
        />
      )}
    </>
  );
}
