/* bootstrap.ts — provision the stores. Run: `bun run bootstrap` (needs .env).
     • ensures the Postgres app-state schema + demo team
     • `--seed` also registers the demo Country/Channel dimensions (canonical
       tables in MotherDuck + warehouse sources) so the app runs immediately. */

import { connect } from "./db.ts";
import { ensureSchema } from "./schema.ts";
import { seedDemo } from "./seed.ts";

const seed = process.argv.includes("--seed");

console.log("\nZug Zug — bootstrap\n");
await connect();
console.log("· connected (MotherDuck + Postgres attached)");

await ensureSchema();
console.log("· Postgres app-state schema ensured (dimension, draft, audit_log, users, …)");

if (seed) {
  await seedDemo();
  console.log("· demo dimensions seeded (Country, Channel) → dim_/map_ in Postgres canonical schema");
}

console.log("\nDone.\n");
process.exit(0);
