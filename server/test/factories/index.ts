import { pgRun } from "../../src/pg.ts";
import { provisionTenant } from "../../src/tenant.ts";
import { issueSession, type Role } from "../../src/auth.ts";
import { AppError } from "../../src/errors.ts";
import { handle } from "../../src/server.ts";
import { TenantRepo } from "../../src/tenant-repo.ts";

/** Insert a user (idempotent). Returns the userId. */
export async function makeUser(
  userId: string,
  opts: { email?: string; name?: string } = {},
): Promise<string> {
  const email = opts.email ?? `${userId}@example.com`;
  const name = opts.name ?? userId;
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, $2, 'TT', $3)
     ON CONFLICT (id) DO NOTHING`,
    [userId, name, email],
  );
  return userId;
}

/** Provision a workspace (idempotent). Returns the id. */
export async function makeWorkspace(id: string, label?: string): Promise<string> {
  await provisionTenant({ id, label: label ?? id }).catch((e) => {
    if (e instanceof AppError && e.code === "ALREADY_EXISTS") return;
    throw e;
  });
  return id;
}

/** Ensure user + membership + session. Returns the session cookie. */
export async function makeMember(
  userId: string,
  tenantId: string,
  role: Role,
): Promise<{ userId: string; cookie: string }> {
  await makeUser(userId);
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, role],
  );
  const { sessionId } = await issueSession(userId);
  return { userId, cookie: `zz_sid=${sessionId}` };
}

/** Make an HTTP request through the real router. */
export async function req(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
): Promise<Response> {
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    () => {},
  );
}

/** Create a table in a workspace via the repo layer (as admin). Returns its id. */
export async function makeDimension(
  tenantId: string,
  name: string,
  opts: { userId?: string } = {},
): Promise<string> {
  const repo = new TenantRepo(tenantId, "admin");
  const id = await repo.addDimension(name, [], {}, opts.userId ?? "factory");
  return id;
}
