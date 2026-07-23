import type { ColumnConfig } from "./types";

const isEmpty = (v: unknown) => v == null || String(v).trim() === "";

/** Range/uniqueness check for a single edited value. Returns a plain-language
 *  reason, or null when the value is acceptable. Does not check `required` —
 *  emptiness is completeness, caught at the publish gate. */
export function valueShapeError(
  config: ColumnConfig,
  value: unknown,
  rowKey: string,
  others: Array<{ key: string; value: unknown }>,
): string | null {
  const v = config.validation;
  if (isEmpty(value)) return null; // empty is never a shape/uniqueness violation
  const raw = String(value).trim();

  if (config.type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) return "Enter a number.";
    if (v?.min != null && n < Number(v.min)) return `Must be ${v.min} or more.`;
    if (v?.max != null && n > Number(v.max)) return `Must be ${v.max} or less.`;
  }
  if (config.type === "date") {
    if (v?.min != null && raw < String(v.min)) return `Must be on or after ${v.min}.`;
    if (v?.max != null && raw > String(v.max)) return `Must be on or before ${v.max}.`;
  }
  if (config.type === "text") {
    if (v?.min != null && raw.length < Number(v.min))
      return `Must be at least ${v.min} characters.`;
    if (v?.max != null && raw.length > Number(v.max))
      return `Must be ${v.max} characters or fewer.`;
  }
  if (v?.unique) {
    const clash = others.find(
      (o) =>
        o.key !== rowKey &&
        !isEmpty(o.value) &&
        String(o.value).toLowerCase() === raw.toLowerCase(),
    );
    if (clash) return `Already used by ${clash.key}.`;
  }
  return null;
}

export function columnBadges(config: ColumnConfig): Array<"REQ" | "UNIQ" | "RANGE"> {
  const out: Array<"REQ" | "UNIQ" | "RANGE"> = [];
  if (config.required) out.push("REQ");
  if (config.validation?.unique) out.push("UNIQ");
  if (config.validation?.min != null || config.validation?.max != null) out.push("RANGE");
  return out;
}
