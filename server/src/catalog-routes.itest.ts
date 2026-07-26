process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { pgRun } from "./pg.ts";
import { issueSession } from "./auth.ts";

// --- Fake warehouse adapter (only the methods the catalog routes call) ---
const fakeAdapter = {
  capabilities: {
    id: "duckdb",
    databaseTerm: "database",
    supportsMultipleDatabases: true,
    writable: false,
  },
  async listTables(opts: { schema?: string; search?: string; database?: string } = {}) {
    const all = [
      { schema: "authco", table: "users", columns: ["country", "plan_type"] },
      { schema: "authco", table: "orgs", columns: ["org_id"] },
      { schema: "billing", table: "invoices", columns: ["currency"] },
    ];
    return opts.schema ? all.filter((t) => t.schema === opts.schema) : all;
  },
  async listColumns(_ref: unknown) {
    return [
      { name: "country", type: "VARCHAR" },
      { name: "plan_type", type: "VARCHAR" },
    ];
  },
  async distinctValues(_ref: unknown, _column: string, limit: number) {
    return ["US", "DK", "GB"].slice(0, limit);
  },
};

// Mock the two modules the routes dynamically import. Specifiers MUST match the
// paths server.ts uses (relative to server.ts, which is in server/src/).
mock.module("./warehouse/registry.ts", () => ({
  getAdapter: async () => fakeAdapter,
  _resetAdapterCache: () => {},
}));
mock.module("./repo-warehouse.ts", () => ({
  listWarehouseDatabases: async () => [
    { id: "db-1", databaseName: "md:demo", label: null, lastProbeError: null },
  ],
  // Stub all other exports so unrelated code paths don't throw.
  refreshSchemaCounts: async () => {},
  probeRegisteredDatabases: async () => {},
  discoverDatabases: async () => [],
  addWarehouseDatabase: async () => ({
    id: "db-new",
    databaseName: "md:new",
    label: null,
    lastProbeError: null,
  }),
  updateDatabaseLabel: async () => {},
  removeDatabase: async () => ({}),
}));

// IMPORT handle AFTER the mocks so its dynamic imports resolve to the mocks.
const { handle } = await import("./server.ts");
const noop = () => {};

// --- Tenant + session setup ---
const T = "test_catalog_routes";
const SLUG = "catalogroutes";
const ADMIN = "u_catalog_admin";

let sessionCookie: string;

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $2, 'Catalog Routes', now()) ON CONFLICT DO NOTHING`,
    [T, SLUG],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Catalog Admin', 'catalog@example.test', 'CA', false)
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
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

function globalReq(path: string): Request {
  return new Request(`http://test.local/api${path}`, {
    headers: { cookie: sessionCookie },
  });
}

// tenantReq is used by Tasks 2–4 (tenant-scoped routes)
export function tenantReq(path: string): Request {
  return new Request(`http://test.local/api/t/${SLUG}${path}`, {
    headers: { cookie: sessionCookie },
  });
}

// --- Task 1: GET /api/warehouse/info ---
describe("GET /api/warehouse/info", () => {
  it("returns adapter id and databaseTerm", async () => {
    const res = await handle(globalReq("/warehouse/info"), noop);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ adapter: "duckdb", engine: "disabled", databaseTerm: "database" });
  });
});

// --- Task 1b: GET /api/warehouse/info — adapter failure → 503 ---
describe("GET /api/warehouse/info (adapter failure)", () => {
  it("returns 503 with error: warehouse_unavailable when getAdapter throws", async () => {
    // Temporarily override the registry mock to simulate an adapter failure.
    mock.module("./warehouse/registry.ts", () => ({
      getAdapter: async () => {
        throw new Error("adapter init failed");
      },
      _resetAdapterCache: () => {},
    }));

    const res = await handle(globalReq("/warehouse/info"), noop);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "warehouse_unavailable" });

    // Restore the happy-path mock so subsequent tests are unaffected.
    mock.module("./warehouse/registry.ts", () => ({
      getAdapter: async () => fakeAdapter,
      _resetAdapterCache: () => {},
    }));
  });
});

// --- Task 2: GET /api/t/:slug/warehouse/schemas ---
describe("GET /api/t/:slug/warehouse/schemas", () => {
  it("groups tables by schema with counts, sorted desc then by name", async () => {
    const res = await handle(tenantReq("/warehouse/schemas?database=db-1"), noop);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { schema: "authco", tables: 2 },
      { schema: "billing", tables: 1 },
    ]);
  });

  it("returns 400 when database param is missing", async () => {
    const res = await handle(tenantReq("/warehouse/schemas"), noop);
    expect(res.status).toBe(400);
  });

  it("returns 404 when database id is unknown", async () => {
    const res = await handle(tenantReq("/warehouse/schemas?database=no-such-db"), noop);
    expect(res.status).toBe(404);
  });
});

// --- Task 3: GET /api/t/:slug/warehouse/columns ---
describe("GET /api/t/:slug/warehouse/columns", () => {
  it("returns column names and types for a known table", async () => {
    const res = await handle(
      tenantReq("/warehouse/columns?database=db-1&table=authco.users"),
      noop,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "country", type: "VARCHAR" },
      { name: "plan_type", type: "VARCHAR" },
    ]);
  });

  it("returns 400 when database param is missing", async () => {
    const res = await handle(tenantReq("/warehouse/columns?table=authco.users"), noop);
    expect(res.status).toBe(400);
  });

  it("returns 400 when table param is missing", async () => {
    const res = await handle(tenantReq("/warehouse/columns?database=db-1"), noop);
    expect(res.status).toBe(400);
  });

  it("returns 400 when table has no dot (schema.table format required)", async () => {
    const res = await handle(tenantReq("/warehouse/columns?database=db-1&table=users"), noop);
    expect(res.status).toBe(400);
  });

  it("returns 404 when database id is unknown", async () => {
    const res = await handle(
      tenantReq("/warehouse/columns?database=no-such-db&table=authco.users"),
      noop,
    );
    expect(res.status).toBe(404);
  });
});

// --- Task 4: GET /api/t/:slug/warehouse/values ---
describe("GET /api/t/:slug/warehouse/values", () => {
  it("returns distinct sample values up to limit", async () => {
    const res = await handle(
      tenantReq("/warehouse/values?database=db-1&table=authco.users&column=country&limit=2"),
      noop,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: ["US", "DK"] });
  });

  it("returns 400 when database param is missing", async () => {
    const res = await handle(
      tenantReq("/warehouse/values?table=authco.users&column=country"),
      noop,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when table param is missing", async () => {
    const res = await handle(tenantReq("/warehouse/values?database=db-1&column=country"), noop);
    expect(res.status).toBe(400);
  });

  it("returns 400 when column param is missing", async () => {
    const res = await handle(tenantReq("/warehouse/values?database=db-1&table=authco.users"), noop);
    expect(res.status).toBe(400);
  });

  it("returns 400 when table has no dot (schema.table format required)", async () => {
    const res = await handle(
      tenantReq("/warehouse/values?database=db-1&table=users&column=country"),
      noop,
    );
    expect(res.status).toBe(400);
  });
});
