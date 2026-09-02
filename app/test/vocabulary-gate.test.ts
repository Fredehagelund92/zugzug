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
  "app/src/components/datagrid/ShortcutsOverlay.tsx",
  "app/src/components/CreateTableModal.tsx",
  "app/src/routes/Dashboard.tsx",
  "app/src/routes/Sources.tsx",
  "app/src/components/warehouse/RemoveDatabaseConfirm.tsx",
  "app/src/routes/settings/Matching.tsx",
  "app/src/components/warehouse/AddDatabaseDialog.tsx",
  "app/src/components/warehouse/DatabaseTable.tsx",
  "app/src/components/catalog/CatalogSearchResults.tsx",
  "app/src/routes/integrations/PullApi.tsx",
  "app/src/routes/integrations/CreateWebhookModal.tsx",
];

const BANNED = [
  "canonical",
  "raw",
  "triage",
  "master",
  "golden",
  "commit",
  "sync",
  "tenant",
  "matching",
];

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
            violations.push(
              `${relPath}:${lineNo} — banned word "${banned}" in: ${JSON.stringify(text)}`,
            );
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
      "} raw</span>",
    );

    // Flash message after merge used "raw values re-pointed" — guard both plural and
    // singular forms so a "1 raw value" regression in a template string is caught too.
    expect(source, 'Flash message still contains "raw values"').not.toContain("raw values");
    expect(source, 'Copy still contains the singular "raw value"').not.toContain("raw value");

    // ComboSelect placeholder used "pick survivor…"
    expect(source, 'ComboSelect placeholder still says "pick survivor…"').not.toContain(
      '"pick survivor…"',
    );

    // Dev counter "next position: {refTable.nextPosition}" should be deleted
    expect(source, '"next position:" dev counter still visible in UI').not.toContain(
      "next position:",
    );
  });

  test("specific banned strings from this wave are not present in Warehouse.tsx", () => {
    const absPath = join(REPO_ROOT, "app/src/routes/settings/Warehouse.tsx");
    const source = readFileSync(absPath, "utf8");

    // "master records live where…"
    expect(source, 'Warehouse hint still contains "master records"').not.toContain(
      "master records",
    );

    // "new values that need a master record"
    expect(source, 'Warehouse copy still contains "master record"').not.toContain("master record");
  });

  // Layer 2 targeted assertions for ShortcutsOverlay.tsx and CreateTableModal.tsx.
  // These files contain code identifiers with banned substrings (e.g. `use-tenant-navigate`
  // import, `onCommit` prop, `canonicalTable` type names in store) — the import-line skip
  // in Layer 1 handles `tenant`; `commit` in onCommit prop names never appears in a
  // quoted string with spaces so won't be caught. These Layer-2 checks assert the exact
  // old user-facing strings are gone.
  test("specific banned strings from this wave are not present in ShortcutsOverlay.tsx", () => {
    const absPath = join(REPO_ROOT, "app/src/components/datagrid/ShortcutsOverlay.tsx");
    const source = readFileSync(absPath, "utf8");

    // "pick master record" shortcut label → should now say "choose the record to keep"
    expect(source, 'ShortcutsOverlay still contains "pick master record"').not.toContain(
      "pick master record",
    );

    // "edit / commit + down" and "commit + edit →/←" shortcut labels → reworded to "confirm"
    expect(source, 'ShortcutsOverlay shortcut still says "commit + down"').not.toContain(
      "commit + down",
    );
    expect(source, 'ShortcutsOverlay shortcut still says "commit + edit"').not.toContain(
      "commit + edit",
    );
  });

  test("warehouse + catalog copy calls each thing by its defined name", () => {
    const dialog = readFileSync(
      join(REPO_ROOT, "app/src/components/warehouse/AddDatabaseDialog.tsx"),
      "utf8",
    );
    expect(dialog, 'label placeholder still surfaces "raw"').not.toContain("Production raw");

    // A registered warehouse COLUMN is a "source"; a "source value" is the
    // distinct string scanned out of one. The database row counts the former.
    const table = readFileSync(
      join(REPO_ROOT, "app/src/components/warehouse/DatabaseTable.tsx"),
      "utf8",
    );
    expect(table, 'database row still labels sources as "source value"').not.toContain(
      "source value",
    );

    // A per-database search that failed is a database, not a "source".
    const results = readFileSync(
      join(REPO_ROOT, "app/src/components/catalog/CatalogSearchResults.tsx"),
      "utf8",
    );
    expect(results, 'failed-search banner still calls databases "sources"').not.toContain(
      "source{failedCount",
    );
  });

  // The pull API and webhook pages describe what a consumer does with the data;
  // they used the implementation's word for it.
  test("integration copy avoids banned vocabulary", () => {
    const pull = readFileSync(join(REPO_ROOT, "app/src/routes/integrations/PullApi.tsx"), "utf8");
    expect(pull, 'pull API blurb still says "sync into dbt"').not.toContain("sync into");
    expect(pull, 'section heading still says "incremental sync"').not.toContain("incremental sync");
    expect(pull, 'cursor paragraph still says "resync"').not.toContain("resync");

    const webhook = readFileSync(
      join(REPO_ROOT, "app/src/routes/integrations/CreateWebhookModal.tsx"),
      "utf8",
    );
    expect(webhook, 'description placeholder still says "Sync into…"').not.toContain("Sync into");
  });

  // audit-format.tsx is deliberately absent from the general scan: its map KEYS
  // are the server's own action codes ("Warehouse synced"), which must stay
  // verbatim to match rows already in audit_log. What those codes RENDER as is
  // gated by audit-history-vocabulary.test.tsx and audit-action-label.test.ts.

  test("Dashboard intro avoids weak 'messy' copy", () => {
    const source = readFileSync(join(REPO_ROOT, "app/src/routes/Dashboard.tsx"), "utf8");
    expect(source, 'Dashboard still says "messy"').not.toContain("messy");
  });

  test("specific banned strings from this wave are not present in CreateTableModal.tsx", () => {
    const absPath = join(REPO_ROOT, "app/src/components/CreateTableModal.tsx");
    const source = readFileSync(absPath, "utf8");

    // "each becomes one canonical record" → should now say "each becomes one record"
    expect(source, 'CreateTableModal still contains "canonical record"').not.toContain(
      "canonical record",
    );

    // "after first sync" → should now say "after the first scan"
    // Note: "sync" appears in `use-tenant-navigate` import (skipped by Layer 1 import filter)
    // and may appear in function/variable identifiers — this assertion targets only the
    // user-facing helper string.
    expect(source, 'CreateTableModal helper text still says "after first sync"').not.toContain(
      "after first sync",
    );
  });

  test("Remove-database dialog avoids banned vocabulary", () => {
    const source = readFileSync(
      join(REPO_ROOT, "app/src/components/warehouse/RemoveDatabaseConfirm.tsx"),
      "utf8",
    );
    expect(source, 'still says "reference_table" in user copy').not.toContain("refTable\n");
    expect(source, 'still says "Canonical values"').not.toContain("Canonical values");
  });
});
