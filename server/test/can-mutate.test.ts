process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { canMutate, type Role, type Operation } from "../src/auth.ts";

const cases: Array<[Role, Operation, boolean]> = [
  // admin — yes to all
  ["admin", "curate", true],
  ["admin", "commit", true],
  ["admin", "manage_tables", true],
  ["admin", "manage_workspace", true],
  ["admin", "manage_integrations", true],
  // editor — curates, publishes and owns table structure + scans, but not the
  // workspace settings or the integrations surface
  ["editor", "curate", true],
  ["editor", "commit", true],
  ["editor", "manage_tables", true],
  ["editor", "manage_workspace", false],
  ["editor", "manage_integrations", false],
  // viewer — no mutations at all
  ["viewer", "curate", false],
  ["viewer", "commit", false],
  ["viewer", "manage_tables", false],
  ["viewer", "manage_workspace", false],
  ["viewer", "manage_integrations", false],
];

test.each(cases)("canMutate(%s, %s) === %s", (role, op, expected) => {
  expect(canMutate(role, op)).toBe(expected);
});
