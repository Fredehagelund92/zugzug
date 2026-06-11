process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { scanStatus } from "../src/repo-scan.ts";
import { appendAuditAs } from "../src/repo-meta.ts";

beforeEach(async () => {
  await resetDb();
});

describe("scanStatus auto-publish fields", () => {
  test("reports null when no u_system Committed audit entry exists", async () => {
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).toBeNull();
    expect(s.lastAutoPublishDetail).toBeNull();
  });

  test("reports the latest u_system Committed audit entry", async () => {
    await appendAuditAs("u_system", "Committed", "2 values → zugzug.map_test · 14 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).not.toBeNull();
    expect(s.lastAutoPublishDetail).toContain("rows recovered");
  });

  test("returns the most recent entry when multiple u_system Committed rows exist", async () => {
    await appendAuditAs("u_system", "Committed", "1 values → zugzug.map_first · 5 rows recovered");
    await appendAuditAs("u_system", "Committed", "3 values → zugzug.map_second · 20 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishDetail).toContain("map_second");
  });

  test("ignores non-Committed actions by u_system", async () => {
    await appendAuditAs("u_system", "Scanned", "some scan detail");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).toBeNull();
    expect(s.lastAutoPublishDetail).toBeNull();
  });

  test("ignores Committed actions by non-system users", async () => {
    await appendAuditAs("u_human", "Committed", "2 values → zugzug.map_test · 10 rows recovered");
    const s = await scanStatus();
    expect(s.lastAutoPublishAt).toBeNull();
    expect(s.lastAutoPublishDetail).toBeNull();
  });
});
