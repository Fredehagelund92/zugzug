/* Exit gate for the wire vocabulary (ADR-0006).
 *
 * The Pull API and webhook payloads used to carry `dim_slug` / `dim_label`,
 * and one route answered `DIMENSION_NOT_FOUND`. Those are an external contract
 * — cheap to rename before launch, permanent afterwards — so they became
 * `table_slug` / `table_label` / `TABLE_NOT_FOUND`. This keeps them gone.
 *
 * The dbt-facing `dim_<x>` / `map_<x>` output tables and their `dim_table` /
 * `map_table` columns are ADR-0006 survivors and are NOT what this scans for:
 * the patterns below are the wire keys and the error code, not the prefix. */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const ROOTS = ["server/src", "server/test", "app/src", "app/test", "docs-site/content"];
const EXTS = [".ts", ".tsx", ".md", ".mdx"];
const BANNED = [/\bdim_slug\b/, /\bdim_label\b/, /\bDIMENSION_/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

describe("wire vocabulary", () => {
  it("no dim_slug / dim_label / DIMENSION_ anywhere in source or docs", () => {
    const hits: string[] = [];
    for (const rootDir of ROOTS) {
      for (const file of walk(join(ROOT, rootDir))) {
        if (file === import.meta.path) continue; // this gate names them to ban them
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (BANNED.some((re) => re.test(line))) {
            hits.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
