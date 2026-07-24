import type { ColumnDef } from "../datagrid/types";
import type { RecordValue, FieldDef } from "../../data";

export interface TargetMeta {
  /** Map from target field name → display label. */
  fieldLabels: Map<string, string>;
  /** Set of fields that currently exist on the target dimension. */
  fieldExists: Set<string>;
  /** Candidates for the FK cell editor. */
  candidates: { key: string; label: string }[];
}

/** Synthesize the FK ColumnDef + one read-only lookup ColumnDef per non-label
 *  entry in `field.displayFields`. Pure — no React, no store access. */
export function buildLinkedColumns(field: FieldDef, target: TargetMeta): ColumnDef<RecordValue>[] {
  const displayFields = field.displayFields ?? ["label"];
  const targetDimId = field.referencedDimId ?? "";

  const fkCol: ColumnDef<RecordValue> = {
    field: field.field,
    label: field.label,
    config: {
      type: "linked",
      targetDimId,
      displayFields,
      candidates: target.candidates,
    },
    description: field.description,
    rules: field.rules,
    columnKind: "fk",
  };

  const lookupCols: ColumnDef<RecordValue>[] = displayFields
    .filter((df) => df !== "label")
    .map((df) => {
      const exists = target.fieldExists.has(df);
      const targetLabel = exists ? (target.fieldLabels.get(df) ?? df) : df;
      return {
        field: `${field.field}__${df}`,
        label: `${field.label} › ${targetLabel}`,
        config: { type: "text" } as const,
        editable: false,
        columnKind: "lookup",
        sourceField: field.field,
        linkedStale: !exists,
      };
    });

  return [fkCol, ...lookupCols];
}
