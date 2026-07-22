process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { resetDb } from "./setup.ts";
import { makeWorkspace, makeDimension } from "./factories/index.ts";
import { TenantRepo } from "../src/tenant-repo.ts";
import { AppError } from "../src/errors.ts";

beforeEach(resetDb);
afterAll(resetDb);

// ---------------------------------------------------------------------------
// manage_adapter: addField — viewer AND editor cannot; admin can
// ---------------------------------------------------------------------------

test("manage_adapter: viewer cannot addField → FORBIDDEN", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer");
  let err: AppError | null = null;
  try {
    await repo.addField(dimId, "Category", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("manage_adapter: editor cannot addField → FORBIDDEN", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.addField(dimId, "Category", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("manage_adapter: admin can addField (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.addField(dimId, "Category", "text", undefined, {}, "u1");
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
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer");
  let err: AppError | null = null;
  try {
    await repo.commit(dimId, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("commit: editor can commit (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.commit(dimId, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("commit: admin can commit (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.commit(dimId, "u1");
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
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer");
  let err: AppError | null = null;
  try {
    await repo.saveDraft(dimId, "raw-val", "mapped", "Target", "target-key", "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).toBe("FORBIDDEN");
});

test("curate: editor can saveDraft (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "editor");
  let err: AppError | null = null;
  try {
    await repo.saveDraft(dimId, "raw-val", "mapped", "Target", "target-key", "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("curate: admin can saveDraft (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "admin");
  let err: AppError | null = null;
  try {
    await repo.saveDraft(dimId, "raw-val", "mapped", "Target", "target-key", "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

// ---------------------------------------------------------------------------
// read: listDimensions + getPreferences — all roles resolve without throwing
// ---------------------------------------------------------------------------

test("read: viewer can listDimensions", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "viewer");
  await expect(repo.listDimensions()).resolves.toBeDefined();
});

test("read: editor can listDimensions", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "editor");
  await expect(repo.listDimensions()).resolves.toBeDefined();
});

test("read: admin can listDimensions", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "admin");
  await expect(repo.listDimensions()).resolves.toBeDefined();
});

test("read: viewer can getPreferences", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "viewer");
  await expect(repo.getPreferences()).resolves.toBeDefined();
});

// ---------------------------------------------------------------------------
// super-admin bypass: viewer with isSuperAdmin=true bypasses manage_adapter gate
// ---------------------------------------------------------------------------

test("super-admin bypass: viewer+isSuperAdmin can addField (no FORBIDDEN)", async () => {
  await makeWorkspace("trbac");
  const dimId = await makeDimension("trbac", "Vendors");
  const repo = new TenantRepo("trbac", "viewer", true);
  let err: AppError | null = null;
  try {
    await repo.addField(dimId, "Region", "text", undefined, {}, "u1");
  } catch (e) {
    if (e instanceof AppError) err = e;
  }
  expect(err?.code).not.toBe("FORBIDDEN");
});

test("super-admin bypass: viewer+isSuperAdmin can listDimensions", async () => {
  await makeWorkspace("trbac");
  const repo = new TenantRepo("trbac", "viewer", true);
  await expect(repo.listDimensions()).resolves.toBeDefined();
});
