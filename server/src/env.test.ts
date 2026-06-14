import { describe, it, expect } from "bun:test";
import { validateWarehouseEnv } from "./env.ts";

describe("validateWarehouseEnv", () => {
  it("ATTACH_WAREHOUSE=false: all warehouse vars optional", () => {
    const result = validateWarehouseEnv({
      ATTACH_WAREHOUSE: "false",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter).toBe("disabled");
    }
  });

  it("ATTACH_WAREHOUSE=true + no WAREHOUSE_ADAPTER: fails", () => {
    const result = validateWarehouseEnv({ ATTACH_WAREHOUSE: "true" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/WAREHOUSE_ADAPTER required/);
    }
  });

  it("ATTACH_WAREHOUSE=true + WAREHOUSE_ADAPTER=motherduck + no token: fails", () => {
    const result = validateWarehouseEnv({
      ATTACH_WAREHOUSE:  "true",
      WAREHOUSE_ADAPTER: "motherduck",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/MOTHERDUCK_TOKEN required/);
    }
  });

  it("ATTACH_WAREHOUSE=true + WAREHOUSE_ADAPTER=motherduck + token: ok", () => {
    const result = validateWarehouseEnv({
      ATTACH_WAREHOUSE:  "true",
      WAREHOUSE_ADAPTER: "motherduck",
      MOTHERDUCK_TOKEN:  "test-token",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter).toBe("motherduck");
    }
  });

  it("WAREHOUSE_ADAPTER=snowflake: fails (stub not supported)", () => {
    const result = validateWarehouseEnv({
      ATTACH_WAREHOUSE:  "true",
      WAREHOUSE_ADAPTER: "snowflake",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Snowflake adapter is a stub/);
    }
  });

  it("WAREHOUSE_ADAPTER=unknown: fails", () => {
    const result = validateWarehouseEnv({
      ATTACH_WAREHOUSE:  "true",
      WAREHOUSE_ADAPTER: "bigquery",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Unknown WAREHOUSE_ADAPTER/);
    }
  });

  it("empty MOTHERDUCK_TOKEN treated as unset", () => {
    const result = validateWarehouseEnv({
      ATTACH_WAREHOUSE:  "true",
      WAREHOUSE_ADAPTER: "motherduck",
      MOTHERDUCK_TOKEN:  "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/MOTHERDUCK_TOKEN required/);
    }
  });
});
