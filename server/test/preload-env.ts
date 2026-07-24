/* Test-env guard, preloaded via bunfig.toml [test].preload BEFORE any test
 * file or its imports evaluate.
 *
 * Why: test files set process.env.DATABASE_URL at the top of the file, but
 * static imports are hoisted above those assignments — so when a single file
 * is run directly (`bun test test/foo.test.ts`), env.ts reads DATABASE_URL
 * from server/.env and the pool silently connects to the DEV database.
 * Test refTables and users then leak into dev data (this happened).
 *
 * `bun run test` (package.json) already sets these in the shell env; shell
 * env wins over .env, so this preload is a no-op there. It only changes
 * behavior for direct `bun test <file>` invocations.
 */
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
// Forced, not `??=`: bun auto-loads server/.env before this preload runs, so a
// soft assignment keeps the dev values (ATTACH_WAREHOUSE=true + real token) and
// direct `bun test <file>` runs silently attach to the real warehouse.
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID ??= "test-stub";
process.env.GOOGLE_CLIENT_SECRET ??= "test-stub";
process.env.ZUGZUG_CURSOR_KEY ??= "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

// resetDb() (DROP SCHEMA + replay all migrations) takes 2–6 s per call.
// Migration 0036 added reference_table_version (table + RLS policy), pushing replay
// past the 5 s bun default, so beforeEach hooks that call resetDb() flap.
//
// Raising the limit is harder than it looks in bun 1.3.x:
// - bunfig.toml [test].timeout is not respected;
// - setDefaultTimeout() called here applies ONLY to the first test file bun
//   executes — the default silently reverts to 5000 ms for every subsequent
//   file (verified empirically: two identical files, first passes a 5.5 s
//   hook, second times out at 5000 ms);
// - jest.setTimeout() and hook-based re-application behave the same way.
// The only mechanism that sticks per file is a module-scope
// setDefaultTimeout() call inside the test file itself, so inject one into
// every *.test.ts at load time via a preload plugin. The header is prepended
// without a trailing newline so original line numbers are preserved in stack
// traces (the original first line is always a comment or env assignment).
import { setDefaultTimeout } from "bun:test";
import { plugin } from "bun";

setDefaultTimeout(30_000); // covers the first file even if the plugin is bypassed

plugin({
  name: "per-file-test-timeout",
  setup(build) {
    build.onLoad({ filter: /\.test\.ts$/ }, async (args) => {
      const src = await Bun.file(args.path).text();
      return {
        contents: `import { setDefaultTimeout as __sdt } from "bun:test"; __sdt(30_000); ` + src,
        loader: "ts",
      };
    });
  },
});
