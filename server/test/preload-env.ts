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
