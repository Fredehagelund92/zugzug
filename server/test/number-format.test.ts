process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

test("addField persists integer numberFormat and listFields returns it", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Brand", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(
    refTableId,
    "Rank",
    "number",
    undefined,
    { numberFormat: { format: "integer" } },
    userId,
    "default",
  );
  const fields = await repo.listFields(refTableId, "default");
  const f = fields.find((x) => x.label === "Rank");
  expect(f).toBeDefined();
  expect(f?.numberFormat).toEqual({ format: "integer" });
  expect(f?.options).toBeUndefined();
});

test("addField persists currency numberFormat and listFields returns it", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Product", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(
    refTableId,
    "Price",
    "number",
    undefined,
    { numberFormat: { format: "currency", symbol: "$", position: "prefix", precision: 2 } },
    userId,
    "default",
  );
  const fields = await repo.listFields(refTableId, "default");
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
  const refTableId = await repo.addRefTable("Channel", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(refTableId, "Count", "number", undefined, {}, userId, "default");
  const fields = await repo.listFields(refTableId, "default");
  const f = fields.find((x) => x.label === "Count");
  expect(f?.numberFormat).toBeUndefined();
  expect(f?.options).toBeUndefined();
});

test("changeColumnType to number with currency format persists it", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Region", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(refTableId, "Score", "text", undefined, {}, userId, "default");
  await repo.changeColumnType(
    refTableId,
    "score",
    {
      newType: "number",
      numberFormat: { format: "currency", symbol: "€", position: "prefix", precision: 2 },
      coerceInvalidToNull: false,
      userId,
    },
    "default",
  );
  const fields = await repo.listFields(refTableId, "default");
  const f = fields.find((x) => x.field === "score");
  expect(f?.numberFormat).toEqual({
    format: "currency",
    symbol: "€",
    position: "prefix",
    precision: 2,
  });
});

test("changeColumnType to rating persists ratingMax and coerces integer values", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Products", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(refTableId, "Score", "number", undefined, {}, userId, "default");
  // Add a record row with score = 3
  await repo.addRecordOne(refTableId, "Widget", undefined, userId, "default");
  const record = (await repo.getRefTable(refTableId, "default"))!.record;
  const key = record[0].key;
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(`UPDATE zugzug.dim_products SET score = 3 WHERE products_code = $1`, [key]);

  const res = await repo.changeColumnType(
    refTableId,
    "score",
    {
      newType: "rating",
      ratingMax: 5,
      coerceInvalidToNull: false,
      userId,
    },
    "default",
  );
  expect(res.ok).toBe(true);
  const fields = await repo.listFields(refTableId, "default");
  const f = fields.find((x) => x.field === "score");
  expect(f?.type).toBe("rating");
  expect(f?.ratingMax).toBe(5);
});

test("changeColumnType to url is a lossless relabel", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Brands", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(refTableId, "Site", "text", undefined, {}, userId, "default");
  const res = await repo.changeColumnType(
    refTableId,
    "site",
    {
      newType: "url",
      coerceInvalidToNull: false,
      userId,
    },
    "default",
  );
  expect(res.ok).toBe(true);
  const fields = await repo.listFields(refTableId, "default");
  expect(fields.find((x) => x.field === "site")?.type).toBe("url");
});

test("addField with type=rating persists ratingMax via listFields", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Reviews", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(
    refTableId,
    "Stars",
    "rating",
    undefined,
    { ratingMax: 5 },
    userId,
    "default",
  );
  const fields = await repo.listFields(refTableId, "default");
  const f = fields.find((x) => x.label === "Stars");
  expect(f?.type).toBe("rating");
  expect(f?.ratingMax).toBe(5);
  expect(f?.options).toBeUndefined();
  expect(f?.numberFormat).toBeUndefined();
});

test("addField with type=url and listFields returns it", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Links", [], { keyKind: "slug" }, userId, "default");
  await repo.addField(refTableId, "Website", "url", undefined, {}, userId, "default");
  const fields = await repo.listFields(refTableId, "default");
  const f = fields.find((x) => x.label === "Website");
  expect(f?.type).toBe("url");
  expect(f?.ratingMax).toBeUndefined();
});

test("parseFieldConfig returns ratingMax for rating type", async () => {
  const { parseFieldConfig } = await import("../src/repo-shared.ts");
  expect(parseFieldConfig("rating", '{"ratingMax":5}')).toEqual({ ratingMax: 5 });
  expect(parseFieldConfig("rating", null)).toEqual({ ratingMax: 5 }); // default
  expect(parseFieldConfig("number", '{"numberFormat":{"format":"integer"}}')).toEqual({
    numberFormat: { format: "integer" },
  });
  expect(parseFieldConfig("select", '{"options":[{"label":"A","color":null}]}')).toEqual({
    options: [{ label: "A", color: null }],
  });
  expect(parseFieldConfig("text", null)).toEqual({});
});
