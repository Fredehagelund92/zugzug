/* admin.ts — super-admin service operations.
 *
 * Phase 1: just promotion (CLI-driven). PR 2 adds the HTTP routes that wrap
 * these same primitives behind /api/admin/*. */

import { pgRun, pgGet } from "./pg.ts";
import { AppError } from "./errors.ts";
import { getAdapter } from "./warehouse/registry.ts";

export async function promoteSuperAdmin(email: string): Promise<{ id: string; email: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new AppError("VALIDATION_FAILED", `'${email}' is not a valid email`, 400);
  }

  const row = await pgGet<{ id: string; email: string }>(
    `SELECT id, email FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [normalized],
  );
  if (!row) {
    throw new AppError(
      "NOT_FOUND",
      `user with email '${email}' not found — they must sign in once before being promoted`,
      404,
    );
  }

  await pgRun(`UPDATE "zugzug_app"."users" SET is_super_admin = true WHERE id = $1`, [row.id]);
  return row;
}

export async function demoteSuperAdmin(email: string): Promise<{ id: string; email: string }> {
  const normalized = email.trim().toLowerCase();
  const row = await pgGet<{ id: string; email: string }>(
    `SELECT id, email FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [normalized],
  );
  if (!row) {
    throw new AppError("NOT_FOUND", `user with email '${email}' not found`, 404);
  }
  await pgRun(`UPDATE "zugzug_app"."users" SET is_super_admin = false WHERE id = $1`, [row.id]);
  return row;
}

/* ---- warehouse database creation (super-admin only) ----
 *
 * MotherDuck CREATE DATABASE is an account-level operation. Whether the
 * configured MOTHERDUCK_TOKEN can issue it depends on its scaling tier
 * (`read_scaling` tokens cannot). We let MotherDuck reject and translate the
 * resulting error to a 403 with a human remediation message. */

const WAREHOUSE_NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

export function validateWarehouseName(
  name: string,
): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: "name is required" };
  if (!WAREHOUSE_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name must match ${WAREHOUSE_NAME_RE.source} (lowercase, starts with a letter, 3-63 chars)`,
    };
  }
  return { ok: true };
}

/** Adapter raw-SQL escape hatch. The public WarehouseAdapter interface deliberately
 *  has no `run`/`all`, so we pierce the abstraction here (admin-only path). Matches
 *  the cast already in use by GET /api/admin/warehouses in server.ts. */
type RawSqlAdapter = {
  all<T>(sql: string): Promise<T[]>;
  run(sql: string): Promise<void>;
};

/**
 * Runs CREATE DATABASE "<name>" against the configured MotherDuck token.
 * Returns the freshly enumerated warehouse list on success.
 * Throws AppError with status 400 (validation) / 403 (read-only token) /
 * 409 (name conflict).
 */
export async function createWarehouseDatabase(name: string): Promise<string[]> {
  const v = validateWarehouseName(name);
  if (!v.ok) throw new AppError("VALIDATION_FAILED", v.reason, 400);

  const adapter = (await getAdapter()) as unknown as RawSqlAdapter;

  // Uniqueness check — SHOW DATABASES is what the existing list route uses.
  const existing = await adapter.all<{ database_name: string }>("SHOW DATABASES");
  const names = existing.map((r) => String(r.database_name));
  if (names.includes(name)) {
    throw new AppError("ALREADY_EXISTS", `database "${name}" already exists`, 409);
  }

  try {
    // Name is validated against WAREHOUSE_NAME_RE above — safe to interpolate.
    await adapter.run(`CREATE DATABASE "${name}"`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/read[- _]?only|permission denied|forbidden|not authorized|read_scaling/i.test(msg)) {
      throw new AppError(
        "READ_ONLY_TOKEN",
        "Your MotherDuck token cannot create databases (likely read-scaling). Update MOTHERDUCK_TOKEN to a write-capable token, or create the database manually in MotherDuck and refresh this list.",
        403,
      );
    }
    throw e;
  }

  const after = await adapter.all<{ database_name: string }>("SHOW DATABASES");
  const excluded = new Set(["system", "temp"]);
  return after.map((r) => String(r.database_name)).filter((n) => !excluded.has(n));
}
