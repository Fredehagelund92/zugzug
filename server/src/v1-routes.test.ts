process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY ||
  "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import { handleV1Route } from "./v1-routes.ts";
import { addDimension } from "./repo-canonical.ts";
import { createServiceAccount } from "./repo-service-accounts.ts";
import { recordSlugAlias } from "./slug-alias.ts";

const T = "test_v1_routes";
const SLUG = "v1routes";
const ADMIN = "u_v1_admin";

// Pull API requires both a dim_* row AND a canonical_version row, with the
// exact key (no slug() lowercasing). Mirrors repo-outbound.test.ts helper.
async function seedCanonical(
  dimId: string,
  values: { key: string; label: string }[],
  tenantId: string,
  updatedBy: string,
): Promise<void> {
  const meta = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM "zugzug_app"."dimension" WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) throw new Error(`seedCanonical: dim ${dimId} not found`);
  const [schema, table] = meta.dim_table.split(".");
  for (const v of values) {
    await pgRun(
      `INSERT INTO "${schema}"."${table}" ("${meta.key_col}", label) VALUES ($1, $2)
       ON CONFLICT ("${meta.key_col}") DO NOTHING`,
      [v.key, v.label],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by, tenant_id)
       VALUES ($1, $2, 1, now(), $3, $4)
       ON CONFLICT (tenant_id, dim_id, key) DO UPDATE
         SET retired_at = NULL, retired_into = NULL,
             version = "canonical_version".version + 1,
             updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [dimId, v.key, updatedBy, tenantId],
    );
  }
}

let dimId: string;
let saToken: string;

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $2, 'V1 Routes', 'default', now()) ON CONFLICT DO NOTHING`,
    [T, SLUG],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'V1 Admin', 'v1@example.test', 'V1', false)
     ON CONFLICT DO NOTHING`,
    [ADMIN],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()) ON CONFLICT DO NOTHING`,
    [T, ADMIN],
  );

  dimId = await addDimension("V1Country", [], { keyKind: "slug", silent: true }, ADMIN, T);
  await seedCanonical(
    dimId,
    [
      { key: "DE", label: "Germany" },
      { key: "US", label: "United States" },
    ],
    T,
    ADMIN,
  );

  const created = await createServiceAccount({ tenantId: T, name: "v1-test", createdBy: ADMIN });
  saToken = created.value;
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  if (dimId) {
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${dimId}"`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${dimId}"`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

function authedReq(path: string, init: RequestInit = {}): Request {
  return new Request(`http://test${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${saToken}`,
    },
  });
}

describe("GET /api/t/:slug/v1/dimensions", () => {
  it("returns the workspace's dimensions in API wire shape", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions`));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      dimensions: Array<{ slug: string; label: string; canonical_count: number }>;
    };
    expect(body.dimensions.find((d) => d.slug === dimId)?.label).toBe("V1Country");
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/canonical", () => {
  it("returns 200 with paginated records", async () => {
    const res = await handleV1Route(
      authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/canonical?limit=1`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      records: unknown[];
      cursor: { next: string | null };
      meta: { dim_slug: string };
    };
    expect(body.records.length).toBe(1);
    expect(body.cursor.next).not.toBeNull();
    expect(body.meta.dim_slug).toBe(dimId);
  });

  it("cursor round-trip returns the next page without duplicates", async () => {
    const r1 = await handleV1Route(
      authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/canonical?limit=1`),
    );
    const b1 = (await r1!.json()) as { records: { key: string }[]; cursor: { next: string } };
    const r2 = await handleV1Route(
      authedReq(
        `/api/t/${SLUG}/v1/dimensions/${dimId}/canonical?limit=1&cursor=${encodeURIComponent(b1.cursor.next)}`,
      ),
    );
    const b2 = (await r2!.json()) as {
      records: { key: string }[];
      cursor: { next: string | null };
    };
    expect(b2.records.length).toBe(1);
    expect(b2.records[0]!.key).not.toBe(b1.records[0]!.key);
  });

  it("returns 400 cursor_invalid for a tampered cursor", async () => {
    const res = await handleV1Route(
      authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/canonical?cursor=garbage.xx`),
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("cursor_invalid");
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/canonical/:key", () => {
  it("returns the row", async () => {
    const res = await handleV1Route(
      authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/canonical/DE`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { key: string; label: string };
    expect(body.key).toBe("DE");
    expect(body.label).toBe("Germany");
  });

  it("returns 404 for an unknown key", async () => {
    const res = await handleV1Route(
      authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/canonical/NOPE`),
    );
    expect(res!.status).toBe(404);
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/schema", () => {
  it("returns dim_slug + fields", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/schema`));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { dim_slug: string; label: string; fields: unknown[] };
    expect(body.dim_slug).toBe(dimId);
  });
});

describe("GET /api/t/:slug/v1/dimensions/:slug/tombstones", () => {
  it("returns 200 with an array (possibly empty)", async () => {
    const res = await handleV1Route(
      authedReq(`/api/t/${SLUG}/v1/dimensions/${dimId}/tombstones`),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { tombstones: unknown[] };
    expect(Array.isArray(body.tombstones)).toBe(true);
  });
});

describe("GET /api/t/:slug/v1/events", () => {
  it("returns 200 with empty events (PR3 writes them)", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/events`));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });
});

describe("GET /api/t/:slug/v1/service-accounts (admin only)", () => {
  it("SA-authenticated request returns 403 (admin only)", async () => {
    const res = await handleV1Route(authedReq(`/api/t/${SLUG}/v1/service-accounts`));
    expect(res!.status).toBe(403);
  });
});

describe("auth rejection — missing bearer", () => {
  it("returns 401", async () => {
    const res = await handleV1Route(new Request(`http://test/api/t/${SLUG}/v1/dimensions`));
    expect(res!.status).toBe(401);
  });
});

describe("tenant mismatch — SA from a different workspace", () => {
  it("returns 403 with tenant_mismatch", async () => {
    const OT = "test_v1_other";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
       VALUES ($1, $1, 'Other', 'default', now()) ON CONFLICT DO NOTHING`,
      [OT],
    );
    const { value } = await createServiceAccount({
      tenantId: OT,
      name: "other-tenant-sa",
      createdBy: ADMIN,
    });
    const req = new Request(`http://test/api/t/${SLUG}/v1/dimensions`, {
      headers: { authorization: `Bearer ${value}` },
    });
    const res = await handleV1Route(req);
    expect(res!.status).toBe(403);

    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [OT]);
    await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [OT]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [OT]);
  });
});

describe("slug-redirect alias", () => {
  it("returns 301 with Location for an aliased old slug", async () => {
    await recordSlugAlias("v1routes_old", T);
    const req = new Request(`http://test/api/t/v1routes_old/v1/dimensions`, {
      headers: { authorization: `Bearer ${saToken}` },
    });
    const res = await handleV1Route(req);
    expect(res!.status).toBe(301);
    expect(res!.headers.get("location")).toBe(`/api/t/${SLUG}/v1/dimensions`);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE old_slug = $1`, [
      "v1routes_old",
    ]);
  });
});
