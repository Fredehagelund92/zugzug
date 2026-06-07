/* conditional-format-types.ts — server-side copy of the conditional rule
 * union type. Kept separate from repo-shared.ts so there are no React/Tailwind
 * dependencies. Style values use plain strings instead of PaletteName. */

export interface RuleStyle {
  cellBg?:    string;
  textColor?: string;
  rowStripe?: string;
}

export type ConditionalRule =
  | { id: string; field: string; trigger: { kind: "equals" | "not_equals" | "contains" | "starts_with" | "ends_with"; value: string }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_empty" | "is_not_empty" }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "is_in"; values: string[] }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "gt" | "lt"; value: number }; style: RuleStyle }
  | { id: string; field: string; trigger: { kind: "between"; min: number; max: number }; style: RuleStyle };
