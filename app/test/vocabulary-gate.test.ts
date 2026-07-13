/**
 * Exit gate: no banned vocabulary in user-facing strings of touched files.
 *
 * Strategy (two layers):
 *
 * Layer 1 — General scan of JSX text nodes and quoted string literals.
 *   Extracts text from >...< nodes (no braces) and quoted strings with spaces.
 *   Whole-word regex prevents false-positives on code identifiers
 *   (e.g. `canonicalTable`, `.raw`, import paths, object keys).
 *
 * Layer 2 — Targeted assertions on the SPECIFIC leaks fixed in this wave.
 *   Some banned strings live inside JSX template expressions (e.g.
 *   `{expr} raw` or backtick templates with ${} interpolations) that the
 *   general JSX-text scanner cannot extract cleanly. For those, we assert
 *   the exact old strings are absent from the file. This is explicit,
 *   false-positive-free, and documents exactly what was fixed.
 *
 * The BANNED list mirrors CLAUDE.md §Vocabulary:
 *   canonical, raw, triage, master, golden, commit, sync, tenant, matching
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(__dirname, "../../");

const FILES = [
  "app/src/components/TablePane.tsx",
  "app/src/routes/settings/Warehouse.tsx",
];

const BANNED = ["canonical", "raw", "triage", "master", "golden", "commit", "sync", "tenant", "matching"];

/**
 * Extract candidate user-facing strings from source text.
 * Returns an array of { text, lineNo } objects.
 *
 * Targets:
 *   - JSX text nodes: content between > and < with no { } (expression-free segments)
 *   - Double/single-quoted strings that contain at least one space (sentence-like copy)
 *
 * Skips: import lines, type/interface declarations, comment lines.
 */
function extractUserFacingStrings(source: string): Array<{ text: string; lineNo: number }> {
  const results: Array<{ text: string; lineNo: number }> = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const trimmed = line.trim();
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("type ") ||
      trimmed.startsWith("interface ") ||
      trimmed.startsWith("export type ") ||
      trimmed.startsWith("export interface ")
    ) {
      continue;
    }

    // 1. JSX text nodes: content between > and < with no JSX expression braces
    const jsxTextRegex = />([^<>{}]+)</g;
    let m: RegExpExecArray | null;
    while ((m = jsxTextRegex.exec(line)) !== null) {
      const text = m[1]!.trim();
      if (text.length > 0 && /[a-zA-Z]/.test(text)) {
        results.push({ text, lineNo });
      }
    }

    // 2. Double-quoted strings with at least one space (sentence-like copy)
    const dqRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    while ((m = dqRegex.exec(line)) !== null) {
      const text = m[1]!;
      if (text.includes(" ") && /[a-zA-Z]/.test(text)) {
        results.push({ text, lineNo });
      }
    }

    // 3. Single-quoted strings with at least one space
    const sqRegex = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
    while ((m = sqRegex.exec(line)) !== null) {
      const text = m[1]!;
      if (text.includes(" ") && /[a-zA-Z]/.test(text)) {
        results.push({ text, lineNo });
      }
    }
  }

  return results;
}

describe("vocabulary gate", () => {
  test("no banned vocabulary in user-facing strings of touched files (general scan)", () => {
    const violations: string[] = [];

    for (const relPath of FILES) {
      const absPath = join(REPO_ROOT, relPath);
      const source = readFileSync(absPath, "utf8");
      const candidates = extractUserFacingStrings(source);

      for (const { text, lineNo } of candidates) {
        for (const banned of BANNED) {
          const wordBoundaryRegex = new RegExp(`\\b${banned}\\b`, "i");
          if (wordBoundaryRegex.test(text)) {
            violations.push(`${relPath}:${lineNo} — banned word "${banned}" in: ${JSON.stringify(text)}`);
          }
        }
      }
    }

    expect(violations, violations.join("\n")).toHaveLength(0);
  });

  // Layer 2: targeted assertions for leaks that live inside JSX template
  // expressions or backtick strings (not caught by the JSX-text scanner).
  // These assert the EXACT old strings are absent from the file.
  test("specific banned strings from this wave are not present in TablePane.tsx", () => {
    const absPath = join(REPO_ROOT, "app/src/components/TablePane.tsx");
    const source = readFileSync(absPath, "utf8");

    // "{n} raw" stat label → should now say "source values"
    expect(source, 'JSX stat label still says "raw" — expected "source values"').not.toContain(
      "} raw</span>"
    );

    // Flash message after merge used "raw values re-pointed" — guard both plural and
    // singular forms so a "1 raw value" regression in a template string is caught too.
    expect(source, 'Flash message still contains "raw values"').not.toContain("raw values");
    expect(source, 'Copy still contains the singular "raw value"').not.toContain("raw value");

    // ComboSelect placeholder used "pick survivor…"
    expect(source, 'ComboSelect placeholder still says "pick survivor…"').not.toContain(
      '"pick survivor…"'
    );

    // Dev counter "next position: {dim.nextPosition}" should be deleted
    expect(source, '"next position:" dev counter still visible in UI').not.toContain(
      "next position:"
    );
  });

  test("specific banned strings from this wave are not present in Warehouse.tsx", () => {
    const absPath = join(REPO_ROOT, "app/src/routes/settings/Warehouse.tsx");
    const source = readFileSync(absPath, "utf8");

    // "master records live where…"
    expect(source, 'Warehouse hint still contains "master records"').not.toContain("master records");

    // "new values that need a master record"
    expect(source, 'Warehouse copy still contains "master record"').not.toContain("master record");
  });
});
