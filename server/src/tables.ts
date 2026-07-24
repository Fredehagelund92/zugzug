/* tables.ts — POST /api/tables orchestrator. Composes the existing repo
   primitives (addRefTable, addField, addColumnOption, addSource, deriveRecord)
   inside a single Postgres transaction with one consolidated audit entry. The
   per-primitive audit emissions are suppressed via `silent: true`; the wrapper
   emits one summary entry at the end. */

import * as repo from "./repo.ts";
import type { OptionDef, PaletteName, NumberFormat } from "./repo-shared.ts";
import { PALETTE_NAMES } from "./repo-shared.ts";
import type { QualifiedSource, ImportRow } from "./repo-record.ts";
import { pgGet, pgTx } from "./pg.ts";
import { pg, env } from "./env.ts";
import { slug } from "./repo.ts"; // exported util
import { AppError } from "./errors.ts";

export type CreateTableMode = "blank" | "source" | "external_id" | "file";

export interface ColumnDraft {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "url" | "email" | "rating";
  options?: OptionDef[];
  numberFormat?: NumberFormat;
  ratingMax?: number;
}

export interface CreateTableInput {
  name: string;
  description?: string | null;
  color?: PaletteName | null;
  mode: CreateTableMode;
  columns?: ColumnDraft[]; // mode === 'blank'
  /** Either a qualified `{databaseId, schemaName, tableName, columnName}` or a
   *  bare `{table: "schema.table", column}` resolved via the first warehouse
   *  database. mode === 'source' */
  source?: QualifiedSource | { table: string; column: string };
  /** Either a qualified `{databaseId, schemaName, tableName, idColumn, nameColumn}`
   *  or a bare `{table: "schema.table", idColumn, nameColumn}` resolved via the
   *  first warehouse database. mode === 'external_id' */
  external?:
    | {
        databaseId: string;
        schemaName: string;
        tableName: string;
        idColumn: string;
        nameColumn: string;
      }
    | { table: string; idColumn: string; nameColumn: string };
  /** Parsed CSV: each header in `columns` becomes a text field; each row a
   *  record (fields keyed by header label, remapped to field ids server-side).
   *  mode === 'file' */
  file?: {
    columns: string[];
    rows: Array<{ label: string; fields?: Record<string, string | null> }>;
  };
}

function validate(input: CreateTableInput): void {
  const name = (input.name ?? "").trim();
  if (!name) throw new AppError("VALIDATION_FAILED", "name is required");
  if (input.color != null && !PALETTE_NAMES.includes(input.color)) {
    throw new AppError("VALIDATION_FAILED", `unknown color: ${input.color}`);
  }
  if (input.mode === "source") {
    const s = input.source;
    if (!s) throw new AppError("VALIDATION_FAILED", "source is required");
    if ("databaseId" in s) {
      if (!s.databaseId || !s.schemaName || !s.tableName || !s.columnName) {
        throw new AppError(
          "VALIDATION_FAILED",
          "source requires databaseId + schemaName + tableName + columnName",
        );
      }
    } else if (!s.table || !s.column) {
      throw new AppError("VALIDATION_FAILED", "source requires table + column");
    }
  } else if (input.mode === "external_id") {
    const e = input.external;
    if (!e) throw new AppError("VALIDATION_FAILED", "external is required");
    if (!e.idColumn || !e.nameColumn) {
      throw new AppError("VALIDATION_FAILED", "external requires idColumn + nameColumn");
    }
    if (e.idColumn === e.nameColumn) {
      throw new AppError("VALIDATION_FAILED", "idColumn and nameColumn must differ");
    }
    if ("databaseId" in e) {
      if (!e.databaseId || !e.schemaName || !e.tableName) {
        throw new AppError(
          "VALIDATION_FAILED",
          "external requires databaseId + schemaName + tableName",
        );
      }
    } else if (!e.table) {
      throw new AppError("VALIDATION_FAILED", "external requires table");
    }
  } else if (input.mode === "blank") {
    for (const c of input.columns ?? []) {
      if (!c.label?.trim()) throw new AppError("VALIDATION_FAILED", "field label is required");
      if (c.type === "select" && c.options) {
        const labels = c.options.map((o) => o.label);
        if (new Set(labels).size !== labels.length) {
          throw new AppError("VALIDATION_FAILED", `duplicate option labels in field "${c.label}"`);
        }
      }
    }
  } else if (input.mode === "file") {
    const f = input.file;
    if (!f || !Array.isArray(f.rows) || f.rows.length === 0) {
      throw new AppError("VALIDATION_FAILED", "file requires at least one row");
    }
    if (f.rows.length > 10000) {
      throw new AppError("VALIDATION_FAILED", "file has too many rows (max 10,000)");
    }
    if ((f.columns ?? []).length > 100) {
      throw new AppError("VALIDATION_FAILED", "file has too many columns (max 100)");
    }
    for (const c of f.columns ?? []) {
      if (!c?.trim()) throw new AppError("VALIDATION_FAILED", "column name is required");
    }
  }
  if ((input.mode === "source" || input.mode === "external_id") && !env.attachWarehouse) {
    throw new AppError("INTERNAL", "warehouse is not attached");
  }
}

export async function createTable(
  input: CreateTableInput,
  userId: string,
  tenantId: string = "default",
): Promise<{ id: string }> {
  validate(input);
  const name = input.name.trim();
  const id = slug(name);

  // Pre-flight existence check (also enforced by PK)
  const existing = await pgGet(`SELECT id FROM ${pg("reference_table")} WHERE id = $1`, [id]);
  if (existing) throw new AppError("NAME_TAKEN", `a table called "${name}" already exists`, 409);

  // Step 1 (addRefTable) issues its own DDL — keep it outside the transaction
  // since postgres.js wraps `pool.begin` in a single connection and the
  // primitive uses pgRun freely. We still drive every subsequent write through
  // pgTx for atomicity of the description/source/field/audit fold.
  const keyKind = input.mode === "external_id" ? "external_id" : "slug";
  await repo.addRefTable(name, [], { keyKind, silent: true }, userId, tenantId);

  let fieldCount = 0;
  let derivedCount = 0;

  let normalizedSource: QualifiedSource | null = null;
  if (input.mode === "source" && input.source) {
    const s = input.source;
    if ("databaseId" in s) {
      normalizedSource = s;
    } else {
      const parts = s.table.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new AppError("VALIDATION_FAILED", `expected "schema.table", got: ${s.table}`, 422);
      }
      const { resolveDefaultDatabase } = await import("./repo-record.ts");
      normalizedSource = {
        databaseId: await resolveDefaultDatabase(tenantId),
        schemaName: parts[0],
        tableName: parts[1],
        columnName: s.column,
      };
    }
  }

  await pgTx(async ({ run }) => {
    // 2. Identity extras (description, color)
    await run(`UPDATE ${pg("reference_table")} SET description = $1, color = $2 WHERE id = $3`, [
      input.description?.trim() || null,
      input.color ?? null,
      id,
    ]);

    // 3. Source binding(s) — write directly so we stay in the pgTx connection
    if (input.mode === "source" && normalizedSource) {
      await run(
        `INSERT INTO ${pg("reference_table_source")} (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
        [
          id,
          tenantId,
          normalizedSource.databaseId,
          normalizedSource.schemaName,
          normalizedSource.tableName,
          normalizedSource.columnName,
        ],
      );
    }
    if (input.mode === "external_id" && input.external) {
      const e = input.external;
      let databaseId: string;
      let schemaName: string;
      let tableName: string;
      if ("databaseId" in e) {
        databaseId = e.databaseId;
        schemaName = e.schemaName;
        tableName = e.tableName;
      } else {
        const parts = e.table.split(".");
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new AppError("VALIDATION_FAILED", `expected "schema.table", got: ${e.table}`, 422);
        }
        const { resolveDefaultDatabase } = await import("./repo-record.ts");
        databaseId = await resolveDefaultDatabase(tenantId);
        schemaName = parts[0];
        tableName = parts[1];
      }
      await run(
        `INSERT INTO ${pg("reference_table_source")} (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
        [id, tenantId, databaseId, schemaName, tableName, e.idColumn],
      );
      // External-ID also needs the name binding; this lives on the refTable row
      await run(
        `UPDATE ${pg("reference_table")} SET name_table = $1, name_id_col = $2, name_col = $3 WHERE id = $4`,
        [`${schemaName}.${tableName}`, e.idColumn, e.nameColumn, id],
      );
    }
  });

  // 4. Fields (blank mode) — addField issues DDL + INSERT, outside tx
  if (input.mode === "blank" && input.columns) {
    for (const c of input.columns) {
      await repo.addField(
        id,
        c.label.trim(),
        c.type,
        c.options,
        { silent: true, numberFormat: c.numberFormat, ratingMax: c.ratingMax },
        userId,
        tenantId,
      );
      fieldCount++;
    }
  }

  // 4b. File mode — create a text field per CSV column, then import the rows.
  //     The server owns field creation, so it also owns the header→field-id
  //     remap (client slug() and server slug() are separate implementations).
  if (input.mode === "file" && input.file) {
    const headerToField = new Map<string, string>();
    for (const header of input.file.columns) {
      const added = await repo.addField(
        id,
        header.trim(),
        "text",
        undefined,
        { silent: true },
        userId,
        tenantId,
      );
      if (added) {
        headerToField.set(header, added.field);
        fieldCount++;
      }
    }
    const rows: ImportRow[] = input.file.rows.map((r) => {
      const fields: Record<string, string | null> = {};
      for (const [header, value] of Object.entries(r.fields ?? {})) {
        const field = headerToField.get(header);
        if (field) fields[field] = value;
      }
      return { label: r.label, fields };
    });
    const res = await repo.importRecord(id, rows, userId, tenantId, { silent: true });
    derivedCount = res.created;
  }

  // 5. Seeding (source / external_id modes)
  //    deriveRecord still takes the legacy "schema.table" string; we
  //    reconstruct it from the normalized parts so external clients can keep
  //    using either input shape.
  if (input.mode === "source" && normalizedSource) {
    const sourceTable = `${normalizedSource.schemaName}.${normalizedSource.tableName}`;
    const r = await repo.deriveRecord(
      id,
      sourceTable,
      normalizedSource.columnName,
      undefined,
      { silent: true },
      userId,
      tenantId,
    );
    derivedCount = r.derived;
  }
  if (input.mode === "external_id" && input.external) {
    const e = input.external;
    const externalTable = "databaseId" in e ? `${e.schemaName}.${e.tableName}` : e.table;
    const r = await repo.deriveRecord(
      id,
      externalTable,
      e.idColumn,
      e.nameColumn,
      { silent: true },
      userId,
      tenantId,
    );
    derivedCount = r.derived;
  }

  // 6. Consolidated audit
  const sourceLabel =
    input.mode === "source" && normalizedSource
      ? `${normalizedSource.schemaName}.${normalizedSource.tableName}.${normalizedSource.columnName}`
      : "";
  const externalTableLabel =
    input.external == null
      ? ""
      : "databaseId" in input.external
        ? `${input.external.schemaName}.${input.external.tableName}`
        : input.external.table;
  const detail =
    input.mode === "blank"
      ? `${name} · blank · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`
      : input.mode === "file"
        ? `${name} · from a file · ${derivedCount} record${derivedCount === 1 ? "" : "s"} · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`
        : input.mode === "source"
          ? `${name} · from ${sourceLabel} · derived ${derivedCount}`
          : `${name} · from IDs ${externalTableLabel}.${input.external!.idColumn} (names ← ${input.external!.nameColumn}) · derived ${derivedCount}`;
  await repo.appendAuditAs(userId, "Created table", detail, { tenantId });

  return { id };
}
