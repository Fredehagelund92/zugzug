/* index.ts — public surface of the formula engine.

   The engine is the single source of truth for computed-column values: the
   read path (getRefTable) and the publish path (writeVersionSnapshot) both
   evaluate through here, so the grid, the Pull API, and dbt always agree. */

import { collectFieldRefs, FormulaSyntaxError, parseFormula, type Node } from "./parse.ts";
import { evaluate } from "./evaluate.ts";
import {
  asNumber,
  formulaError,
  isFormulaError,
  KNOWN_FUNCTIONS,
  toBool,
  toStr,
  type FormulaError,
  type FormulaValue,
} from "./functions.ts";

export { parseFormula, collectFieldRefs, FormulaSyntaxError } from "./parse.ts";
export type { Node } from "./parse.ts";
export { evaluate } from "./evaluate.ts";
export { isFormulaError };
export type { FormulaValue, FormulaError };

export type ResultType = "text" | "number" | "boolean";

/** A parsed formula plus the function names it calls — cache once per column. */
export interface CompiledFormula {
  ast: Node;
}

/** Parse-and-evaluate in one shot. Row is keyed by field label. Syntax errors
 *  come back as a FormulaError value (not a throw), so callers stay uniform. */
export function runFormula(
  expr: string,
  row: Record<string, unknown>,
): FormulaValue | FormulaError {
  let ast: Node;
  try {
    ast = parseFormula(expr);
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return formulaError(e.message);
    throw e;
  }
  return evaluate(ast, row);
}

/** Coerce a raw result into the column's declared output type for storage /
 *  rendering. null stays null; a bad shape becomes a FormulaError. */
export function coerceToResultType(
  v: FormulaValue | FormulaError,
  resultType: ResultType,
): FormulaValue | FormulaError {
  if (isFormulaError(v)) return v;
  if (v === null) return null;
  if (resultType === "text") return toStr(v);
  if (resultType === "number") {
    const n = asNumber(v);
    return n === undefined ? formulaError("Formula result is not a number.") : n;
  }
  const b = toBool(v);
  return isFormulaError(b) ? formulaError("Formula result is not true/false.") : b;
}

export interface FormulaValidation {
  ok: boolean;
  /** Human-readable reason when !ok (syntax, unknown function, or unknown field). */
  error?: string;
  /** Field labels referenced by the formula (present even when ok). */
  fieldRefs?: string[];
}

/** Static-check a formula for save time and the validate endpoint: syntax,
 *  known functions, and (optionally) that every referenced field exists. */
export function validateFormula(expr: string, knownFieldLabels?: Set<string>): FormulaValidation {
  let ast: Node;
  try {
    ast = parseFormula(expr);
  } catch (e) {
    return { ok: false, error: e instanceof FormulaSyntaxError ? e.message : "Invalid formula." };
  }
  const unknownFn = findUnknownFunction(ast);
  if (unknownFn) return { ok: false, error: `Unknown function "${unknownFn}".` };

  const fieldRefs = collectFieldRefs(ast);
  if (knownFieldLabels) {
    const missing = fieldRefs.find((f) => !knownFieldLabels.has(f));
    if (missing) return { ok: false, error: `Unknown field "${missing}".`, fieldRefs };
  }
  return { ok: true, fieldRefs };
}

function findUnknownFunction(node: Node): string | null {
  if (node.kind === "call") {
    if (!KNOWN_FUNCTIONS.has(node.name)) return node.name;
    for (const a of node.args) {
      const u = findUnknownFunction(a);
      if (u) return u;
    }
  } else if (node.kind === "binary") {
    return findUnknownFunction(node.left) ?? findUnknownFunction(node.right);
  } else if (node.kind === "unary") {
    return findUnknownFunction(node.arg);
  }
  return null;
}
