/* seed-warehouse.ts — generate the bundled DEMO warehouse.
 *
 * Writes a local DuckDB file (env.duckWarehousePath) with a small, purely
 * fictional warehouse: multiple schemas and tables whose columns hold the messy
 * real-world variants a team actually has to reconcile. The demo attaches this
 * file read-only, so visitors can browse the catalog, wire a source column, and
 * run a real scan.
 *
 * Idempotent: if the warehouse is already populated it does nothing, so it
 * survives the nightly demo reset (which only wipes Postgres). */

import { DuckDBInstance } from "@duckdb/node-api";

// [variant, row-count] — the count becomes the frequency shown in Review.
type Weighted = ReadonlyArray<readonly [string, number]>;

const SHIPPING_COUNTRY: Weighted = [
  ["United States", 41204],
  ["USA", 18800],
  ["U.S.A.", 2140],
  ["US", 9302],
  ["United Kingdom", 12050],
  ["UK", 6721],
  ["Great Britain", 880],
  ["Deutschland", 3120],
  ["Germany", 7740],
  ["France", 5210],
  ["Netherlands", 2900],
  ["The Netherlands", 410],
  ["Nederland", 220],
  ["Sweden", 1980],
  ["Brasil", 1502],
  ["México", 640],
  ["Österreich", 305],
];

const VENDOR_NAME: Weighted = [
  ["Vantage Partners", 4102],
  ["Vantage Partners LLC", 880],
  ["Vantage", 640],
  ["vantage prtnrs", 91],
  ["Cobalt Cloud", 3300],
  ["Cobalt Cloud, Inc.", 610],
  ["COBALT", 210],
  ["Meridian Systems", 2140],
  ["Meridian Sys", 402],
  ["Cascade Digital", 1870],
  ["Cascade Digital Agency", 305],
  ["Beacon Studio", 540],
  ["Trellis Software", 1230],
  ["Trellis", 210],
  ["Northgate Advisory", 980],
  ["Northgate", 140],
  ["Acme Facilities", 320],
  ["Blue Ocean Freight", 205],
];

const UTM_SOURCE: Weighted = [
  ["google", 88200],
  ["google ads", 12400],
  ["adwords", 3100],
  ["fb", 41000],
  ["facebook", 15600],
  ["meta", 4300],
  ["facebook ads", 2100],
  ["newsletter", 9800],
  ["email", 6400],
  ["(direct)", 33000],
  ["bing", 1200],
  ["tiktok", 5400],
];

const CURRENCY_CODE: Weighted = [
  ["USD", 52000],
  ["US Dollar", 3100],
  ["$", 900],
  ["EUR", 41000],
  ["Euro", 2200],
  ["€", 610],
  ["GBP", 12000],
  ["£", 340],
  ["SEK", 4100],
];

const AMOUNT = "round((random()*480+20)::DECIMAL(10,2), 2)";
const A_DATE = "(DATE '2024-01-01' + (random()*330)::INT)";

// One INSERT per variant: range(count) rows carrying the variant + extra columns.
// `extras` is [columnName, valueExpr] pairs.
function fill(
  table: string,
  messyCol: string,
  extras: ReadonlyArray<readonly [string, string]>,
  variants: Weighted,
): string[] {
  const cols = [messyCol, ...extras.map(([c]) => c)].join(", ");
  return variants.map(([raw, n]) => {
    const vals = [`'${raw.replace(/'/g, "''")}'`, ...extras.map(([, e]) => e)].join(", ");
    return `INSERT INTO ${table} (${cols}) SELECT ${vals} FROM range(${n});`;
  });
}

export async function generateDemoWarehouse(path: string): Promise<void> {
  const inst = await DuckDBInstance.create(path);
  const conn = await inst.connect();
  try {
    // Already populated? (survives nightly reset — Postgres is wiped, this isn't.)
    const existing = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'raw'`,
    );
    const n = Number((existing.getRows()[0]?.[0] as bigint | number | null) ?? 0);
    if (n > 0) return;

    await conn.run(`CREATE SCHEMA IF NOT EXISTS raw`);
    await conn.run(`CREATE SCHEMA IF NOT EXISTS finance`);
    await conn.run(`CREATE SCHEMA IF NOT EXISTS marketing`);

    // raw.orders — shipping_country is the messy column.
    await conn.run(
      `CREATE TABLE raw.orders (shipping_country VARCHAR, order_total DECIMAL(10,2), ordered_at DATE)`,
    );
    for (const s of fill(
      "raw.orders",
      "shipping_country",
      [
        ["order_total", AMOUNT],
        ["ordered_at", A_DATE],
      ],
      SHIPPING_COUNTRY,
    ))
      await conn.run(s);

    // raw.invoices — vendor_name is the messy column.
    await conn.run(
      `CREATE TABLE raw.invoices (vendor_name VARCHAR, amount DECIMAL(10,2), invoiced_at DATE)`,
    );
    for (const s of fill(
      "raw.invoices",
      "vendor_name",
      [
        ["amount", AMOUNT],
        ["invoiced_at", A_DATE],
      ],
      VENDOR_NAME,
    ))
      await conn.run(s);

    // raw.web_sessions — utm_source is the messy column.
    await conn.run(`CREATE TABLE raw.web_sessions (utm_source VARCHAR, landing_at DATE)`);
    for (const s of fill("raw.web_sessions", "utm_source", [["landing_at", A_DATE]], UTM_SOURCE))
      await conn.run(s);

    // finance.transactions — currency_code is the messy column (second schema).
    await conn.run(
      `CREATE TABLE finance.transactions (currency_code VARCHAR, amount DECIMAL(10,2), booked_at DATE)`,
    );
    for (const s of fill(
      "finance.transactions",
      "currency_code",
      [
        ["amount", AMOUNT],
        ["booked_at", A_DATE],
      ],
      CURRENCY_CODE,
    ))
      await conn.run(s);

    // marketing.ad_spend — extra table so the catalog has breadth.
    await conn.run(
      `CREATE TABLE marketing.ad_spend (channel VARCHAR, cost DECIMAL(10,2), spend_date DATE)`,
    );
    for (const s of fill(
      "marketing.ad_spend",
      "channel",
      [
        ["cost", AMOUNT],
        ["spend_date", A_DATE],
      ],
      UTM_SOURCE,
    ))
      await conn.run(s);
  } finally {
    conn.disconnectSync();
  }
}
