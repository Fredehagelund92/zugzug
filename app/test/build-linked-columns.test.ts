import { test, expect } from "vitest";
import { buildLinkedColumns } from "../src/components/linked/buildLinkedColumns";
import type { FieldDef } from "../src/data";

const fkField: FieldDef = {
  field: "country",
  label: "Country",
  type: "linked",
  referencedRefTableId: "dim_country",
  displayFields: ["label", "iso_code", "region"],
};

const targetMeta = {
  fieldLabels: new Map<string, string>([
    ["label", "Label"],
    ["iso_code", "ISO Code"],
    ["region", "Region"],
  ]),
  fieldExists: new Set<string>(["label", "iso_code", "region"]),
  candidates: [{ key: "DE", label: "Germany" }],
};

test("FK column carries columnKind 'fk'", () => {
  const [fkCol] = buildLinkedColumns(fkField, targetMeta);
  expect(fkCol.field).toBe("country");
  expect(fkCol.label).toBe("Country");
  expect(fkCol.columnKind).toBe("fk");
  expect(fkCol.config.type).toBe("linked");
});

test("lookup columns are generated for each non-label displayField with kind 'lookup' and sourceField pointing to FK", () => {
  const cols = buildLinkedColumns(fkField, targetMeta);
  expect(cols.length).toBe(3); // FK + iso_code + region
  const iso = cols.find((c) => c.field === "country__iso_code")!;
  expect(iso.columnKind).toBe("lookup");
  expect(iso.sourceField).toBe("country");
  expect(iso.editable).toBe(false);
  expect(iso.label).toBe("Country › ISO Code");
});

test("lookup column for a stale (missing) displayField is marked with a stale flag", () => {
  const staleField: FieldDef = {
    ...fkField,
    displayFields: ["label", "deleted_field"],
  };
  const cols = buildLinkedColumns(staleField, targetMeta);
  const stale = cols.find((c) => c.field === "country__deleted_field")!;
  expect(stale.columnKind).toBe("lookup");
  expect(stale.linkedStale).toBe(true);
  expect(stale.label).toContain("deleted_field"); // fallback to field name
});

test("label-only displayFields produces just the FK column", () => {
  const labelOnly: FieldDef = { ...fkField, displayFields: ["label"] };
  const cols = buildLinkedColumns(labelOnly, targetMeta);
  expect(cols.length).toBe(1);
  expect(cols[0].field).toBe("country");
});

test("FK candidates flow into config.candidates", () => {
  const [fkCol] = buildLinkedColumns(fkField, targetMeta);
  if (fkCol.config.type === "linked") {
    expect(fkCol.config.candidates).toEqual([{ key: "DE", label: "Germany" }]);
    expect(fkCol.config.targetRefTableId).toBe("dim_country");
    expect(fkCol.config.displayFields).toEqual(["label", "iso_code", "region"]);
  } else {
    throw new Error("FK col should be linked");
  }
});
