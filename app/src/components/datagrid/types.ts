import type { ReactNode } from "react";
import type React from "react";
import type { OptionDef } from "../../data";

/* types.ts — the DataGrid contract. Both MasterTables and Mapping mount the
   grid through these types; new cell types slot in via the union. */

export type CellType = "text" | "number" | "boolean" | "date" | "select";

export interface ColumnDef<Row> {
  field: string; // stable id
  label: string; // header text
  type: CellType;
  width?: number; // px; persisted via user_grid_layout
  hidden?: boolean; // persisted
  sortable?: boolean; // default true
  editable?: boolean; // default true
  pinnedLeft?: boolean; // pinned columns can't be reordered or moved past
  align?: "left" | "right"; // default left
  options?: OptionDef[]; // only set when type === "select"
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
  /** The column definition for this cell — used by SelectCell to look up option colors. */
  column: ColumnDef<Row>;
}

export interface EditCtx<Row> extends CellCtx<Row> {
  commit: (next: unknown) => void; // commit + advance cursor (Tab/Enter handled by grid)
  cancel: () => void; // Esc behavior
  /** When edit was triggered by type-to-edit, the typed character. Editors
   *  should seed their input with this so the user's first keystroke counts. */
  initial?: string;
}

export interface Cursor {
  rowKey: string;
  field: string;
  editing: boolean;
  /** Set when edit was triggered by typing a printable character. Passed
   *  through to the editor's EditCtx.initial; cleared on next move/stopEdit. */
  initial?: string;
}

export type FilterOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty";

export interface FilterCondition {
  id: string;
  field: string;
  operator: FilterOperator;
  value: string;
}

export interface FilterSet {
  conjunction: "and" | "or";
  conditions: FilterCondition[];
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
  onChangeColumnType?: (
    field: string,
    newType: CellType,
    opts?: { options?: OptionDef[]; coerceInvalidToNull?: boolean },
  ) => Promise<{ ok: boolean; invalidCount?: number }>;
  /** Header menu: add a new option to a select column. Returns the new option list. */
  onAddColumnOption?: (
    field: string,
    label: string,
    color?: import("../../lib/palette").PaletteName | null,
  ) => Promise<OptionDef[]>;
  /** Layout changes (width / order / hidden) the grid asks the host to persist. */
  onLayoutChange?: (next: {
    widths?: Record<string, number>;
    order?: string[];
    hidden?: string[];
  }) => void;
  /** Optional: empty-state slot. */
  empty?: ReactNode;
  /** When set, renders a "+ field" button at the rightmost edge of the header row. */
  onAddFieldClick?: () => void;
  /** Ref forwarded to the "+ field" button so the host can anchor a popover. */
  addFieldRef?: React.MutableRefObject<HTMLElement | null>;
  /** Cell-value accessor. Defaults to `(row as Record<string, unknown>)[field]`.
   *  Pass a typed reader when the row type's fields don't match column `field`
   *  names directly (e.g. flattened nested objects). */
  getValue?: (row: Row, field: string) => unknown;
  /** Row density. "compact" tightens cell padding to ~24px rows; default ~32px. */
  density?: "default" | "compact";
  /** Prepend a 1-based row number column (read-only, 36px wide). */
  showRowNumbers?: boolean;
}
