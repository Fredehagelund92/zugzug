import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = { path: string; init?: RequestInit };
const calls: Call[] = [];

vi.mock("../src/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(null, { status: 204 });
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
    await removeSource("refTable-1", "authco.users", "plan_type");
    const call = calls.find((c) => c.path.includes("/tables/refTable-1/sources"));
    expect(call).toBeTruthy();
    expect(call?.init?.method).toBe("DELETE");
    expect(JSON.parse(call?.init?.body as string)).toEqual({
      table: "authco.users",
      column: "plan_type",
    });
  });
});
