process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "./pg.ts";
import { handleV1Route } from "./v1-routes.ts";
import { issueSession } from "./auth.ts";
import { createServiceAccount } from "./repo-service-accounts.ts";

const T = "test_v1_session_auth";
const SLUG = "v1sessauth";
const ADMIN = "u_v1_sess_admin";

let sessionCookie: string;
let saToken: string;

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $2, 'V1 Session Auth', now()) ON CONFLICT DO NOTHING`,
    [T, SLUG],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'V1 Session Admin', 'v1sess@example.test', 'VS', false)
     ON CONFLICT DO NOTHING`,
    [ADMIN],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()) ON CONFLICT DO NOTHING`,
    [T, ADMIN],
  );

  const issued = await issueSession(ADMIN);
  sessionCookie = `zz_sid=${issued.sessionId}`;

  const created = await createServiceAccount({
    tenantId: T,
    name: "v1-sess-sa",
    createdBy: ADMIN,
  });
  saToken = created.value;
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

function cookieReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://test${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: sessionCookie,
    },
  });
}

function bearerReq(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://test${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
    },
  });
}

describe("v1 session-cookie fallback", () => {
  it("admin cookie request to /v1/webhooks returns 200", async () => {
    const res = await handleV1Route(cookieReq(`/api/t/${SLUG}/v1/webhooks`));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { webhooks: unknown[] };
    expect(Array.isArray(body.webhooks)).toBe(true);
  });

  it("no auth at all returns 401", async () => {
    const res = await handleV1Route(new Request(`http://test/api/t/${SLUG}/v1/webhooks`));
    expect(res!.status).toBe(401);
  });

  it("bearer SA traffic still works (dimensions list)", async () => {
    const res = await handleV1Route(bearerReq(`/api/t/${SLUG}/v1/dimensions`, saToken));
    expect(res!.status).toBe(200);
  });
});
