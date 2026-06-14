import { createHash } from "node:crypto";
import { pgAll, pgRun } from "../src/pg.ts";
import { env } from "../src/env.ts";
import { encryptCredentials } from "../src/warehouse/crypto.ts";

interface PendingRow {
  id: string;
  tenant_id: string;
  adapter: string;
}

export async function runWarehouseBackfill(): Promise<void> {
  const rows = await pgAll<PendingRow>(
    `SELECT id, tenant_id, adapter
       FROM "zugzug_app"."warehouse_connection"
      WHERE credentials_encrypted = '__PENDING__'`,
  );
  if (rows.length === 0) {
    console.log("warehouse-backfill: nothing to do (no __PENDING__ rows).");
    return;
  }
  for (const row of rows) {
    if (row.adapter !== "motherduck") {
      console.log(`warehouse-backfill: skipping ${row.tenant_id}/${row.id} (adapter=${row.adapter})`);
      continue;
    }
    const plaintext = JSON.stringify({ type: "duckdb", token: env.motherduckToken, writable: false });
    const aad = `${row.tenant_id}:${row.id}`;
    const blob = encryptCredentials(plaintext, aad);
    const hash = createHash("sha256").update(plaintext).digest("hex");
    await pgRun(
      `UPDATE "zugzug_app"."warehouse_connection"
          SET credentials_encrypted = $1,
              credentials_hash      = $2
        WHERE tenant_id = $3 AND id = $4 AND credentials_encrypted = '__PENDING__'`,
      [blob, hash, row.tenant_id, row.id],
    );
    console.log(`warehouse-backfill: filled ${row.tenant_id}/${row.id}`);
  }
}

if (import.meta.main) {
  runWarehouseBackfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("warehouse-backfill failed:", err);
      process.exit(1);
    });
}
