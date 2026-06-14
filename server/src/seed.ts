/* seed.ts — provision demo dimensions so the app runs end-to-end on a fresh
   install. Generic e-commerce examples: replace with your own dimensions
   after exploring the demo. Idempotent (safe to re-run). */

import { pgGet, pgRun } from "./pg.ts";
import { pg } from "./env.ts";
import { addDimension, addCanonical } from "./repo.ts";

const COUNTRY_SOURCES = [
  { table: "raw.orders", column: "shipping_country" },
  { table: "raw.shipments", column: "destination_country" },
  { table: "raw.customers", column: "billing_country" },
];

const COUNTRY_CANONICAL = [
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

const PRODUCT_CATEGORY_CANONICAL = [
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

const CUSTOMER_SEGMENT_CANONICAL = [
  { key: "b2c", label: "B2C" },
  { key: "smb", label: "SMB" },
  { key: "enterprise", label: "Enterprise" },
];

const T = "default";

export async function seedDemo(): Promise<void> {
  // Resolve the legacy schema.table sources against the first warehouse database
  // for this tenant. normalizeSource() requires preferences.legacy_default_database_id
  // to be set when the source doesn't carry an explicit databaseId.
  const db = await pgGet<{ id: string }>(
    `SELECT id FROM ${pg("warehouse_database")} ORDER BY added_at LIMIT 1`,
    [],
  );
  if (db) {
    await pgRun(
      `INSERT INTO ${pg("preferences")} (tenant_id, legacy_default_database_id, publish_threshold, suggest_threshold, updated_at)
       VALUES ($1, $2, 95, 80, now())
       ON CONFLICT (tenant_id) DO UPDATE SET legacy_default_database_id = EXCLUDED.legacy_default_database_id`,
      [T, db.id],
    );
  }

  await addDimension("Country", COUNTRY_SOURCES, {}, "u_verify", T);
  await addCanonical("country", COUNTRY_CANONICAL, T);

  await addDimension("Product Category", PRODUCT_CATEGORY_SOURCES, {}, "u_verify", T);
  await addCanonical("product_category", PRODUCT_CATEGORY_CANONICAL, T);

  await addDimension("Customer Segment", CUSTOMER_SEGMENT_SOURCES, {}, "u_verify", T);
  await addCanonical("customer_segment", CUSTOMER_SEGMENT_CANONICAL, T);
}
