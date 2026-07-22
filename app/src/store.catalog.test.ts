import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchColumns, fetchColumnValues, listSchemas } from "./store";

function mockJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}
afterEach(() => vi.restoreAllMocks());

describe("catalog fetchers", () => {
  it("listSchemas returns facets from /warehouse/schemas", async () => {
    const spy = vi
      .spyOn(global, "fetch")
      .mockReturnValue(mockJson([{ schema: "authco", tables: 9 }]));
    const out = await listSchemas("db-1");
    expect(out).toEqual([{ schema: "authco", tables: 9 }]);
    expect(spy.mock.calls[0][0]).toContain("/warehouse/schemas?database=db-1");
  });

  it("fetchColumns returns name+type pairs", async () => {
    vi.spyOn(global, "fetch").mockReturnValue(mockJson([{ name: "country", type: "VARCHAR" }]));
    expect(await fetchColumns("db-1", "authco.users")).toEqual([
      { name: "country", type: "VARCHAR" },
    ]);
  });

  it("fetchColumnValues unwraps the values array", async () => {
    vi.spyOn(global, "fetch").mockReturnValue(mockJson({ values: ["US", "DK"] }));
    expect(await fetchColumnValues("db-1", "authco.users", "country", 5)).toEqual(["US", "DK"]);
  });
});
