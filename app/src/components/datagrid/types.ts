import type { ReactNode } from "react";
import type React from "react";
import type { OptionDef, NumberFormat } from "../../data";
import type { PaletteName } from "../../lib/palette";
import type { RowActivityEntry } from "../../lib/use-row-activity";
import type { PeerState } from "../../lib/use-presence";
export type { NumberFormat };

export interface RuleStyle {
  cellBg?: PaletteName;
  textColor?: PaletteName;
  rowStripe?: PaletteName;
}

export type ConditionalRule =
  | {
      id: string;
      field: string;
      trigger: {
        kind: "equals" | "not_equals" | "contains" | "starts_with" | "ends_with";
        value: string;
      };
      style: RuleStyle;
    }
  | { id: string; field: string; trigger: { kind: "is_empty" | "is_not_empty" }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_in"; values: string[] }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "gt" | "lt"; value: number }; style: RuleStyle }
  | {
      id: string;
      field: string;
      trigger: { kind: "between"; min: number; max: number };
      style: RuleStyle;
    };

/* types.ts — the DataGrid contract. Both MasterTables and Mapping mount the
   grid through these types; new cell types slot in via the union. */

export type ColumnConfig =
  | { type: "text" }
  | { type: "number"; numberFormat?: NumberFormat }
  | { type: "boolean" }
  | { type: "date" }
  | { type: "select"; options: OptionDef[] }
  | { type: "url" }
  | { type: "email" }
  | { type: "rating"; ratingMax: number }
  | {
      type: "linked";
      targetDimId: string;
      displayFields: string[];
      candidates: { key: string; label: string }[];
    };

export type CellType = ColumnConfig["type"];

export interface ColumnDef<Row> {
  field: string;
  label: string;
  config: ColumnConfig;
  width?: number;
  hidden?: boolean;
  sortable?: boolean;
  editable?: boolean;
  pinnedLeft?: boolean;
  align?: "left" | "right";
  rules?: ConditionalRule[];
  description?: string;
  render?: (row: Row, ctx: CellCtx<Row>) => ReactNode;
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
  /** Cell-value mutation. Implementations push an undo entry themselves. When
   *  undefined, cells are read-only (no edit affordances). */
  onCommit?: (rowKey: string, field: string, value: unknown) => Promise<void>;
  /** Triggered when the user invokes the header menu's "delete column" item. */
  onDeleteColumn?: (field: string) => void;
  /** Header menu: rename label */
  onRenameColumn?: (field: string, newLabel: string) => void;
  /** Header menu: change type (with the new config). Set coerceInvalidToNull
   *  when re-trying after the host has confirmed N values would coerce to empty. */
  onChangeColumnType?: (
    field: string,
    newConfig: ColumnConfig,
    opts?: { coerceInvalidToNull?: boolean },
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
  /** Row operations triggered from the right-click context menu. */
  onInsertRow?: (rowKey: string, where: "above" | "below") => void;
  onDeleteRow?: (rowKey: string) => void;
  onDuplicateRow?: (rowKey: string) => void;
  /** Save per-column conditional formatting rules (persisted in field_config). */
  onSaveColumnRules?: (field: string, rules: ConditionalRule[]) => void;
  /** Save a plain-text description for a column (persisted in dimension_field.description). */
  onSaveColumnDescription?: (field: string, description: string | null) => void;
  /** Optional per-row activity map (rowKey → latest audit entry).
   *  When present, each row gets a left-edge pip + hover-revealed badge. */
  activity?: Map<string, RowActivityEntry>;
  /** When present, renders a CursorOverlay with peer cell highlights and
   *  invokes `presence.setCell(row, col)` on cell focus to publish self. */
  presence?: {
    peers: PeerState[];
    setCell: (row: number, col: number) => void;
  };
  /** Host hook for workbench single-key actions (A/S/R/N…). Called for keydowns
   *  the grid itself did not handle (never while editing). `startEdit` opens
   *  the editor on the cursor cell — the M-key affordance. When set, the grid's
   *  type-to-edit behavior is disabled so printable keys reach the host. */
  onCellKeyDown?: (
    e: React.KeyboardEvent,
    ctx: {
      cursor: { rowKey: string; field: string } | null;
      /** Opens the editor on the cursor cell; `seed` pre-fills the typed
       *  character so hosts can reconstruct type-to-edit selectively. */
      startEdit: (seed?: string) => void;
    },
  ) => void;
  /** Full-width detail row rendered beneath a data row when this returns
   *  non-null. The host owns which row is open (return null for the rest).
   *  Detail height is outside the virtualizer's estimates — fine for one open
   *  drill at a time. */
  renderRowDetail?: (row: Row) => ReactNode | null;
}
