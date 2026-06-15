/* admin.ts — super-admin service operations.
 *
 * Phase 1: just promotion (CLI-driven). PR 2 adds the HTTP routes that wrap
 * these same primitives behind /api/admin/*. */

import { pgRun, pgGet } from "./pg.ts";
import { AppError } from "./errors.ts";

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

export function validateWarehouseName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: "name is required" };
  if (!WAREHOUSE_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name must match ${WAREHOUSE_NAME_RE.source} (lowercase, starts with a letter, 3-63 chars)`,
    };
  }
  return { ok: true };
}
