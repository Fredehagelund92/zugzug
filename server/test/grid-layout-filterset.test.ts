process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { getGridLayout, setGridLayout } from "../src/repo-meta.ts";

const U = "test-user-glfilterset";
const D = "test-dim-glfilterset";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."user_grid_layout" WHERE user_id = $1 AND dim_id = $2`, [
    U,
    D,
  ]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("grid layout round-trips filterSet", async () => {
  const cfg = {
    hidden: ["x"],
    filterSet: {
      conjunction: "and",
      conditions: [{ id: "a", field: "region", operator: "equals", value: "EU" }],
    },
  };
  await setGridLayout(U, D, cfg);
  const got = await getGridLayout(U, D);
  expect(got.filterSet).toEqual(cfg.filterSet);
});
