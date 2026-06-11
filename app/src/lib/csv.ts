/* Quote-aware CSV parsing + header mapping for master-table import. */

import type { FieldDef } from "../data";

/** RFC-4180-ish parser: handles quoted cells, escaped quotes, CR/LF/CRLF.
 *  Returns rows of cells; skips fully-empty trailing lines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface CsvMapping {
  /** column index holding the record label, or -1 if absent */
  labelIdx: number;
  /** column index holding the stable key, or -1 if absent */
  keyIdx: number;
  /** field id → column index */
  fieldIdx: Record<string, number>;
  /** headers that matched nothing and will be ignored */
  ignored: string[];
}

/** Auto-map CSV headers (case-insensitive) onto a dimension's shape:
 *  "key"/keyCol → key, "label"/"record"/dimension name → label, field
 *  labels or ids → that field. Round-trips this app's own CSV export. */
export function mapCsvHeaders(
  headers: string[],
  opts: { keyCol: string; dimension: string; fields: FieldDef[] },
): CsvMapping {
  const norm = (s: string) => s.trim().toLowerCase();
  const byField = new Map<string, string>();
  for (const f of opts.fields) {
    byField.set(norm(f.label), f.field);
    byField.set(norm(f.field), f.field);
  }
  const mapping: CsvMapping = { labelIdx: -1, keyIdx: -1, fieldIdx: {}, ignored: [] };
  headers.forEach((h, i) => {
    const n = norm(h);
    if (mapping.keyIdx === -1 && (n === "key" || n === norm(opts.keyCol))) {
      mapping.keyIdx = i;
    } else if (
      mapping.labelIdx === -1 &&
      (n === "label" || n === "record" || n === "name" || n === norm(opts.dimension))
    ) {
      mapping.labelIdx = i;
    } else if (byField.has(n) && !(byField.get(n)! in mapping.fieldIdx)) {
      mapping.fieldIdx[byField.get(n)!] = i;
    } else {
      mapping.ignored.push(h);
    }
  });
  return mapping;
}

export interface ParsedImport {
  rows: Array<{ key?: string; label?: string; fields?: Record<string, string | null> }>;
  mapping: CsvMapping;
  /** human summary lines for the confirm dialog */
  summary: string[];
}

/** Parse + map a CSV file's text against a dimension. Throws Error with a
 *  user-facing message when the file can't be imported. */
export function prepareImport(
  text: string,
  opts: { keyCol: string; dimension: string; fields: FieldDef[] },
): ParsedImport {
  const grid = parseCsv(text);
  if (grid.length < 2) throw new Error("CSV needs a header row and at least one data row.");
  const headers = grid[0]!;
  const mapping = mapCsvHeaders(headers, opts);
  if (mapping.labelIdx === -1 && mapping.keyIdx === -1) {
    throw new Error(
      `No "label" or "key" column found. Headers seen: ${headers.join(", ")}`,
    );
  }
  const rows = grid.slice(1).map((cells) => {
    const fields: Record<string, string | null> = {};
    for (const [f, idx] of Object.entries(mapping.fieldIdx)) {
      const v = cells[idx]?.trim() ?? "";
      fields[f] = v === "" ? null : v;
    }
    return {
      key: mapping.keyIdx >= 0 ? cells[mapping.keyIdx]?.trim() || undefined : undefined,
      label: mapping.labelIdx >= 0 ? cells[mapping.labelIdx]?.trim() || undefined : undefined,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
    };
  });
  const summary = [
    `${rows.length} data row${rows.length === 1 ? "" : "s"}`,
    mapping.keyIdx >= 0 ? `key ← "${headers[mapping.keyIdx]}"` : "key ← derived from label",
    mapping.labelIdx >= 0 ? `label ← "${headers[mapping.labelIdx]}"` : "label ← (existing records only)",
    ...Object.entries(mapping.fieldIdx).map(([f, i]) => `${f} ← "${headers[i]}"`),
    ...(mapping.ignored.length > 0 ? [`ignored: ${mapping.ignored.join(", ")}`] : []),
  ];
  return { rows, mapping, summary };
}
