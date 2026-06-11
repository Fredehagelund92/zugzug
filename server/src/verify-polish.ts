/* verify-polish.ts — prove the workspace-global preferences + the u_system
   user land cleanly on the real Postgres. autoStageExactMatches needs a real
   warehouse + a seeded dimension to exercise meaningfully and is skipped
   unless POLISH_AUTOSTAGE=1 is set (in which case the caller is expected to
   have seeded a fixture). Run: `bun run verify-polish`. */

import { pgAll } from "./pg.ts";
import { pg } from "./env.ts";
import * as repo from "./repo.ts";
import { runMigrations } from "../drizzle/migrate.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { getAdapter } from "./warehouse/registry.ts";

let pass = 0,
  fail = 0,
  skipped = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const note = (name: string, detail: string) => {
  console.log(`  ⊘ ${name} — ${detail}`);
  skipped++;
};

console.log("\nZug Zug — polish verification\n");
registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});
await getAdapter(); // warm the adapter
await runMigrations();

// 1. preferences round-trip
const before = await repo.getPreferences();
check(
  "getPreferences returns numeric thresholds",
  Number.isFinite(before.publishThreshold) && Number.isFinite(before.suggestThreshold),
  `publish=${before.publishThreshold}, suggest=${before.suggestThreshold}`,
);

await repo.setPreferences({ publishThreshold: 88, suggestThreshold: 60, scanSchedule: null });
const after = await repo.getPreferences();
check(
  "setPreferences round-trips",
  after.publishThreshold === 88 && after.suggestThreshold === 60,
  `got publish=${after.publishThreshold}, suggest=${after.suggestThreshold}`,
);

// clamp invariant: suggest <= publish
await repo.setPreferences({ publishThreshold: 70, suggestThreshold: 90, scanSchedule: null });
const clamped = await repo.getPreferences();
check(
  "setPreferences clamps suggest <= publish",
  clamped.suggestThreshold <= clamped.publishThreshold,
  `publish=${clamped.publishThreshold}, suggest=${clamped.suggestThreshold}`,
);

// reset to defaults
await repo.setPreferences({
  publishThreshold: before.publishThreshold,
  suggestThreshold: before.suggestThreshold,
  scanSchedule: before.scanSchedule,
});

// 2. u_system user exists (idempotent insert on schema bootstrap)
const sys = await pgAll<{ id: string }>(`SELECT id FROM ${pg("users")} WHERE id = 'u_system'`);
check(
  "u_system user provisioned by migration",
  sys.length === 1,
  "expected one row, got " + sys.length,
);

// 3. autoStageExactMatches — only meaningful with a real warehouse + a seeded dim
if (process.env.POLISH_AUTOSTAGE === "1") {
  const dimId = process.env.POLISH_DIM_ID;
  if (!dimId) {
    note(
      "autoStageExactMatches",
      "POLISH_AUTOSTAGE=1 set but POLISH_DIM_ID missing — set it to the dim to exercise",
    );
  } else {
    const n = await repo.autoStageExactMatches(dimId, "default");
    check(`autoStageExactMatches('${dimId}') returns a count`, Number.isFinite(n), `staged ${n}`);
  }
} else {
  note(
    "autoStageExactMatches",
    "POLISH_AUTOSTAGE=1 not set — needs a real warehouse + seeded dim; skipping",
  );
}

console.log(`\n  ${pass} passed · ${fail} failed · ${skipped} skipped\n`);
if (fail > 0) process.exit(1);
