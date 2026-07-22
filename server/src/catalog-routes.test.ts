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
    expect(body).toEqual({ adapter: "duckdb", databaseTerm: "database" });
  });
});
