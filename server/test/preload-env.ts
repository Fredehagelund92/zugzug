/* Test-env guard, preloaded via bunfig.toml [test].preload BEFORE any test
 * file or its imports evaluate.
 *
 * Why: test files set process.env.DATABASE_URL at the top of the file, but
 * static imports are hoisted above those assignments — so when a single file
 * is run directly (`bun test test/foo.test.ts`), env.ts reads DATABASE_URL
 * from server/.env and the pool silently connects to the DEV database.
 * Test dimensions and users then leak into dev data (this happened).
 *
 * `bun run test` (package.json) already sets these in the shell env; shell
 * env wins over .env, so this preload is a no-op there. It only changes
 * behavior for direct `bun test <file>` invocations.
 */
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE ??= "false";
process.env.MOTHERDUCK_TOKEN ??= "test-stub";
process.env.GOOGLE_CLIENT_ID ??= "test-stub";
process.env.GOOGLE_CLIENT_SECRET ??= "test-stub";
process.env.ZUGZUG_CURSOR_KEY ??= "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

// resetDb() (DROP SCHEMA + replay all migrations) takes 7–13 s on this
// machine. Migration 0036 added dimension_version (table + RLS policy),
// pushing cumulative replay past the 5 s bun default. Raise the global
// timeout so beforeEach hooks that call resetDb() do not time out.
// bunfig.toml [test].timeout is not respected in bun 1.3.x — this is the
// only way to set it that works for both `bun test` and `bun run test`.
import { setDefaultTimeout } from "bun:test";
setDefaultTimeout(30_000);
