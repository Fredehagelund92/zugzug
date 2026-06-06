process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

test("addField persists integer numberFormat and listFields returns it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Rank", "number", undefined, { numberFormat: { format: "integer" } }, userId);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Rank");
  expect(f).toBeDefined();
  expect(f?.numberFormat).toEqual({ format: "integer" });
  expect(f?.options).toBeUndefined();
});

test("addField persists currency numberFormat and listFields returns it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Product", [], { keyKind: "slug" }, userId);
  await repo.addField(
    dimId,
    "Price",
    "number",
    undefined,
    { numberFormat: { format: "currency", symbol: "$", position: "prefix", precision: 2 } },
    userId,
  );
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Price");
  expect(f?.numberFormat).toEqual({
    format: "currency",
    symbol: "$",
    position: "prefix",
    precision: 2,
  });
});

test("addField with no numberFormat leaves options null and numberFormat undefined", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Channel", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Count", "number", undefined, {}, userId);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.label === "Count");
  expect(f?.numberFormat).toBeUndefined();
  expect(f?.options).toBeUndefined();
});

test("changeColumnType to number with currency format persists it", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Region", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Score", "text", undefined, {}, userId);
  await repo.changeColumnType(
    dimId,
    "score",
    "number",
    undefined,
    false,
    userId,
    { format: "currency", symbol: "€", position: "prefix", precision: 2 },
  );
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.field === "score");
  expect(f?.numberFormat).toEqual({ format: "currency", symbol: "€", position: "prefix", precision: 2 });
});
