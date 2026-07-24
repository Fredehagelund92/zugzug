import { describe, it, expect, beforeEach } from "bun:test";
import { _resetAdapterCache, getAdapter, adapterConfigFor, type AdapterEnv } from "./registry.ts";
import { registerFactories } from "./credentials.ts";
import type { WarehouseAdapter } from "./adapter.ts";

function fakeAdapter(): WarehouseAdapter {
  return {
    ping: async () => undefined,
    listDatabases: async () => [],
    probeDatabase: async () => ({ ok: true as const }),
    listTables: async () => [],
    distinctValuesWithProvenance: async () => [],
    nameResolution: async () => new Map(),
  } as unknown as WarehouseAdapter;
}

describe("getAdapter singleton", () => {
  beforeEach(() => {
    _resetAdapterCache();
  });

  it("returns the same instance across calls", async () => {
    let constructed = 0;
    registerFactories({
      duckdb: async () => {
        constructed++;
        return fakeAdapter();
      },
      snowflake: async () => {
        throw new Error("nope");
      },
    });
    const a = await getAdapter();
    const b = await getAdapter();
    expect(constructed).toBe(1);
    expect(a).toBe(b);
  });
});

describe("adapterConfigFor", () => {
  const base: AdapterEnv = {
    warehouseAdapter: "disabled",
    motherduckToken: "tok",
    motherduckWritable: true,
    duckWarehousePath: "/data/warehouse.duckdb",
  };

  it("disabled: unattached, not writable", () => {
    expect(adapterConfigFor({ ...base, warehouseAdapter: "disabled" })).toEqual({
      type: "duckdb",
      attached: false,
      writable: false,
    });
  });

  it("motherduck: attaches with the token and passes through writable", () => {
    expect(adapterConfigFor({ ...base, warehouseAdapter: "motherduck" })).toEqual({
      type: "duckdb",
      token: "tok",
      attached: true,
      writable: true,
    });
  });

  it("duckdb: attaches the local file, read-only", () => {
    expect(adapterConfigFor({ ...base, warehouseAdapter: "duckdb" })).toEqual({
      type: "duckdb",
      path: "/data/warehouse.duckdb",
      attached: true,
      writable: false,
    });
  });

  it("unknown adapter: throws", () => {
    expect(() =>
      adapterConfigFor({ ...base, warehouseAdapter: "bigquery" as AdapterEnv["warehouseAdapter"] }),
    ).toThrow(/unsupported warehouse adapter/);
  });
});
