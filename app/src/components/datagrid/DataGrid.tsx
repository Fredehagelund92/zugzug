import { useMemo } from "react";
import { cx } from "../../lib/cx";
import { Checkbox } from "../Checkbox";
import { TextCell } from "./cells/TextCell";
import { NumberCell } from "./cells/NumberCell";
import { BooleanCell } from "./cells/BooleanCell";
import { DateCell } from "./cells/DateCell";
import { SelectCell } from "./cells/SelectCell";
import { useGridCursor } from "./useGridCursor";
import { useUndoStack } from "./UndoStack";
import type { DataGridProps, CellType } from "./types";

const CELLS: Record<Exclude<CellType, "select">, { Renderer: any; Editor: any }> = {
  text: TextCell, number: NumberCell, boolean: BooleanCell, date: DateCell,
};

export function DataGrid<Row>(props: DataGridProps<Row>) {
  const { rows, rowKey, columns, selection, onCommit, empty } = props;
  const visible = columns.filter((c) => !c.hidden);
  const selectionCol = !!selection;
  const undo = useUndoStack();

  // template: optional checkbox + each visible column's width
  const gridStyle = useMemo(() => {
    const tracks = visible.map((c) => (c.width ? `${c.width}px` : "minmax(96px, 1fr)"));
    if (selectionCol) tracks.unshift("28px");
    return { gridTemplateColumns: tracks.join(" ") };
  }, [visible, selectionCol]);

  // pending edit value lives inside the editor; commit flows back via the props.onCommit
  const commitValue = async (rk: string, field: string, value: unknown) => {
    await onCommit(rk, field, value);
  };

  const cursor = useGridCursor({
    rows, rowKey, columns: visible,
    onCommit: () => { /* the editor's onBlur handles the actual value commit */ },
    onSelectAll: () => selection?.onChange(rows.map(rowKey)),
    onUndo: () => undo.undo(),
    onRedo: () => undo.redo(),
  });

  const isSelected = (rk: string) => selection?.selected.includes(rk) ?? false;
  const toggle = (rk: string) => {
    if (!selection) return;
    const next = isSelected(rk) ? selection.selected.filter((x) => x !== rk) : [...selection.selected, rk];
    selection.onChange(next);
  };

  return (
    <div
      ref={cursor.ref}
      tabIndex={0}
      onKeyDown={cursor.onKeyDown}
      className="overflow-x-auto rounded-lg border border-line bg-surface outline-none focus:ring-1 focus:ring-accent/40"
    >
      {/* header row */}
      <div className="grid items-center gap-3 border-b border-line px-5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3" style={gridStyle}>
        {selectionCol && (
          <Checkbox
            state={selection!.selected.length === rows.length && rows.length > 0
              ? "on"
              : selection!.selected.length > 0 ? "mixed" : "off"}
            onClick={() => selection!.onChange(
              selection!.selected.length === rows.length ? [] : rows.map(rowKey)
            )}
            aria-label="Select all"
          />
        )}
        {visible.map((c) => (
          <span key={c.field}
            className={cx("truncate", c.align === "right" && "text-right")}
            data-header={c.field}>{c.label}</span>
        ))}
      </div>

      {/* body */}
      {rows.length === 0 ? (
        empty ?? <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">No rows.</div>
      ) : rows.map((row) => {
        const rk = rowKey(row);
        const selected = isSelected(rk);
        return (
          <div key={rk}
            className={cx(
              "grid items-center gap-3 border-b border-line px-5 py-3 transition-colors",
              selected ? "bg-accent-wash" : "hover:bg-hover",
            )}
            style={gridStyle}
            data-row={rk}
          >
            {selectionCol && (
              <Checkbox state={selected ? "on" : "off"} onClick={() => toggle(rk)} aria-label={`Select row ${rk}`} />
            )}
            {visible.map((c) => {
              const focused = cursor.cursor?.rowKey === rk && cursor.cursor?.field === c.field;
              const editing = focused && cursor.cursor?.editing;
              const value = (row as any)[c.field];
              const ctx = { row, rowKey: rk, field: c.field, value, focused };
              const onClick = () => {
                cursor.setCursor({ rowKey: rk, field: c.field, editing: false });
              };
              const onDoubleClick = () => {
                if (c.editable === false) return;
                cursor.setCursor({ rowKey: rk, field: c.field, editing: true });
              };
              const cellCx = cx(
                "relative min-w-0 px-1",
                c.align === "right" && "justify-self-end text-right",
                focused && "ring-1 ring-accent bg-accent-wash/40 rounded-sm",
              );
              const data = `${rk}::${c.field}`;
              return (
                <div key={c.field}
                  data-cell={data}
                  onClick={onClick}
                  onDoubleClick={onDoubleClick}
                  className={cellCx}
                >
                  {editing && c.editable !== false
                    ? (c.edit
                        ? c.edit(row, {
                            ...ctx,
                            commit: (v: unknown) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                            cancel: () => cursor.stopEdit(),
                          })
                        : c.type === "select"
                          ? <SelectCell.Editor
                              row={row} rowKey={rk} field={c.field} value={value} focused
                              commit={(v: unknown) => { cursor.stopEdit(); void commitValue(rk, c.field, v); }}
                              cancel={() => cursor.stopEdit()}
                              options={c.options ?? []}
                              onCreate={async (label: string) => {
                                if (!props.onAddColumnOption) return c.options ?? [];
                                return await props.onAddColumnOption(c.field, label);
                              }}
                            />
                          : <CellEditor type={c.type} ctx={{
                              ...ctx,
                              commit: (v: unknown) => { cursor.stopEdit(); void commitValue(rk, c.field, v); },
                              cancel: () => cursor.stopEdit(),
                            }} />)
                    : (c.render
                        ? c.render(row, ctx)
                        : c.type === "select"
                          ? <SelectCell.Renderer {...ctx} />
                          : <CellRenderer type={c.type} ctx={ctx} />)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function CellRenderer({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return <SelectCell.Renderer {...ctx} />;
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Renderer {...ctx} />;
}

function CellEditor({ type, ctx }: { type: CellType; ctx: any }) {
  if (type === "select") return null; // select uses inline SelectCell.Editor in the body (needs options + onCreate)
  const C = CELLS[type as Exclude<CellType, "select">];
  return <C.Editor {...ctx} />;
}
