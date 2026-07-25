/* evaluate.ts — walks a parsed AST against one row's field values.

   Field values arrive keyed by field *label* (the same string the author
   typed). Anything missing/undefined is treated as blank (null). Operators
   and control-flow functions are handled here; strict functions dispatch to
   the registry in functions.ts. Evaluation never throws — every failure is a
   FormulaError value that callers surface as a per-cell "can't calculate". */

import type { BinOp, Node } from "./parse.ts";
import {
  asNumber,
  formulaError,
  isFormulaError,
  STRICT_FUNCTIONS,
  toBool,
  toStr,
  type FormulaError,
  type FormulaValue,
} from "./functions.ts";

export type { FormulaValue, FormulaError };
export { isFormulaError };

export type Row = Record<string, unknown>;

function normalize(raw: unknown): FormulaValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" || typeof raw === "boolean") return raw;
  return String(raw); // dates and other scalars → string
}

function equals(l: FormulaValue, r: FormulaValue): boolean {
  if (l === null && r === null) return true;
  if (l === null || r === null) return false;
  const a = asNumber(l);
  const b = asNumber(r);
  if (a !== undefined && b !== undefined) return a === b;
  return toStr(l) === toStr(r);
}

function applyBinary(op: BinOp, l: FormulaValue, r: FormulaValue): FormulaValue | FormulaError {
  switch (op) {
    case "=":
      return equals(l, r);
    case "!=":
      return !equals(l, r);
    case "+":
    case "-":
    case "*":
    case "/": {
      if (l === null || r === null) return null; // blank propagates
      const a = asNumber(l);
      const b = asNumber(r);
      if (a === undefined || b === undefined) return formulaError(`"${op}" needs numbers.`);
      if (op === "+") return a + b;
      if (op === "-") return a - b;
      if (op === "*") return a * b;
      if (b === 0) return formulaError("Division by zero.");
      return a / b;
    }
    case "<":
    case ">":
    case "<=":
    case ">=": {
      if (l === null || r === null) return null;
      const a = asNumber(l);
      const b = asNumber(r);
      if (a === undefined || b === undefined) return formulaError(`"${op}" needs numbers.`);
      if (op === "<") return a < b;
      if (op === ">") return a > b;
      if (op === "<=") return a <= b;
      return a >= b;
    }
  }
}

export function evaluate(node: Node, row: Row): FormulaValue | FormulaError {
  switch (node.kind) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "bool":
      return node.value;
    case "field":
      return normalize(row[node.name]);
    case "unary": {
      const v = evaluate(node.arg, row);
      if (isFormulaError(v)) return v;
      if (v === null) return null;
      const n = asNumber(v);
      return n === undefined ? formulaError("Unary minus needs a number.") : -n;
    }
    case "binary": {
      const l = evaluate(node.left, row);
      if (isFormulaError(l)) return l;
      const r = evaluate(node.right, row);
      if (isFormulaError(r)) return r;
      return applyBinary(node.op, l, r);
    }
    case "call":
      return evalCall(node.name, node.args, row);
  }
}

function evalCall(name: string, args: Node[], row: Row): FormulaValue | FormulaError {
  // Control-flow functions short-circuit, so they take raw arg nodes.
  switch (name) {
    case "IF": {
      if (args.length !== 3) return formulaError("IF takes 3 arguments: IF(test, then, else).");
      const cond = evaluate(args[0], row);
      if (isFormulaError(cond)) return cond;
      const b = toBool(cond);
      if (isFormulaError(b)) return formulaError("IF needs a true/false test.");
      return evaluate(b ? args[1] : args[2], row);
    }
    case "AND":
    case "OR": {
      if (args.length < 1) return formulaError(`${name} needs at least one argument.`);
      for (const arg of args) {
        const v = evaluate(arg, row);
        if (isFormulaError(v)) return v;
        const b = toBool(v);
        if (isFormulaError(b)) return b;
        if (name === "AND" && !b) return false;
        if (name === "OR" && b) return true;
      }
      return name === "AND";
    }
    case "COALESCE": {
      if (args.length < 1) return formulaError("COALESCE needs at least one argument.");
      for (const arg of args) {
        const v = evaluate(arg, row);
        if (isFormulaError(v)) return v;
        if (v !== null) return v;
      }
      return null;
    }
  }

  const fn = STRICT_FUNCTIONS[name];
  if (!fn) return formulaError(`Unknown function "${name}".`);
  if (args.length < fn.min || args.length > fn.max) {
    return formulaError(`${name} got the wrong number of arguments.`);
  }
  const values: FormulaValue[] = [];
  for (const arg of args) {
    const v = evaluate(arg, row);
    if (isFormulaError(v)) return v;
    values.push(v);
  }
  return fn.impl(values);
}
