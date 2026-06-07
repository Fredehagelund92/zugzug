import { useMemo } from "react";
import type { ColumnDef, ConditionalRule, RuleStyle } from "./types";

function evaluateTrigger(rule: ConditionalRule, raw: unknown): boolean {
  if (rule.trigger.kind === "is_empty")     return raw == null || raw === "";
  if (rule.trigger.kind === "is_not_empty") return raw != null && raw !== "";
  const s = raw == null ? "" : String(raw);
  switch (rule.trigger.kind) {
    case "equals":      return s === rule.trigger.value;
    case "not_equals":  return s !== rule.trigger.value;
    case "contains":    return s.includes(rule.trigger.value);
    case "starts_with": return s.startsWith(rule.trigger.value);
    case "ends_with":   return s.endsWith(rule.trigger.value);
    case "is_in":       return rule.trigger.values.includes(s);
    case "gt":          return typeof raw === "number" && raw > rule.trigger.value;
    case "lt":          return typeof raw === "number" && raw < rule.trigger.value;
    case "between":     return typeof raw === "number" && raw >= rule.trigger.min && raw <= rule.trigger.max;
  }
}

export interface RowEvaluation {
  cellStyles: Map<string, RuleStyle>; // field → style of first matching rule
  rowStripe:  string | null;          // PaletteName of first non-null stripe (L-to-R)
}

const EMPTY_EVALUATION: RowEvaluation = Object.freeze({
  cellStyles: new Map<string, RuleStyle>(),
  rowStripe: null,
}) as RowEvaluation;

export function useConditionalFormatting<Row>(
  columns: ColumnDef<Row>[],
  getValue: (row: Row, field: string) => unknown,
) {
  return useMemo(() => {
    const hasRules = columns.some((c) => c.rules && c.rules.length > 0);
    const evaluateRow = (row: Row): RowEvaluation => {
      if (!hasRules) return EMPTY_EVALUATION;
      const cellStyles = new Map<string, RuleStyle>();
      let rowStripe: string | null = null;
      for (const c of columns) {
        if (!c.rules || c.rules.length === 0) continue;
        const v = getValue(row, c.field);
        for (const r of c.rules) {
          if (evaluateTrigger(r, v)) {
            cellStyles.set(c.field, r.style);
            if (!rowStripe && r.style.rowStripe) rowStripe = r.style.rowStripe;
            break; // first match per column wins
          }
        }
      }
      return { cellStyles, rowStripe };
    };
    return { evaluateRow, hasRules };
  }, [columns, getValue]);
}
