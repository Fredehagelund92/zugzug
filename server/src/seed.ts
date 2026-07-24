/* seed.ts — provision demo dimensions so the app runs end-to-end on a fresh
   install. Generic e-commerce examples: replace with your own dimensions
   after exploring the demo. Idempotent (safe to re-run). */

import { pgGet } from "./pg.ts";
import { addDimension, addRecordOne, addSource } from "./repo.ts";

const COUNTRY_SOURCES = [
  { table: "raw.orders", column: "shipping_country" },
  { table: "raw.shipments", column: "destination_country" },
  { table: "raw.customers", column: "billing_country" },
];

const COUNTRY_RECORD = [
  { key: "US", label: "United States" },
  { key: "GB", label: "United Kingdom" },
  { key: "DE", label: "Germany" },
  { key: "FR", label: "France" },
  { key: "ES", label: "Spain" },
  { key: "IT", label: "Italy" },
  { key: "NL", label: "Netherlands" },
  { key: "SE", label: "Sweden" },
  { key: "NO", label: "Norway" },
  { key: "DK", label: "Denmark" },
  { key: "FI", label: "Finland" },
  { key: "PL", label: "Poland" },
  { key: "BR", label: "Brazil" },
  { key: "IN", label: "India" },
  { key: "JP", label: "Japan" },
  { key: "AU", label: "Australia" },
  { key: "CA", label: "Canada" },
];

const PRODUCT_CATEGORY_SOURCES = [
  { table: "raw.orders", column: "product_category" },
  { table: "raw.products", column: "category" },
];

const PRODUCT_CATEGORY_RECORD = [
  { key: "electronics", label: "Electronics" },
  { key: "clothing", label: "Clothing" },
  { key: "home", label: "Home & Garden" },
  { key: "books", label: "Books" },
  { key: "groceries", label: "Groceries" },
  { key: "toys", label: "Toys & Games" },
  { key: "beauty", label: "Beauty" },
  { key: "sports", label: "Sports & Outdoors" },
];

const CUSTOMER_SEGMENT_SOURCES = [
  { table: "raw.customers", column: "segment" },
  { table: "raw.opportunities", column: "account_segment" },
];

const CUSTOMER_SEGMENT_RECORD = [
  { key: "b2c", label: "B2C" },
  { key: "smb", label: "SMB" },
  { key: "enterprise", label: "Enterprise" },
];

const T = "default";

async function seedDimension(
  name: string,
  dimKey: string,
  sources: Array<{ table: string; column: string }>,
  record: Array<{ key: string; label: string }>,
  hasWarehouse: boolean,
): Promise<void> {
  await addDimension(name, [], {}, "u_verify", T);
  if (hasWarehouse) {
    for (const s of sources) {
      await addSource(dimKey, s.table, s.column, T);
    }
  }
  // Use addRecordOne per record (not the bulk addRecord) so each seeded
  // record gets a record_version row — without it, rename/merge/retire 404
  // ("record not found") because bumpVersionOrThrow finds no version row.
  for (const c of record) {
    await addRecordOne(dimKey, c.label, c.key, "u_verify", T);
  }
}

export async function seedDemo(): Promise<void> {
  // addSource() needs a registered warehouse_database to resolve schema.table.
  // In dev without ATTACH_WAREHOUSE, skip source attachment.
  const hasWarehouse =
    (await pgGet<{ id: string }>(`SELECT id FROM "zugzug_app"."warehouse_database" LIMIT 1`)) !=
    null;
  await seedDimension("Country", "country", COUNTRY_SOURCES, COUNTRY_RECORD, hasWarehouse);
  await seedDimension(
    "Product Category",
    "product_category",
    PRODUCT_CATEGORY_SOURCES,
    PRODUCT_CATEGORY_RECORD,
    hasWarehouse,
  );
  await seedDimension(
    "Customer Segment",
    "customer_segment",
    CUSTOMER_SEGMENT_SOURCES,
    CUSTOMER_SEGMENT_RECORD,
    hasWarehouse,
  );
}
