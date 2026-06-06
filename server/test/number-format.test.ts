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
  await repo.changeColumnType(dimId, "score", {
    newType: "number",
    numberFormat: { format: "currency", symbol: "€", position: "prefix", precision: 2 },
    coerceInvalidToNull: false,
    userId,
  });
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.field === "score");
  expect(f?.numberFormat).toEqual({ format: "currency", symbol: "€", position: "prefix", precision: 2 });
});

test("changeColumnType to rating persists ratingMax and coerces integer values", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Products", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Score", "number", undefined, {}, userId);
  // Add a canonical row with score = 3
  await repo.addCanonicalOne(dimId, "Widget", undefined, userId);
  const canonical = (await repo.getDimension(dimId))!.canonical;
  const key = canonical[0].key;
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`UPDATE zugzug.dim_products SET score = 3 WHERE products_code = $1`, [key]);

  const res = await repo.changeColumnType(dimId, "score", {
    newType: "rating",
    ratingMax: 5,
    coerceInvalidToNull: false,
    userId,
  });
  expect(res.ok).toBe(true);
  const fields = await repo.listFields(dimId);
  const f = fields.find((x) => x.field === "score");
  expect(f?.type).toBe("rating");
  expect(f?.ratingMax).toBe(5);
});

test("changeColumnType to url is a lossless relabel", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brands", [], { keyKind: "slug" }, userId);
  await repo.addField(dimId, "Site", "text", undefined, {}, userId);
  const res = await repo.changeColumnType(dimId, "site", {
    newType: "url",
    coerceInvalidToNull: false,
    userId,
  });
  expect(res.ok).toBe(true);
  const fields = await repo.listFields(dimId);
  expect(fields.find((x) => x.field === "site")?.type).toBe("url");
});

test("parseFieldConfig returns ratingMax for rating type", async () => {
  const { parseFieldConfig } = await import("../src/repo-shared.ts");
  expect(parseFieldConfig("rating", '{"ratingMax":5}')).toEqual({ ratingMax: 5 });
  expect(parseFieldConfig("rating", null)).toEqual({ ratingMax: 5 }); // default
  expect(parseFieldConfig("number", '{"format":"integer"}')).toEqual({
    numberFormat: { format: "integer" },
  });
  expect(parseFieldConfig("select", '[{"label":"A","color":null}]')).toEqual({
    options: [{ label: "A", color: null }],
  });
  expect(parseFieldConfig("text", null)).toEqual({});
});
