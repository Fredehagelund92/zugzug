import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import { IconFilter, IconX, IconChevronLeft } from "../Icons";
import type { FilterCondition, FilterOperator, FilterSet, ColumnDef, CellType } from "./types";

// ── helpers ──────────────────────────────────────────────────────────────────

function nextId(): string {
  return Math.random().toString(36).slice(2, 9);
}

const OPERATORS: {
  op: FilterOperator;
  label: string;
  types: CellType[] | "all";
  hasValue: boolean;
}[] = [
  { op: "contains", label: "contains", types: ["text", "select"], hasValue: true },
  { op: "not_contains", label: "not contains", types: ["text", "select"], hasValue: true },
  { op: "equals", label: "equals", types: "all", hasValue: true },
  { op: "not_equals", label: "not equals", types: "all", hasValue: true },
  { op: "starts_with", label: "starts with", types: ["text", "select"], hasValue: true },
  { op: "ends_with", label: "ends with", types: ["text", "select"], hasValue: true },
  { op: "is_empty", label: "is empty", types: "all", hasValue: false },
  { op: "is_not_empty", label: "is not empty", types: "all", hasValue: false },
];

function operatorsFor(type: CellType): typeof OPERATORS {
  return OPERATORS.filter((o) => o.types === "all" || o.types.includes(type));
}

function conditionLabel(cond: FilterCondition, columns: ColumnDef<unknown>[]): string {
  const col = columns.find((c) => c.field === cond.field);
  const opMeta = OPERATORS.find((o) => o.op === cond.operator);
  const fieldLabel = col?.label ?? cond.field;
  const opLabel = opMeta?.label ?? cond.operator;
  if (!opMeta?.hasValue) return `${fieldLabel} ${opLabel}`;
  return `${fieldLabel} ${opLabel} "${cond.value}"`;
}

// ── FilterConditionEditor (popover) ──────────────────────────────────────────

interface EditorProps<Row> {
  columns: ColumnDef<Row>[];
  initial?: Partial<FilterCondition>;
  anchorRef: React.RefObject<HTMLElement | null>;
  onSave: (cond: FilterCondition) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 260;

function FilterConditionEditor<Row>({
  columns,
  initial,
  anchorRef,
  onSave,
  onClose,
}: EditorProps<Row>) {
  const visibleCols = columns.filter((c) => !c.hidden);
  const defaultField = initial?.field ?? visibleCols[0]?.field ?? "";
  const [field, setField] = useState(defaultField);
  const colType = visibleCols.find((c) => c.field === field)?.config.type ?? "text";
  const ops = operatorsFor(colType);
  const defaultOp = initial?.operator ?? ops[0]?.op ?? "contains";
  const [operator, setOperator] = useState<FilterOperator>(defaultOp);
  const [value, setValue] = useState(initial?.value ?? "");
  const ref = useRef<HTMLDivElement>(null);
  const opMeta = OPERATORS.find((o) => o.op === operator);

  // Reposition popover below anchor.
  // On mobile (<768px) centers horizontally in the viewport.
  useLayoutEffect(() => {
    const popover = ref.current;
    const anchor = anchorRef.current;
    if (!popover || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const popH = popover.offsetHeight;

      if (window.innerWidth < 768) {
        const margin = 16;
        const w = Math.min(POPOVER_WIDTH, window.innerWidth - margin * 2);
        popover.style.width = `${w}px`;
        popover.style.left = `${Math.max(margin, (window.innerWidth - w) / 2)}px`;
        let top = a.bottom + 4;
        if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - 4 - popH);
        popover.style.top = `${top}px`;
        return;
      }

      popover.style.width = `${POPOVER_WIDTH}px`;
      let left = a.left;
      if (left + POPOVER_WIDTH > window.innerWidth - 8)
        left = window.innerWidth - POPOVER_WIDTH - 8;
      let top = a.bottom + 4;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - 4 - popH);
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  // Close on outside click
  useLayoutEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const popover = ref.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (popover?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [anchorRef, onClose]);

  const save = () => {
    if (!field) return;
    onSave({
      id: initial?.id ?? nextId(),
      field,
      operator,
      value: opMeta?.hasValue ? value.trim() : "",
    });
  };

  const inputCls =
    "w-full rounded-sm border border-line bg-bg px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent";

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: 0, left: 0 }}
      className="zz-pop-in z-50 rounded-sm border border-line-2 bg-surface-elevated p-2 shadow-pop"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-3">
        Column
      </div>
      <select
        value={field}
        onChange={(e) => {
          setField(e.target.value);
          const newType =
            visibleCols.find((c) => c.field === e.target.value)?.config.type ?? "text";
          const newOps = operatorsFor(newType);
          if (!newOps.find((o) => o.op === operator)) {
            setOperator(newOps[0]?.op ?? "contains");
          }
        }}
        className={cx(inputCls, "mb-2 cursor-pointer")}
      >
        {visibleCols.map((c) => (
          <option key={c.field} value={c.field}>
            {c.label}
          </option>
        ))}
      </select>

      <div className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-3">
        Condition
      </div>
      <select
        value={operator}
        onChange={(e) => setOperator(e.target.value as FilterOperator)}
        className={cx(inputCls, "mb-2 cursor-pointer")}
      >
        {ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>

      {opMeta?.hasValue && (
        <>
          <div className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-wider text-ink-3">
            Value
          </div>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={cx(inputCls, "mb-2")}
            placeholder="filter value…"
          />
        </>
      )}

      <div className="flex gap-1">
        <button
          type="button"
          onClick={save}
          className="flex-1 rounded-sm bg-accent px-2 py-1 font-mono text-[11.5px] text-accent-ink transition-opacity hover:opacity-90"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm px-2 py-1 font-mono text-[11.5px] text-ink-2 hover:bg-hover"
        >
          <IconChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

interface FilterBarProps<Row> {
  filterSet: FilterSet;
  columns: ColumnDef<Row>[];
  onChange: (next: FilterSet | null) => void;
}

export function FilterBar<Row>({ filterSet, columns, onChange }: FilterBarProps<Row>) {
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const upsert = (cond: FilterCondition) => {
    const exists = filterSet.conditions.findIndex((c) => c.id === cond.id);
    const conditions =
      exists >= 0
        ? filterSet.conditions.map((c) => (c.id === cond.id ? cond : c))
        : [...filterSet.conditions, cond];
    onChange({ ...filterSet, conditions });
    setAdding(false);
    setEditing(null);
  };

  const remove = (id: string) => {
    const conditions = filterSet.conditions.filter((c) => c.id !== id);
    onChange(conditions.length === 0 ? null : { ...filterSet, conditions });
  };

  const toggleConjunction = () => {
    onChange({
      ...filterSet,
      conjunction: filterSet.conjunction === "and" ? "or" : "and",
    });
  };

  // Stable refs for edit-pill anchors
  const pillRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-1.5">
      <IconFilter className="h-3 w-3 shrink-0 text-ink-3" />

      {filterSet.conditions.map((cond, i) => {
        const isFirst = i === 0;
        return (
          <React.Fragment key={cond.id}>
            {!isFirst && (
              <button
                type="button"
                onClick={toggleConjunction}
                className="rounded-pill bg-accent-wash px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-accent hover:opacity-80"
              >
                {filterSet.conjunction}
              </button>
            )}
            <span className="flex items-center gap-0 rounded-pill border border-line-2 bg-hover text-[11px]">
              <button
                ref={(el) => {
                  if (el) pillRefs.current.set(cond.id, el);
                  else pillRefs.current.delete(cond.id);
                }}
                type="button"
                onClick={() => setEditing((s) => (s === cond.id ? null : cond.id))}
                className="rounded-l-pill px-2.5 py-0.5 font-mono text-ink-2 hover:text-ink"
              >
                {conditionLabel(cond, columns as ColumnDef<unknown>[])}
              </button>
              <button
                type="button"
                aria-label="Remove filter"
                onClick={() => remove(cond.id)}
                className="rounded-r-pill px-1.5 py-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
              >
                <IconX className="h-3 w-3" />
              </button>
            </span>
            {editing === cond.id && (
              <FilterConditionEditor
                columns={columns}
                initial={cond}
                anchorRef={{ current: pillRefs.current.get(cond.id) ?? null }}
                onSave={upsert}
                onClose={() => setEditing(null)}
              />
            )}
          </React.Fragment>
        );
      })}

      <button
        ref={addRef}
        type="button"
        onClick={() => setAdding((s) => !s)}
        className="rounded-pill border border-dashed border-line-2 px-2.5 py-0.5 font-mono text-[11px] text-ink-3 hover:border-accent hover:text-accent"
      >
        + Add filter
      </button>
      {adding && (
        <FilterConditionEditor
          columns={columns}
          anchorRef={addRef}
          onSave={upsert}
          onClose={() => setAdding(false)}
        />
      )}

      <button
        type="button"
        onClick={() => onChange(null)}
        className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink"
      >
        Clear all
      </button>
    </div>
  );
}
