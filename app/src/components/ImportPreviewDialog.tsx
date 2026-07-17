import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { applyColumnMap, fieldMismatch, type ColumnTarget, type MappedImportRow } from "../lib/csv";
import type { CsvMapping } from "../lib/csv";
import type { FieldDef } from "../data";

/** Convert prepareImport's auto-mapping into a ColumnTarget[] for each CSV header. */
function defaultMap(headers: string[], mapping: CsvMapping): ColumnTarget[] {
  return headers.map((_, i) => {
    if (i === mapping.keyIdx) return { kind: "key" };
    if (i === mapping.labelIdx) return { kind: "label" };
    const fieldId = Object.entries(mapping.fieldIdx).find(([, idx]) => idx === i)?.[0];
    if (fieldId) return { kind: "field", fieldId };
    return { kind: "ignore" };
  });
}

interface CoercionWarning {
  header: string;
  count: number;
  severity: "empty" | "blocking";
}

function computeWarnings(
  headers: string[],
  allRows: string[][],
  map: ColumnTarget[],
  fields: FieldDef[],
): CoercionWarning[] {
  const fieldById = new Map(fields.map((f) => [f.field, f]));
  const warnings: CoercionWarning[] = [];
  map.forEach((target, i) => {
    if (target.kind !== "field") return;
    const field = fieldById.get(target.fieldId);
    if (!field) return;
    let emptyCount = 0;
    let blockingCount = 0;
    for (const row of allRows) {
      const v = row[i] ?? "";
      const m = fieldMismatch(field.type, v);
      if (m === "empty") emptyCount++;
      else if (m === "blocking") blockingCount++;
    }
    if (blockingCount > 0) {
      warnings.push({ header: headers[i] ?? "", count: blockingCount, severity: "blocking" });
    } else if (emptyCount > 0) {
      warnings.push({ header: headers[i] ?? "", count: emptyCount, severity: "empty" });
    }
  });
  return warnings;
}

export function ImportPreviewDialog({
  open,
  headers,
  rows,
  mapping,
  fields,
  importing,
  onConfirm,
  onCancel,
  tableName,
}: {
  open: boolean;
  headers: string[];
  rows: string[][];
  mapping: CsvMapping;
  fields: FieldDef[];
  importing: boolean;
  onConfirm: (mapped: MappedImportRow[]) => void;
  onCancel: () => void;
  tableName: string;
}) {
  const [colMap, setColMap] = useState<ColumnTarget[]>(() => defaultMap(headers, mapping));

  // reset when dialog re-opens with new data
  const [lastHeaders, setLastHeaders] = useState(headers);
  if (headers !== lastHeaders) {
    setLastHeaders(headers);
    setColMap(defaultMap(headers, mapping));
  }

  const hasKey = colMap.some((t) => t.kind === "key");
  const hasLabel = colMap.some((t) => t.kind === "label");
  const warnings = computeWarnings(headers, rows, colMap, fields);
  const hasBlockingWarnings = warnings.some((w) => w.severity === "blocking");
  const canImport = (hasKey || hasLabel) && !hasBlockingWarnings;

  const previewRows = rows.slice(0, 3);
  const mapped = applyColumnMap(headers, previewRows, colMap);

  const totalRecords = rows.length;

  function setTarget(i: number, value: string) {
    setColMap((prev) => {
      const next = [...prev];
      if (value === "key") {
        // only one key column allowed
        next.forEach((t, j) => {
          if (j !== i && t.kind === "key") next[j] = { kind: "ignore" };
        });
        next[i] = { kind: "key" };
      } else if (value === "label") {
        // only one label column allowed
        next.forEach((t, j) => {
          if (j !== i && t.kind === "label") next[j] = { kind: "ignore" };
        });
        next[i] = { kind: "label" };
      } else if (value === "ignore") {
        next[i] = { kind: "ignore" };
      } else {
        // field:<fieldId>
        const fieldId = value.slice("field:".length);
        next[i] = { kind: "field", fieldId };
      }
      return next;
    });
  }

  function selectValue(target: ColumnTarget): string {
    if (target.kind === "key") return "key";
    if (target.kind === "label") return "label";
    if (target.kind === "field") return `field:${target.fieldId}`;
    return "ignore";
  }

  return (
    <ConfirmDialog
      open={open}
      title={`Import into ${tableName}?`}
      confirmLabel={
        importing ? "Importing…" : `Import ${totalRecords} record${totalRecords === 1 ? "" : "s"}`
      }
      loading={importing}
      onConfirm={() => {
        if (!canImport) return;
        onConfirm(applyColumnMap(headers, rows, colMap));
      }}
      onCancel={onCancel}
      body={
        <div className="max-h-[70vh] space-y-3 overflow-y-auto text-left">
          {/* Column mapping selects */}
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-ink-3">Map columns</p>
            {headers.map((header, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate font-mono text-[12px] text-ink-2">
                  {header}
                </span>
                <select
                  className="flex-1 rounded-sm border border-line bg-surface px-2 py-1 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent"
                  value={selectValue(colMap[i] ?? { kind: "ignore" })}
                  onChange={(e) => setTarget(i, e.target.value)}
                >
                  <option value="key">Key</option>
                  <option value="label">Label / Record name</option>
                  {fields.map((f) => (
                    <option key={f.field} value={`field:${f.field}`}>
                      {f.label}
                    </option>
                  ))}
                  <option value="ignore">Ignore</option>
                </select>
              </div>
            ))}
          </div>

          {!canImport && (
            <p className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] text-danger">
              Map at least one column to Key or Label / Record name to import.
            </p>
          )}

          {/* Coercion warnings */}
          {warnings.length > 0 && (
            <div className="space-y-0.5">
              {warnings.map((w) =>
                w.severity === "blocking" ? (
                  <p
                    key={w.header}
                    className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5 text-[12px] text-danger"
                  >
                    {w.count} value{w.count === 1 ? "" : "s"} in &apos;{w.header}&apos; aren&apos;t
                    valid dates — fix the CSV or map the column to Ignore. Importing would fail.
                  </p>
                ) : (
                  <p key={w.header} className="text-[12px] text-amber-500">
                    {w.count} value{w.count === 1 ? "" : "s"} in &apos;{w.header}&apos; will import
                    empty.
                  </p>
                ),
              )}
            </div>
          )}

          {/* Preview table */}
          {previewRows.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wider text-ink-3">
                Preview (first {previewRows.length} record{previewRows.length === 1 ? "" : "s"})
              </p>
              <div className="overflow-x-auto rounded-sm border border-line">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-line bg-surface-2">
                      <th className="px-2 py-1 text-left font-mono text-ink-3">key</th>
                      <th className="px-2 py-1 text-left font-mono text-ink-3">label</th>
                      {fields
                        .filter((f) =>
                          colMap.some((t) => t.kind === "field" && t.fieldId === f.field),
                        )
                        .map((f) => (
                          <th key={f.field} className="px-2 py-1 text-left font-mono text-ink-3">
                            {f.label}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mapped.map((row, ri) => (
                      <tr key={ri} className="border-b border-line last:border-0">
                        <td className="px-2 py-1 font-mono text-ink-2">{row.key || "—"}</td>
                        <td className="px-2 py-1 font-mono text-ink-2">{row.label || "—"}</td>
                        {fields
                          .filter((f) =>
                            colMap.some((t) => t.kind === "field" && t.fieldId === f.field),
                          )
                          .map((f) => (
                            <td key={f.field} className="px-2 py-1 font-mono text-ink-2">
                              {row.fields[f.field] ?? "—"}
                            </td>
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 3 && (
                <p className="mt-0.5 text-[11px] text-ink-3">
                  … and {rows.length - 3} more record{rows.length - 3 === 1 ? "" : "s"}
                </p>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
