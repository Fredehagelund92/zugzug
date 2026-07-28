import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableLines, prune } from "../../scripts/prune-lcov.ts";

const SRC = `export function f(a: number) {
  // a comment
  const q = \`SELECT x
     FROM t
     WHERE a = \${a}
     ORDER BY x\`;

  if (a > 0) {
    return q;
  }
  return "";
}
`;
// 1 export function      → statement (top level)
// 2 comment              → not
// 3 const q = \`SELECT    → statement start
// 4,5,6 template body     → continuations
// 7 blank                → not
// 8 if (a > 0) {         → statement
// 9 return q;            → statement (nested block)
// 10 }                   → not
// 11 return "";          → statement

test("only statement starts count as executable", () => {
  const lines = executableLines("f.ts", SRC);
  expect([...lines].sort((x, y) => x - y)).toEqual([1, 3, 8, 9, 11]);
});

test("comments and multi-line statement continuations are never executable", () => {
  const lines = executableLines("f.ts", SRC);
  for (const n of [2, 4, 5, 6, 7, 10]) expect(lines.has(n)).toBe(false);
});

function fixture(): { root: string; lcov: string } {
  const root = mkdtempSync(join(tmpdir(), "prune-lcov-"));
  mkdirSync(join(root, "server", "src"), { recursive: true });
  writeFileSync(join(root, "server", "src", "f.ts"), SRC);
  const lcov = [
    "TN:",
    "SF:server/src/f.ts",
    ...[1, 2, 3, 4, 5, 6, 8, 9, 11].map((n) => `DA:${n},${n === 1 || n === 3 ? 1 : 0}`),
    "LF:9",
    "LH:2",
    "end_of_record",
    "",
  ].join("\n");
  return { root, lcov };
}

test("drops non-executable DA entries and recomputes LF/LH", () => {
  const { root, lcov } = fixture();
  const out = prune(lcov, root);
  const kept = [...out.matchAll(/^DA:(\d+),/gm)].map((m) => Number(m[1]));
  expect(kept).toEqual([1, 3, 8, 9, 11]);
  expect(out).toContain("LF:5");
  expect(out).toContain("LH:2"); // lines 1 and 3 were hit
});

test("a record whose source is missing is passed through untouched", () => {
  const { root } = fixture();
  const lcov = [
    "TN:",
    "SF:server/src/gone.ts",
    "DA:1,0",
    "DA:2,0",
    "LF:2",
    "LH:0",
    "end_of_record",
    "",
  ].join("\n");
  const out = prune(lcov, root);
  expect(out).toContain("DA:1,0");
  expect(out).toContain("DA:2,0");
  expect(out).toContain("LF:2");
});
