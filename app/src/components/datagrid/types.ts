import type { ReactNode } from "react";

/* types.ts — the DataGrid contract. Both MasterTables and Mapping mount the
   grid through these types; new cell types slot in via the union. */

export type CellType = "text" | "number" | "boolean" | "date" | "select";

export interface ColumnDef<Row> {
  field: string;                      // stable id
  label: string;                      // header text
  type: CellType;
  width?: number;                     // px; persisted via user_grid_layout
  hidden?: boolean;                   // persisted
  sortable?: boolean;                 // default true
  editable?: boolean;                 // default true
  pinnedLeft?: boolean;               // pinned columns can't be reordered or moved past
  align?: "left" | "right";           // default left
  options?: string[];                 // only set when type === "select"
  // Render hook for custom cell content (e.g. Mapping's source-value+provenance cell)
  render?: (row: Row, ctx: CellCtx<Row>) => ReactNode;
  // Editor hook for custom editing (e.g. Mapping's target-master ComboSelect)
  edit?: (row: Row, ctx: EditCtx<Row>) => ReactNode;
}

export interface CellCtx<Row> {
  row: Row;
  rowKey: string;
  field: string;
  value: unknown;
  focused: boolean;
}

export interface EditCtx<Row> extends CellCtx<Row> {
  commit: (next: unknown) => void;    // commit + advance cursor (Tab/Enter handled by grid)
  cancel: () => void;                 // Esc behavior
}

export interface Cursor {
  rowKey: string;
  field: string;
  editing: boolean;
}

export interface DataGridProps<Row> {
  rows: Row[];
  rowKey: (row: Row) => string;
  columns: ColumnDef<Row>[];
  selection?: { selected: string[]; onChange: (next: string[]) => void };
  /** Cell-value mutation. Implementations push an undo entry themselves. */
  onCommit: (rowKey: string, field: string, value: unknown) => Promise<void>;
  /** Triggered when the user invokes the header menu's "delete column" item. */
  onDeleteColumn?: (field: string) => void;
  /** Header menu: rename label */
  onRenameColumn?: (field: string, newLabel: string) => void;
  /** Header menu: change type (with the new type + new options if select). Set
   *  coerceInvalidToNull when re-trying after the host has confirmed N values
   *  would coerce to empty. */
  onChangeColumnType?: (field: string, newType: CellType, opts?: { options?: string[]; coerceInvalidToNull?: boolean }) => Promise<{ ok: boolean; invalidCount?: number }>;
  /** Header menu: add a new option to a select column. Returns the new option list. */
  onAddColumnOption?: (field: string, label: string) => Promise<string[]>;
  /** Layout changes (width / order / hidden) the grid asks the host to persist. */
  onLayoutChange?: (next: { widths?: Record<string, number>; order?: string[]; hidden?: string[] }) => void;
  /** Optional: empty-state slot. */
  empty?: ReactNode;
}
