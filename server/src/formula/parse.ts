/* parse.ts — tokenizer + recursive-descent parser for the formula language.
   Grammar (highest precedence first):

     comparison := additive ( (= | != | < | > | <= | >=) additive )*
     additive   := multiplicative ( (+ | -) multiplicative )*
     multiplic. := unary ( (* | /) unary )*
     unary      := '-' unary | primary
     primary    := number | string | TRUE | FALSE | field | call | '(' comparison ')'
     field      := identifier | '[' ...label... ']'
     call       := identifier '(' ( comparison (',' comparison)* )? ')'

   Logical/text/number operations (IF, AND, OR, NOT, CONCAT, …) are function
   calls, not operators — see functions.ts. The parser is pure: no field or
   function existence is checked here (that is validation's job). */

export type BinOp = "+" | "-" | "*" | "/" | "=" | "!=" | "<" | ">" | "<=" | ">=";

export type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "field"; name: string }
  | { kind: "unary"; op: "-"; arg: Node }
  | { kind: "binary"; op: BinOp; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

export class FormulaSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaSyntaxError";
  }
}

type Tok =
  | { t: "num"; value: number }
  | { t: "str"; value: string }
  | { t: "ident"; value: string } // bare identifier or bracketed label
  | { t: "op"; value: BinOp }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ t: "comma" });
      i++;
      continue;
    }
    // two-char operators first
    const two = src.slice(i, i + 2);
    if (two === "!=" || two === "<=" || two === ">=") {
      toks.push({ t: "op", value: two as BinOp });
      i += 2;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "=" || c === "<" || c === ">") {
      toks.push({ t: "op", value: c as BinOp });
      i++;
      continue;
    }
    if (c === '"') {
      // double-quoted string; \" and \\ escapes supported
      let s = "";
      i++;
      let closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "\\" && i + 1 < n) {
          const next = src[i + 1];
          s += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        s += ch;
        i++;
      }
      if (!closed) throw new FormulaSyntaxError("Unterminated text value (missing closing quote).");
      toks.push({ t: "str", value: s });
      continue;
    }
    if (c === "[") {
      // bracketed field label (may contain spaces); no nesting
      let s = "";
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === "]") {
          closed = true;
          i++;
          break;
        }
        s += src[i];
        i++;
      }
      if (!closed) throw new FormulaSyntaxError("Unclosed field reference (missing ']').");
      const label = s.trim();
      if (!label) throw new FormulaSyntaxError("Empty field reference '[]'.");
      toks.push({ t: "ident", value: label });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let s = "";
      while (i < n && /[0-9.]/.test(src[i])) {
        s += src[i];
        i++;
      }
      const value = Number(s);
      if (!Number.isFinite(value)) throw new FormulaSyntaxError(`Invalid number "${s}".`);
      toks.push({ t: "num", value });
      continue;
    }
    if (isIdentStart(c)) {
      let s = "";
      while (i < n && isIdent(src[i])) {
        s += src[i];
        i++;
      }
      toks.push({ t: "ident", value: s });
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character "${c}".`);
  }
  return toks;
}

/** Parse an expression into an AST. Throws FormulaSyntaxError on malformed input. */
export function parseFormula(expr: string): Node {
  const toks = tokenize(expr);
  if (toks.length === 0) throw new FormulaSyntaxError("Formula is empty.");
  let pos = 0;

  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => {
    const tok = toks[pos];
    if (!tok) throw new FormulaSyntaxError("Unexpected end of formula.");
    pos++;
    return tok;
  };
  const expect = (t: Tok["t"], msg: string) => {
    const tok = peek();
    if (!tok || tok.t !== t) throw new FormulaSyntaxError(msg);
    return next();
  };

  const COMPARE: BinOp[] = ["=", "!=", "<", ">", "<=", ">="];

  function parseComparison(): Node {
    let left = parseAdditive();
    while (peek()?.t === "op" && COMPARE.includes((peek() as { value: BinOp }).value)) {
      const op = (next() as { value: BinOp }).value;
      const right = parseAdditive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parseAdditive(): Node {
    let left = parseMultiplicative();
    while (peek()?.t === "op" && ["+", "-"].includes((peek() as { value: BinOp }).value)) {
      const op = (next() as { value: BinOp }).value;
      const right = parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parseMultiplicative(): Node {
    let left = parseUnary();
    while (peek()?.t === "op" && ["*", "/"].includes((peek() as { value: BinOp }).value)) {
      const op = (next() as { value: BinOp }).value;
      const right = parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  function parseUnary(): Node {
    const tok = peek();
    if (tok?.t === "op" && tok.value === "-") {
      next();
      return { kind: "unary", op: "-", arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const tok = next();
    if (tok.t === "num") return { kind: "num", value: tok.value };
    if (tok.t === "str") return { kind: "str", value: tok.value };
    if (tok.t === "lparen") {
      const inner = parseComparison();
      expect("rparen", "Missing ')'.");
      return inner;
    }
    if (tok.t === "ident") {
      const upper = tok.value.toUpperCase();
      if (upper === "TRUE") return { kind: "bool", value: true };
      if (upper === "FALSE") return { kind: "bool", value: false };
      if (peek()?.t === "lparen") {
        next(); // consume '('
        const args: Node[] = [];
        if (peek()?.t !== "rparen") {
          args.push(parseComparison());
          while (peek()?.t === "comma") {
            next();
            args.push(parseComparison());
          }
        }
        expect("rparen", `Missing ')' after ${tok.value}(…).`);
        return { kind: "call", name: upper, args };
      }
      return { kind: "field", name: tok.value };
    }
    throw new FormulaSyntaxError("Unexpected token in formula.");
  }

  const ast = parseComparison();
  if (pos !== toks.length) throw new FormulaSyntaxError("Unexpected extra input after formula.");
  return ast;
}

/** All distinct field labels referenced by the AST (for save-time validation). */
export function collectFieldRefs(node: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    switch (n.kind) {
      case "field":
        out.add(n.name);
        break;
      case "unary":
        walk(n.arg);
        break;
      case "binary":
        walk(n.left);
        walk(n.right);
        break;
      case "call":
        n.args.forEach(walk);
        break;
    }
  };
  walk(node);
  return [...out];
}
