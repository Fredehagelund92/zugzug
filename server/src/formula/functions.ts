/* functions.ts — the lean-core function registry and shared coercion helpers.

   Only *strict* (eagerly-evaluated) functions live here. The control-flow
   functions IF / AND / OR / COALESCE short-circuit and are handled in
   evaluate.ts so an untaken branch can't raise a spurious error. */

export type FormulaValue = string | number | boolean | null;

export interface FormulaError {
  readonly __formulaError: true;
  message: string;
}

export function formulaError(message: string): FormulaError {
  return { __formulaError: true, message };
}

export function isFormulaError(v: unknown): v is FormulaError {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __formulaError?: unknown }).__formulaError === true
  );
}

/** Coerce to a finite number, or undefined if not numeric (null, boolean,
 *  non-numeric string all yield undefined — callers decide null vs error). */
export function asNumber(v: FormulaValue): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Coerce to string for text functions; null → "" so CONCAT skips blanks. */
export function toStr(v: FormulaValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/** Coerce to boolean for logical context; null → false, non-boolean → error. */
export function toBool(v: FormulaValue): boolean | FormulaError {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  return formulaError("Expected a true/false value.");
}

interface StrictFn {
  min: number;
  max: number; // Infinity for variadic
  impl: (args: FormulaValue[]) => FormulaValue | FormulaError;
}

export const STRICT_FUNCTIONS: Record<string, StrictFn> = {
  NOT: {
    min: 1,
    max: 1,
    impl: ([a]) => {
      const b = toBool(a);
      return isFormulaError(b) ? b : !b;
    },
  },
  CONCAT: {
    min: 1,
    max: Infinity,
    impl: (args) => args.map(toStr).join(""),
  },
  UPPER: { min: 1, max: 1, impl: ([a]) => toStr(a).toUpperCase() },
  LOWER: { min: 1, max: 1, impl: ([a]) => toStr(a).toLowerCase() },
  TRIM: { min: 1, max: 1, impl: ([a]) => toStr(a).trim() },
  ISBLANK: { min: 1, max: 1, impl: ([a]) => a === null || a === "" },
  ABS: {
    min: 1,
    max: 1,
    impl: ([a]) => {
      const n = asNumber(a);
      return n === undefined ? formulaError("ABS needs a number.") : Math.abs(n);
    },
  },
  ROUND: {
    min: 1,
    max: 2,
    impl: ([a, digitsArg]) => {
      const n = asNumber(a);
      if (n === undefined) return formulaError("ROUND needs a number.");
      const d = digitsArg === undefined ? 0 : asNumber(digitsArg);
      if (d === undefined) return formulaError("ROUND digits must be a number.");
      const f = Math.pow(10, Math.trunc(d));
      return Math.round(n * f) / f;
    },
  },
};

/** Function names the parser/validator should recognize (strict + control-flow). */
export const KNOWN_FUNCTIONS = new Set<string>([
  ...Object.keys(STRICT_FUNCTIONS),
  "IF",
  "AND",
  "OR",
  "COALESCE",
]);
