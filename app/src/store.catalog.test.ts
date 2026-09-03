import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchColumns, fetchColumnValues, listSchemas, listTablesInSchema } from "./store";

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

  // The browse tree used to route this through searchCatalog, which clamps to
  // 100 rows — a 250-table schema showed "250" on its badge and expanded to 100.
  it("listTablesInSchema returns every table in the schema, past 100", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      schema: "sales",
      table: `t_${i}`,
      columns: ["id"],
    }));
    const spy = vi.spyOn(global, "fetch").mockReturnValue(mockJson(many));
    const out = await listTablesInSchema("db-1", "sales");
    expect(out.length).toBe(250);
    expect(out[249].table).toBe("sales.t_249");
    expect(String(spy.mock.calls[0][0])).toContain("schema=sales");
  });

  it("fetchColumnValues unwraps the values array", async () => {
    vi.spyOn(global, "fetch").mockReturnValue(mockJson({ values: ["US", "DK"] }));
    expect(await fetchColumnValues("db-1", "authco.users", "country", 5)).toEqual(["US", "DK"]);
  });
});
