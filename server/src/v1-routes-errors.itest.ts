process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { pgRun } from "./pg.ts";
import { createServiceAccount } from "./repo-service-accounts.ts";

// #156: force a non-cursor error out of a Pull-API query helper and assert the
// handler sanitizes it to 500 { error: "internal" } rather than echoing the raw
// message. mock.module is process-global, so this lives in its own .itest.ts
// invocation (not the default `bun test` batch) — same isolation as
// catalog-routes.itest.ts.
mock.module("./repo-outbound.ts", () => ({
  listRefTablesForApi: async () => ({ tables: [] }),
  getSchemaForApi: async () => null,
  listRecordPage: async () => {
    throw new Error("secret-bearing raw DB failure");
  },
  getRecordRow: async () => null,
  listTombstonesPage: async () => {
    throw new Error("secret-bearing raw DB failure");
  },
  listEventsPage: async () => {
    throw new Error("secret-bearing raw DB failure");
  },
}));

const { handleV1Route } = await import("./v1-routes.ts");

const T = "test_v1_errs";
const SLUG = "v1errs";
const ADMIN = "u_v1_errs_admin";
let saToken: string;

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $2, 'V1 Errors', now()) ON CONFLICT DO NOTHING`,
    [T, SLUG],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'V1 ErrAdmin', 'v1errs@example.test', 'VE', false)
     ON CONFLICT DO NOTHING`,
    [ADMIN],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()) ON CONFLICT DO NOTHING`,
    [T, ADMIN],
  );
  const created = await createServiceAccount({ tenantId: T, name: "v1-errs-sa", createdBy: ADMIN });
  saToken = created.value;
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

function req(path: string): Request {
  return new Request(`http://test.local/api/t/${SLUG}/v1${path}`, {
    headers: { authorization: `Bearer ${saToken}` },
  });
}

describe("v1 handler error sanitization (#156)", () => {
  it("records 500 { error: internal } without echoing the raw error", async () => {
    const res = await handleV1Route(req("/tables/anytable/records"));
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret-bearing");
  });

  it("removed endpoint sanitizes errors too", async () => {
    const res = await handleV1Route(req("/tables/anytable/removed"));
    expect(res!.status).toBe(500);
    expect(((await res!.json()) as { error: string }).error).toBe("internal");
  });

  it("events endpoint sanitizes errors too", async () => {
    const res = await handleV1Route(req("/events"));
    expect(res!.status).toBe(500);
    expect(((await res!.json()) as { error: string }).error).toBe("internal");
  });
});
