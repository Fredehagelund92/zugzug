import { describe, it, expect, beforeEach } from "bun:test";
import { _resetAdapterCache, getAdapter } from "./registry.ts";
import { registerFactories } from "./credentials.ts";
import type { WarehouseAdapter } from "./adapter.ts";

function fakeAdapter(): WarehouseAdapter {
  return {
    ping: async () => undefined,
    listDatabases:    async () => [],
    probeDatabase:    async () => ({ ok: true as const }),
    listTables:       async () => [],
    distinctValuesWithProvenance: async () => [],
    nameResolution:   async () => new Map(),
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
      snowflake: async () => { throw new Error("nope"); },
    });
    const a = await getAdapter();
    const b = await getAdapter();
    expect(constructed).toBe(1);
    expect(a).toBe(b);
  });
});
