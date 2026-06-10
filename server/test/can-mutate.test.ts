process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { canMutate, type Role, type Operation } from "../src/auth.ts";

const cases: Array<[Role, Operation, boolean]> = [
  // admin — yes to all
  ["admin", "curate", true],
  ["admin", "commit", true],
  ["admin", "manage_team", true],
  ["admin", "manage_adapter", true],
  // editor — curate + commit, no admin ops
  ["editor", "curate", true],
  ["editor", "commit", true],
  ["editor", "manage_team", false],
  ["editor", "manage_adapter", false],
  // viewer — no mutations at all
  ["viewer", "curate", false],
  ["viewer", "commit", false],
  ["viewer", "manage_team", false],
  ["viewer", "manage_adapter", false],
];

test.each(cases)("canMutate(%s, %s) === %s", (role, op, expected) => {
  expect(canMutate(role, op)).toBe(expected);
});
