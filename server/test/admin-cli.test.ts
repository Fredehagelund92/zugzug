process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { parseArgs } from "../scripts/admin.ts";

test("parseArgs: create-tenant with id + multi-word label", () => {
  const args = parseArgs(["create-tenant", "sportsbook", "Sportsbook", "Team"]);
  expect(args.command).toBe("create-tenant");
  expect(args.positional).toEqual(["sportsbook", "Sportsbook", "Team"]);
  expect(args.flags).toEqual({});
});

test("parseArgs: flags split from positionals", () => {
  const args = parseArgs([
    "create-tenant",
    "sportsbook",
    "Sportsbook",
    "--warehouse=alt",
    "--slug=sb",
  ]);
  expect(args.command).toBe("create-tenant");
  expect(args.positional).toEqual(["sportsbook", "Sportsbook"]);
  expect(args.flags).toEqual({ warehouse: "alt", slug: "sb" });
});

test("parseArgs: promote-super-admin captures the email", () => {
  const args = parseArgs(["promote-super-admin", "user@example.com"]);
  expect(args.command).toBe("promote-super-admin");
  expect(args.positional).toEqual(["user@example.com"]);
});

test("parseArgs: empty argv → empty command (will print help)", () => {
  const args = parseArgs([]);
  expect(args.command).toBe("");
  expect(args.positional).toEqual([]);
});

test("parseArgs: bare --flag without = treated as boolean", () => {
  const args = parseArgs(["create-tenant", "x", "X", "--force"]);
  expect(args.flags).toEqual({ force: "true" });
});
