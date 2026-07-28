/**
 * Drop non-executable lines from an lcov report.
 *
 * Bun's coverage emits a DA: entry for almost every physical line — 986 of the
 * 1143 lines in repo-drafts.ts — including comments, blank lines and the
 * continuation lines of multi-line statements. diff-cover treats every DA:
 * entry as a measurable line, so a comment no test can possibly execute counts
 * against patch coverage. On a small, well-commented diff that dominates the
 * score: PR #204 changed 13 lines, 7 of them comments and 4 of them SQL string
 * continuations, and scored 30%.
 *
 * Only the server report needs this. The app's v8 reporter already emits DA:
 * entries for executable lines only.
 *
 * Usage: bun scripts/prune-lcov.ts <lcov-file> <repo-root>
 * Records whose source file can't be read are passed through untouched, so a
 * path that fails to resolve degrades to today's behaviour rather than
 * silently dropping a file's coverage.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// `typescript` lives in the workspace (app/ or server/), not at the repo root,
// and Bun resolves bare imports from the script's own directory — so resolve it
// from the cwd the normalizer runs in instead.
const ts = createRequire(join(process.cwd(), "package.json"))(
  "typescript",
) as typeof import("typescript");

/**
 * Lines (1-based) on which a statement begins.
 *
 * Coverage is attributed per statement, so the continuation lines of a
 * multi-line statement can never be hit independently of its first line — bun
 * reports them as 0 whether or not the statement ran. Measuring statement
 * starts keeps every real branch of control flow measurable (statements nested
 * in function bodies, blocks and case clauses are statements in their own
 * right) while dropping lines that only ever record instrumentation noise.
 */
export function executableLines(fileName: string, source: string): Set<number> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const holdsStatements = (n: ts.Node) =>
    ts.isBlock(n) ||
    ts.isSourceFile(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseClause(n) ||
    ts.isDefaultClause(n);
  const visit = (node: ts.Node): void => {
    // EndOfFileToken is a child of SourceFile but is not a statement.
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    if (node.parent && holdsStatements(node.parent)) {
      lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return lines;
}

/** Rewrite an lcov body, keeping only DA: lines that can actually be executed. */
export function prune(lcov: string, root: string): string {
  const out: string[] = [];
  let keep: Set<number> | null = null;
  let found = 0;
  let hit = 0;
  const pending: string[] = [];

  const flush = () => {
    for (const line of pending) {
      if (line.startsWith("LF:")) out.push(`LF:${found}`);
      else if (line.startsWith("LH:")) out.push(`LH:${hit}`);
      else out.push(line);
    }
    pending.length = 0;
    keep = null;
    found = 0;
    hit = 0;
  };

  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const abs = join(root, line.slice(3).trim());
      keep = null;
      if (existsSync(abs) && /\.(ts|tsx|js|jsx|mts|cts)$/.test(abs)) {
        try {
          keep = executableLines(abs, readFileSync(abs, "utf8"));
        } catch {
          keep = null;
        }
      }
      pending.push(line);
      continue;
    }
    if (line.startsWith("DA:")) {
      const [numRaw, hitsRaw] = line.slice(3).split(",");
      if (keep && !keep.has(Number(numRaw))) continue; // non-executable — drop
      found++;
      if (Number(hitsRaw) > 0) hit++;
      pending.push(line);
      continue;
    }
    pending.push(line);
    if (line.startsWith("end_of_record")) flush();
  }
  flush();
  return out.join("\n");
}

if (import.meta.main) {
  const [file, root] = process.argv.slice(2);
  if (!file || !root) {
    console.error("usage: bun scripts/prune-lcov.ts <lcov-file> <repo-root>");
    process.exit(2);
  }
  writeFileSync(file, prune(readFileSync(file, "utf8"), root));
}
