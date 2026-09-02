import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];

vi.mock("../src/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ removed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
  authFetch: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock("../src/lib/tenant-context", () => ({
  useTenantOptional: () => null,
}));

describe("store/removeSource", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it("DELETEs the wiring with the bare table+column body", async () => {
    const { removeSource } = await import("../src/store");
    expect(await removeSource("refTable-1", "authco.users", "plan_type")).toBe(true);
    const call = calls.find((c) => c.path.includes("/tables/refTable-1/sources"));
    expect(call).toBeTruthy();
    expect(call?.init?.method).toBe("DELETE");
    expect(JSON.parse(call?.init?.body as string)).toEqual({
      table: "authco.users",
      column: "plan_type",
    });
  });

  it("names the database when the caller knows it, so DB #2's wiring is the one deleted", async () => {
    const { removeSource } = await import("../src/store");
    await removeSource("refTable-1", "authco.users", "plan_type", "db-2");
    const call = calls.find((c) => c.path.includes("/tables/refTable-1/sources"));
    expect(JSON.parse(call?.init?.body as string)).toEqual({
      source: {
        databaseId: "db-2",
        schemaName: "authco",
        tableName: "users",
        columnName: "plan_type",
      },
    });
  });

  it("reports a delete that matched nothing as not removed", async () => {
    const { apiFetch } = (await import("../src/api")) as unknown as {
      apiFetch: { mockImplementationOnce: (fn: () => Promise<Response>) => void };
    };
    apiFetch.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ removed: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const { removeSource } = await import("../src/store");
    expect(await removeSource("refTable-1", "authco.users", "gone", "db-2")).toBe(false);
  });
});
