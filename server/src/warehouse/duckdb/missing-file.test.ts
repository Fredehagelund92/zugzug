import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDbReadOnlyAdapter } from "./read-only.ts";
import type { DuckDbCreds } from "../credentials.ts";

describe("missing DuckDB warehouse file", () => {
  it("fails with a message naming the path and both remedies", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "zz-wh-")), "absent.duckdb");
    const adapter = new DuckDbReadOnlyAdapter({
      type: "duckdb",
      path: missing,
      attached: true,
      writable: false,
    } as DuckDbCreds);

    let message = "";
    try {
      await adapter.listDatabases();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    expect(message).toContain(missing);
    expect(message).toContain("DUCK_WAREHOUSE_PATH");
    expect(message).toContain("SEED_DEMO=true");
  });
});
