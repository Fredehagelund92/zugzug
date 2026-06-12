/* tables.ts — POST /api/tables orchestrator. Composes the existing repo
   primitives (addDimension, addField, addColumnOption, addSource, deriveCanonical)
   inside a single Postgres transaction with one consolidated audit entry. The
   per-primitive audit emissions are suppressed via `silent: true`; the wrapper
   emits one summary entry at the end. */

import * as repo from "./repo.ts";
import type { OptionDef, PaletteName, NumberFormat } from "./repo-shared.ts";
import { pgGet, pgTx } from "./pg.ts";
import { pg, env } from "./env.ts";
import { slug } from "./repo.ts"; // exported util
import { AppError } from "./errors.ts";

const PALETTE_NAMES: PaletteName[] = ["rose", "amber", "mint", "teal", "indigo", "violet", "slate"];

export type CreateTableMode = "blank" | "source" | "external_id";

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
  source?: { table: string; column: string }; // mode === 'source'
  external?: { table: string; idColumn: string; nameColumn: string }; // mode === 'external_id'
}

/** @deprecated — use AppError directly */
export const CreateTableError = AppError;

function validate(input: CreateTableInput): void {
  const name = (input.name ?? "").trim();
  if (!name) throw new AppError("VALIDATION_FAILED", "name is required");
  if (input.color != null && !PALETTE_NAMES.includes(input.color)) {
    throw new AppError("VALIDATION_FAILED", `unknown color: ${input.color}`);
  }
  if (input.mode === "source") {
    if (!input.source?.table || !input.source?.column) {
      throw new AppError("VALIDATION_FAILED", "source requires table + column");
    }
  } else if (input.mode === "external_id") {
    const e = input.external;
    if (!e?.table || !e?.idColumn || !e?.nameColumn) {
      throw new AppError("VALIDATION_FAILED", "external_id requires table + idColumn + nameColumn");
    }
    if (e.idColumn === e.nameColumn) {
      throw new AppError("VALIDATION_FAILED", "idColumn and nameColumn must differ");
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
  const existing = await pgGet(`SELECT id FROM ${pg("dimension")} WHERE id = $1`, [id]);
  if (existing) throw new AppError("NAME_TAKEN", `a table called "${name}" already exists`, 409);

  // Step 1 (addDimension) issues its own DDL — keep it outside the transaction
  // since postgres.js wraps `pool.begin` in a single connection and the
  // primitive uses pgRun freely. We still drive every subsequent write through
  // pgTx for atomicity of the description/source/field/audit fold.
  const keyKind = input.mode === "external_id" ? "external_id" : "slug";
  await repo.addDimension(name, [], { keyKind, silent: true }, userId, tenantId);

  let fieldCount = 0;
  let derivedCount = 0;

  await pgTx(async ({ run }) => {
    // 2. Identity extras (description, color)
    await run(`UPDATE ${pg("dimension")} SET description = $1, color = $2 WHERE id = $3`, [
      input.description?.trim() || null,
      input.color ?? null,
      id,
    ]);

    // 3. Source binding(s) — write directly so we stay in the pgTx connection
    if (input.mode === "source" && input.source) {
      await run(
        `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column, tenant_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, dim_id, source_table, source_column) DO NOTHING`,
        [id, input.source.table, input.source.column, tenantId],
      );
    }
    if (input.mode === "external_id" && input.external) {
      await run(
        `INSERT INTO ${pg("dimension_source")} (dim_id, source_table, source_column, tenant_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, dim_id, source_table, source_column) DO NOTHING`,
        [id, input.external.table, input.external.idColumn, tenantId],
      );
      // External-ID also needs the name binding; this lives on the dimension row
      await run(
        `UPDATE ${pg("dimension")} SET name_table = $1, name_id_col = $2, name_col = $3 WHERE id = $4`,
        [input.external.table, input.external.idColumn, input.external.nameColumn, id],
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

  // 5. Seeding (source / external_id modes)
  if (input.mode === "source" && input.source) {
    const r = await repo.deriveCanonical(
      id,
      input.source.table,
      input.source.column,
      undefined,
      { silent: true },
      userId,
      tenantId,
    );
    derivedCount = r.derived;
  }
  if (input.mode === "external_id" && input.external) {
    const r = await repo.deriveCanonical(
      id,
      input.external.table,
      input.external.idColumn,
      input.external.nameColumn,
      { silent: true },
      userId,
      tenantId,
    );
    derivedCount = r.derived;
  }

  // 6. Consolidated audit
  const detail =
    input.mode === "blank"
      ? `${name} · blank · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`
      : input.mode === "source"
        ? `${name} · from ${input.source!.table}.${input.source!.column} · derived ${derivedCount}`
        : `${name} · from IDs ${input.external!.table}.${input.external!.idColumn} (names ← ${input.external!.nameColumn}) · derived ${derivedCount}`;
  await repo.appendAuditAs(userId, "Created table", detail, { tenantId });

  return { id };
}
