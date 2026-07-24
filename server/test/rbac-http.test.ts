process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { makeWorkspace, makeMember, makeRefTable, req } from "./factories/index.ts";

beforeEach(resetDb);

// ── POST /tables (structural: create table) ──────────────────────────────

test("viewer is blocked from creating a table", async () => {
  await makeWorkspace("w_rbac_v1");
  const { cookie } = await makeMember("u_viewer_v1", "w_rbac_v1", "viewer");
  const res = await req("POST", "/api/t/w_rbac_v1/tables", cookie, { name: "X" });
  expect(res.status).toBe(403);
});

test("editor is blocked from creating a table (structural = admin-only)", async () => {
  await makeWorkspace("w_rbac_e1");
  const { cookie } = await makeMember("u_editor_e1", "w_rbac_e1", "editor");
  const res = await req("POST", "/api/t/w_rbac_e1/tables", cookie, { name: "X" });
  expect(res.status).toBe(403);
});

test("admin can create a table", async () => {
  await makeWorkspace("w_rbac_a1");
  const { cookie } = await makeMember("u_admin_a1", "w_rbac_a1", "admin");
  const res = await req("POST", "/api/t/w_rbac_a1/tables", cookie, { name: "X" });
  expect(res.status).not.toBe(403);
});

// ── POST /tables/:id/fields (structural: add field) ──────────────────────

test("viewer is blocked from adding a field", async () => {
  await makeWorkspace("w_rbac_v2");
  const refTableId = await makeRefTable("w_rbac_v2", "Vendors");
  const { cookie } = await makeMember("u_viewer_v2", "w_rbac_v2", "viewer");
  const res = await req("POST", `/api/t/w_rbac_v2/tables/${refTableId}/fields`, cookie, {
    label: "Code",
  });
  expect(res.status).toBe(403);
});

test("editor is blocked from adding a field (structural = admin-only)", async () => {
  await makeWorkspace("w_rbac_e2");
  const refTableId = await makeRefTable("w_rbac_e2", "Vendors");
  const { cookie } = await makeMember("u_editor_e2", "w_rbac_e2", "editor");
  const res = await req("POST", `/api/t/w_rbac_e2/tables/${refTableId}/fields`, cookie, {
    label: "Code",
  });
  expect(res.status).toBe(403);
});

test("admin can add a field", async () => {
  await makeWorkspace("w_rbac_a2");
  const refTableId = await makeRefTable("w_rbac_a2", "Vendors");
  const { cookie } = await makeMember("u_admin_a2", "w_rbac_a2", "admin");
  const res = await req("POST", `/api/t/w_rbac_a2/tables/${refTableId}/fields`, cookie, {
    label: "Code",
  });
  expect(res.status).not.toBe(403);
});

// ── DELETE /tables/:id/fields/:field (structural: delete field) ───────────

test("viewer is blocked from deleting a field", async () => {
  await makeWorkspace("w_rbac_v3");
  const refTableId = await makeRefTable("w_rbac_v3", "Vendors");
  // add field as admin so there's something to delete
  const { cookie: adminCookie } = await makeMember("u_admin_v3setup", "w_rbac_v3", "admin");
  await req("POST", `/api/t/w_rbac_v3/tables/${refTableId}/fields`, adminCookie, {
    label: "Code",
  });
  const { cookie } = await makeMember("u_viewer_v3", "w_rbac_v3", "viewer");
  const res = await req("DELETE", `/api/t/w_rbac_v3/tables/${refTableId}/fields/Code`, cookie);
  expect(res.status).toBe(403);
});

test("editor is blocked from deleting a field (structural = admin-only)", async () => {
  await makeWorkspace("w_rbac_e3");
  const refTableId = await makeRefTable("w_rbac_e3", "Vendors");
  const { cookie: adminCookie } = await makeMember("u_admin_e3setup", "w_rbac_e3", "admin");
  await req("POST", `/api/t/w_rbac_e3/tables/${refTableId}/fields`, adminCookie, {
    label: "Code",
  });
  const { cookie } = await makeMember("u_editor_e3", "w_rbac_e3", "editor");
  const res = await req("DELETE", `/api/t/w_rbac_e3/tables/${refTableId}/fields/Code`, cookie);
  expect(res.status).toBe(403);
});

test("admin can delete a field", async () => {
  await makeWorkspace("w_rbac_a3");
  const refTableId = await makeRefTable("w_rbac_a3", "Vendors");
  const { cookie } = await makeMember("u_admin_a3", "w_rbac_a3", "admin");
  await req("POST", `/api/t/w_rbac_a3/tables/${refTableId}/fields`, cookie, { label: "Code" });
  const res = await req("DELETE", `/api/t/w_rbac_a3/tables/${refTableId}/fields/Code`, cookie);
  expect(res.status).not.toBe(403);
});

// ── POST /tables (manage_adapter) ────────────────────────────────────────────

test("viewer is blocked from POST /tables", async () => {
  await makeWorkspace("w_rbac_v4");
  const { cookie } = await makeMember("u_viewer_v4", "w_rbac_v4", "viewer");
  const res = await req("POST", "/api/t/w_rbac_v4/tables", cookie, {});
  expect(res.status).toBe(403);
});

test("editor is blocked from POST /tables", async () => {
  await makeWorkspace("w_rbac_e4");
  const { cookie } = await makeMember("u_editor_e4", "w_rbac_e4", "editor");
  const res = await req("POST", "/api/t/w_rbac_e4/tables", cookie, {});
  expect(res.status).toBe(403);
});

test("admin passes the gate for POST /tables", async () => {
  await makeWorkspace("w_rbac_a4");
  const { cookie } = await makeMember("u_admin_a4", "w_rbac_a4", "admin");
  const res = await req("POST", "/api/t/w_rbac_a4/tables", cookie, {});
  expect(res.status).not.toBe(403);
});

// ── PUT /tables/:id/drafts (curate content op) ───────────────────────────

test("viewer is blocked from saving a draft", async () => {
  await makeWorkspace("w_rbac_v5");
  const refTableId = await makeRefTable("w_rbac_v5", "Vendors");
  const { cookie } = await makeMember("u_viewer_v5", "w_rbac_v5", "viewer");
  const res = await req("PUT", `/api/t/w_rbac_v5/tables/${refTableId}/drafts`, cookie, {
    raw: "acme",
    status: "mapped",
    targetLabel: "Acme",
    targetKey: null,
  });
  expect(res.status).toBe(403);
});

test("editor CAN save a draft (curate content op)", async () => {
  await makeWorkspace("w_rbac_e5");
  const refTableId = await makeRefTable("w_rbac_e5", "Vendors");
  const { cookie } = await makeMember("u_editor_e5", "w_rbac_e5", "editor");
  const res = await req("PUT", `/api/t/w_rbac_e5/tables/${refTableId}/drafts`, cookie, {
    raw: "acme",
    status: "mapped",
    targetLabel: "Acme",
    targetKey: null,
  });
  expect(res.status).not.toBe(403);
});

test("admin CAN save a draft", async () => {
  await makeWorkspace("w_rbac_a5");
  const refTableId = await makeRefTable("w_rbac_a5", "Vendors");
  const { cookie } = await makeMember("u_admin_a5", "w_rbac_a5", "admin");
  const res = await req("PUT", `/api/t/w_rbac_a5/tables/${refTableId}/drafts`, cookie, {
    raw: "acme",
    status: "mapped",
    targetLabel: "Acme",
    targetKey: null,
  });
  expect(res.status).not.toBe(403);
});

// ── POST /tables/:id/commit ───────────────────────────────────────────────

test("viewer is blocked from committing", async () => {
  await makeWorkspace("w_rbac_v6");
  const refTableId = await makeRefTable("w_rbac_v6", "Vendors");
  const { cookie } = await makeMember("u_viewer_v6", "w_rbac_v6", "viewer");
  const res = await req("POST", `/api/t/w_rbac_v6/tables/${refTableId}/commit`, cookie, {});
  expect(res.status).toBe(403);
});

test("editor CAN commit (commit permission)", async () => {
  await makeWorkspace("w_rbac_e6");
  const refTableId = await makeRefTable("w_rbac_e6", "Vendors");
  const { cookie } = await makeMember("u_editor_e6", "w_rbac_e6", "editor");
  const res = await req("POST", `/api/t/w_rbac_e6/tables/${refTableId}/commit`, cookie, {});
  expect(res.status).not.toBe(403);
});

test("admin CAN commit", async () => {
  await makeWorkspace("w_rbac_a6");
  const refTableId = await makeRefTable("w_rbac_a6", "Vendors");
  const { cookie } = await makeMember("u_admin_a6", "w_rbac_a6", "admin");
  const res = await req("POST", `/api/t/w_rbac_a6/tables/${refTableId}/commit`, cookie, {});
  expect(res.status).not.toBe(403);
});

// ── PUT /tables/:id/fields/:field (structural: rename / change type) ───────
// The gate runs before the handler, so the 403 is asserted independent of whether
// the field exists; admin passes the gate (a later 4xx for the missing field is
// fine — the point is the gate does not block admin).

test("editor is blocked from renaming a field (structural = admin-only)", async () => {
  await makeWorkspace("w_rbac_e7");
  const refTableId = await makeRefTable("w_rbac_e7", "Vendors");
  const { cookie } = await makeMember("u_editor_e7", "w_rbac_e7", "editor");
  const res = await req("PUT", `/api/t/w_rbac_e7/tables/${refTableId}/fields/Code`, cookie, {
    label: "Renamed",
  });
  expect(res.status).toBe(403);
});

test("admin is not blocked from renaming a field", async () => {
  await makeWorkspace("w_rbac_a7");
  const refTableId = await makeRefTable("w_rbac_a7", "Vendors");
  const { cookie } = await makeMember("u_admin_a7", "w_rbac_a7", "admin");
  const res = await req("PUT", `/api/t/w_rbac_a7/tables/${refTableId}/fields/Code`, cookie, {
    label: "Renamed",
  });
  expect(res.status).not.toBe(403);
});

// ── PUT /preferences (workspace settings: manage_adapter, admin-only) ──────────
// The route now gates at the HTTP layer to match TenantRepo.setPreferences, which
// requires manage_adapter. Previously the route had no gate and relied on the repo.

const PREFS_BODY = {
  publishThreshold: 1,
  suggestThreshold: 1,
  scanSchedule: null,
  requireSecondPublisher: false,
};

test("viewer is blocked from updating preferences", async () => {
  await makeWorkspace("w_rbac_v8");
  const { cookie } = await makeMember("u_viewer_v8", "w_rbac_v8", "viewer");
  const res = await req("PUT", "/api/t/w_rbac_v8/preferences", cookie, PREFS_BODY);
  expect(res.status).toBe(403);
});

test("editor is blocked from updating preferences (admin-only)", async () => {
  await makeWorkspace("w_rbac_e8");
  const { cookie } = await makeMember("u_editor_e8", "w_rbac_e8", "editor");
  const res = await req("PUT", "/api/t/w_rbac_e8/preferences", cookie, PREFS_BODY);
  expect(res.status).toBe(403);
});

test("admin can update preferences", async () => {
  await makeWorkspace("w_rbac_a8");
  const { cookie } = await makeMember("u_admin_a8", "w_rbac_a8", "admin");
  const res = await req("PUT", "/api/t/w_rbac_a8/preferences", cookie, PREFS_BODY);
  expect(res.status).not.toBe(403);
});
