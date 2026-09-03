process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { resetDb } from "./setup.ts";
import { makeWorkspace, makeRefTable } from "./factories/index.ts";
import { TenantRepo } from "../src/tenant-repo.ts";
import { AppError } from "../src/errors.ts";

beforeEach(resetDb);
afterAll(resetDb);

// ---------------------------------------------------------------------------
// manage_tables: addField — viewer cannot; editor and admin can
// ---------------------------------------------------------------------------

test("manage_tables: viewer cannot addField → FORBIDDEN", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer");
  let err: AppError | null = null;
  try {
    await repo.addField(refTableId, "Category", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("manage_tables: editor can addField (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.addField(refTableId, "Category", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("manage_tables: admin can addField (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.addField(refTableId, "Category", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

// ---------------------------------------------------------------------------
// manage_workspace: setPreferences — viewer AND editor cannot; admin can
// ---------------------------------------------------------------------------

const PREFS = {
  publishThreshold: 1,
  suggestThreshold: 1,
  scanSchedule: null,
  requireSecondPublisher: false,
  autoPublishEnabled: false,
} as const;

test("manage_workspace: editor cannot setPreferences → FORBIDDEN", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.setPreferences({ ...PREFS });
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("manage_workspace: admin can setPreferences (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.setPreferences({ ...PREFS });
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

// ---------------------------------------------------------------------------
// commit: commit — viewer cannot; editor and admin can
// ---------------------------------------------------------------------------

test("commit: viewer cannot commit → FORBIDDEN", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer");
  let err: AppError | null = null;
  try {
    await repo.commit(refTableId, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("commit: editor can commit (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.commit(refTableId, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("commit: admin can commit (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.commit(refTableId, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

// ---------------------------------------------------------------------------
// curate: saveDraft — viewer cannot; editor and admin can
// ---------------------------------------------------------------------------

test("curate: viewer cannot saveDraft → FORBIDDEN", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer");
  let err: AppError | null = null;
  try {
    await repo.saveDraft(refTableId, "raw-val", "mapped", "Target", "target-key", "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("curate: editor can saveDraft (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.saveDraft(refTableId, "raw-val", "mapped", "Target", "target-key", "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("curate: admin can saveDraft (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.saveDraft(refTableId, "raw-val", "mapped", "Target", "target-key", "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

// ---------------------------------------------------------------------------
// read: listRefTables + getPreferences — all roles resolve without throwing
// ---------------------------------------------------------------------------

test("read: viewer can listRefTables", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "viewer");
  await expect(repo.listRefTables()).resolves.toBeDefined();
});

test("read: editor can listRefTables", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "editor");
  await expect(repo.listRefTables()).resolves.toBeDefined();
});

test("read: admin can listRefTables", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "admin");
  await expect(repo.listRefTables()).resolves.toBeDefined();
});

test("read: viewer can getPreferences", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "viewer");
  await expect(repo.getPreferences()).resolves.toBeDefined();
});

// ---------------------------------------------------------------------------
// super-admin bypass: viewer with isSuperAdmin=true bypasses manage_tables gate
// ---------------------------------------------------------------------------

test("super-admin bypass: viewer+isSuperAdmin can addField (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const refTableId = await makeRefTable("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer", true);
  let err: AppError | null = null;
  try {
    await repo.addField(refTableId, "Region", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("super-admin bypass: viewer+isSuperAdmin can listRefTables", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "viewer", true);
  await expect(repo.listRefTables()).resolves.toBeDefined();
});
