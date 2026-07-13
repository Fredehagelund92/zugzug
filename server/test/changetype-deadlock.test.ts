// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { pgTxScoped, pgTxRaw, pgRun, pgGet, pgContext } from "../src/pg.ts";

beforeEach(async () => {
  await resetDb();
});

/** Reject after `ms` so a deadlock/hang fails the test instead of hanging the
 *  runner. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT (${ms}ms): ${label}`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// This is the live-reproduced deadlock: a real HTTP request runs the whole
// handler inside pgTxScoped (server.ts). Inside that ambient tx, changeColumnType
// first runs a validation SELECT (ACCESS SHARE on dim_<id>) then a nested pgTx
// ALTER TABLE (ACCESS EXCLUSIVE) on a *second* pooled connection — which blocks
// forever on the lock the ambient tx holds. Pre-fix this HANGS; the timeout guard
// turns the hang into a failure.
test("changeColumnType inside pgTxScoped completes (no cross-connection deadlock)", async () => {
  const userId = "u_test";
  const tenantId = "default";

  const dimId = await repo.addDimension("Widgets", [], { keyKind: "slug" }, userId, tenantId);
  await repo.addField(dimId, "Score", "text", undefined, {}, userId, tenantId);

  // Seed a couple of rows with numeric-looking text values.
  await repo.addCanonicalOne(dimId, "Alpha", undefined, userId, tenantId);
  await repo.addCanonicalOne(dimId, "Beta", undefined, userId, tenantId);
  const canonical = (await repo.getDimension(dimId, tenantId))!.canonical;
  await pgRun(`UPDATE zugzug.dim_widgets SET score = '1' WHERE widgets_code = $1`, [
    canonical[0].key,
  ]);
  await pgRun(`UPDATE zugzug.dim_widgets SET score = '2' WHERE widgets_code = $1`, [
    canonical[1].key,
  ]);

  // Mirror production: run the repo call inside the request's ambient tx.
  const res = await withTimeout(
    pgTxScoped(tenantId, () =>
      repo.changeColumnType(
        dimId,
        "score",
        { newType: "number", coerceInvalidToNull: false, userId },
        tenantId,
      ),
    ),
    8000,
    "changeColumnType text→number inside pgTxScoped",
  );

  expect(res.ok).toBe(true);

  // The column type actually changed.
  const fields = await repo.listFields(dimId, tenantId);
  expect(fields.find((x) => x.field === "score")?.type).toBe("number");

  // And the data survived (coerced into the new numeric column).
  const rows = await pgTxScoped(tenantId, async () => {
    const { pgAll } = await import("../src/pg.ts");
    return pgAll<{ score: number | string | null }>(
      `SELECT score FROM zugzug.dim_widgets ORDER BY score`,
    );
  });
  expect(rows.map((r) => Number(r.score))).toEqual([1, 2]);
});

// Focused plumbing test: inside pgTxScoped, take an ACCESS EXCLUSIVE lock via a
// nested pgTx on a temp-ish scratch table, then a second nested pgTx that also
// writes it. Because pgTxRaw now reuses the ambient tx (one connection) instead
// of opening a second pooled connection, the conflicting lock does NOT deadlock.
test("nested pgTx reuses the ambient connection (conflicting lock does not deadlock)", async () => {
  const scratch = `deadlock_probe_${Date.now().toString(36)}`;
  await pgRun(`CREATE TABLE zugzug.${scratch} (id int)`);
  try {
    const result = await withTimeout(
      pgTxScoped("default", async () => {
        // First nested pgTx: ALTER TABLE takes ACCESS EXCLUSIVE.
        await pgTxRaw(async ({ run }) => {
          await run(`ALTER TABLE zugzug.${scratch} ADD COLUMN a int`);
        });
        // Second nested pgTx: another ALTER on the same table. On a second
        // connection this would block on the lock the ambient tx holds.
        await pgTxRaw(async ({ run }) => {
          await run(`INSERT INTO zugzug.${scratch} (id, a) VALUES (1, 2)`);
        });
        const row = await pgGet<{ id: number; a: number }>(
          `SELECT id, a FROM zugzug.${scratch}`,
        );
        return row;
      }),
      8000,
      "nested pgTx conflicting locks inside pgTxScoped",
    );
    expect(result).toEqual({ id: 1, a: 2 });
  } finally {
    await pgRun(`DROP TABLE IF EXISTS zugzug.${scratch}`);
  }
});

// Flattening atomicity: a nested pgTx write must roll back when the OUTER
// pgTxScoped throws — because the nested tx now commits with the request tx,
// not independently.
test("nested pgTx write rolls back when the outer tx throws (flattening atomicity)", async () => {
  const scratch = `flatten_probe_${Date.now().toString(36)}`;
  await pgRun(`CREATE TABLE zugzug.${scratch} (id int)`);
  try {
    let thrown: Error | null = null;
    try {
      await pgTxScoped("default", async () => {
        await pgTxRaw(async ({ run }) => {
          await run(`INSERT INTO zugzug.${scratch} (id) VALUES (99)`);
        });
        throw new Error("boom");
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toBe("boom");

    // Outside the tx the nested-pgTx insert must be gone.
    const row = await pgGet<{ id: number }>(`SELECT id FROM zugzug.${scratch} WHERE id = 99`);
    expect(row).toBeNull();
  } finally {
    await pgRun(`DROP TABLE IF EXISTS zugzug.${scratch}`);
  }
});
