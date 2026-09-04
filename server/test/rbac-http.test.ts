process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { makeWorkspace, makeMember, makeRefTable, makeUser, req } from "./factories/index.ts";
import type { Role } from "../src/auth.ts";

beforeEach(resetDb);

/* The role→route matrix, end to end.
 *
 * One row per protected route; `allow` lists the roles that must get past the
 * gate. Every row runs for all three roles, so adding a route here is a single
 * line. The assertion is only about the gate: an allowed role must not see 403
 * (a later 4xx for a missing field or an empty body is fine), a denied role must.
 *
 * The matrix itself: editors curate, publish, run scans and own table structure
 * (create/delete tables, add/rename/retype/delete/configure fields, wire
 * sources); admins additionally own workspace settings (preferences, members,
 * rename/delete, rollback) and the integrations surface (webhooks, service
 * accounts); viewers read only. Editors may READ webhooks; service accounts are
 * admin-only for read as well, because the values are credentials. */

const ROLES: Role[] = ["viewer", "editor", "admin"];
const EDITOR_UP: Role[] = ["editor", "admin"];
const ADMIN_ONLY: Role[] = ["admin"];

interface Fixture {
  /** workspace slug (== id) */
  ws: string;
  /** a reference table with one field, "Code" */
  refTableId: string;
  /** a second member, so admin-only member routes have a target that isn't self */
  otherUserId: string;
}

interface Case {
  name: string;
  method: string;
  path: (f: Fixture) => string;
  body?: unknown;
  allow: Role[];
}

const CASES: Case[] = [
  // ── content: curate + publish (editor) ──────────────────────────────────
  {
    name: "PUT /tables/:id/drafts",
    method: "PUT",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/drafts`,
    body: { raw: "acme", status: "mapped", targetLabel: "Acme", targetKey: null },
    allow: EDITOR_UP,
  },
  {
    name: "POST /tables/:id/commit",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/commit`,
    body: {},
    allow: EDITOR_UP,
  },
  // ── table structure: manage_tables (editor) ─────────────────────────────
  {
    name: "POST /tables",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables`,
    body: { name: "Made by role test" },
    allow: EDITOR_UP,
  },
  {
    name: "DELETE /tables/:id",
    method: "DELETE",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}`,
    allow: EDITOR_UP,
  },
  {
    name: "POST /tables/:id/fields",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/fields`,
    body: { label: "Region" },
    allow: EDITOR_UP,
  },
  {
    name: "PUT /tables/:id/fields/:field",
    method: "PUT",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/fields/Code`,
    body: { label: "Renamed" },
    allow: EDITOR_UP,
  },
  {
    name: "PATCH /tables/:id/fields/:field",
    method: "PATCH",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/fields/Code`,
    body: { description: "a code" },
    allow: EDITOR_UP,
  },
  {
    name: "DELETE /tables/:id/fields/:field",
    method: "DELETE",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/fields/Code`,
    allow: EDITOR_UP,
  },
  {
    name: "POST /tables/:id/formula/validate",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/formula/validate`,
    body: { expr: "1 + 1" },
    allow: EDITOR_UP,
  },
  {
    name: "POST /tables/:id/sources",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/sources`,
    body: { table: "public.vendors", column: "name" },
    allow: EDITOR_UP,
  },
  {
    name: "DELETE /tables/:id/sources",
    method: "DELETE",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/sources`,
    body: { table: "public.vendors", column: "name" },
    allow: EDITOR_UP,
  },
  // ── scans: manage_tables (editor) ───────────────────────────────────────
  {
    name: "POST /tables/:id/scan",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/scan`,
    body: {},
    allow: EDITOR_UP,
  },
  {
    name: "POST /sources/scan",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/sources/scan`,
    body: {},
    allow: EDITOR_UP,
  },
  // ── workspace settings: manage_workspace (admin) ────────────────────────
  {
    name: "PUT /preferences",
    method: "PUT",
    path: (f) => `/api/t/${f.ws}/preferences`,
    body: {
      scanSchedule: null,
      requireSecondPublisher: false,
    },
    allow: ADMIN_ONLY,
  },
  {
    name: "PATCH /t/:slug (rename workspace)",
    method: "PATCH",
    path: (f) => `/api/t/${f.ws}`,
    body: { label: "Renamed workspace" },
    allow: ADMIN_ONLY,
  },
  {
    name: "PUT /team/members/:id/role",
    method: "PUT",
    path: (f) => `/api/t/${f.ws}/team/members/${f.otherUserId}/role`,
    body: { role: "editor" },
    allow: ADMIN_ONLY,
  },
  {
    name: "DELETE /team/members/:id",
    method: "DELETE",
    path: (f) => `/api/t/${f.ws}/team/members/${f.otherUserId}`,
    allow: ADMIN_ONLY,
  },
  {
    name: "POST /team/invites",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/team/invites`,
    body: { email: "invitee@example.com", role: "viewer" },
    allow: ADMIN_ONLY,
  },
  {
    name: "POST /tables/:id/rollback",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/tables/${f.refTableId}/rollback`,
    body: { toVersion: 1 },
    allow: ADMIN_ONLY,
  },
  // ── integrations: manage_integrations (admin), editor may read webhooks ──
  {
    name: "GET /v1/webhooks",
    method: "GET",
    path: (f) => `/api/t/${f.ws}/v1/webhooks`,
    allow: EDITOR_UP,
  },
  {
    name: "POST /v1/webhooks",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/v1/webhooks`,
    body: { url: "https://example.com/hook", events: ["record.published"] },
    allow: ADMIN_ONLY,
  },
  {
    name: "GET /v1/service-accounts",
    method: "GET",
    path: (f) => `/api/t/${f.ws}/v1/service-accounts`,
    allow: ADMIN_ONLY,
  },
  {
    name: "POST /v1/service-accounts",
    method: "POST",
    path: (f) => `/api/t/${f.ws}/v1/service-accounts`,
    body: { name: "reader" },
    allow: ADMIN_ONLY,
  },
];

/** Fresh workspace per (case, role) so one case's mutation can't affect another. */
async function fixture(ws: string): Promise<Fixture> {
  await makeWorkspace(ws);
  const refTableId = await makeRefTable(ws, "Vendors");
  const { cookie: adminCookie } = await makeMember(`${ws}_setup`, ws, "admin");
  await req("POST", `/api/t/${ws}/tables/${refTableId}/fields`, adminCookie, { label: "Code" });
  const otherUserId = await makeUser(`${ws}_other`);
  await makeMember(otherUserId, ws, "editor");
  return { ws, refTableId, otherUserId };
}

let n = 0;
for (const c of CASES) {
  for (const role of ROLES) {
    const allowed = c.allow.includes(role);
    test(`${c.name} — ${role} is ${allowed ? "allowed" : "blocked"}`, async () => {
      const f = await fixture(`w_rbac${n++}`);
      const { cookie } = await makeMember(`u_${role}_${f.ws}`, f.ws, role);
      const res = await req(c.method, c.path(f), cookie, c.body);
      if (allowed) expect(res.status).not.toBe(403);
      else expect(res.status).toBe(403);
    });
  }
}
