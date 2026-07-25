/* seed.ts — the demo dataset.
 *
 * A purely fictional company's warehouse master data, built to show off
 * everything at once: governed reference tables with typed columns (text,
 * number, boolean, date, select, linked) and a self-referencing hierarchy,
 * plus live value-mapping where messy source values get reconciled to approved
 * records across three states — published, in review, and still unmapped.
 *
 * Nothing here is real. Company and vendor names are invented. Runs once on a
 * fresh install (bootstrap only). Idempotent-ish. */

import {
  addRefTable,
  addRecordOne,
  addField,
  setFieldValue,
  saveDraft,
  commit,
  addSource,
  scanOneDim,
} from "./repo.ts";
import { materializeSourceScanValues } from "./repo-source-scan.ts";
import { addWarehouseDatabase } from "./repo-warehouse.ts";
import { basename } from "node:path";
import { env } from "./env.ts";

const T = "default";
// Attribute demo activity to the seeded demo team (bootstrap.ts seeds Ada/Li/Cory)
// so Review and Activity show real reviewers instead of "Unknown". Ada authors the
// governed tables and published mappings; Li and Cory own the pending-review drafts.
const U = "u_ada";
const LI = "u_li";
const CORY = "u_cory";

// ── tiny helpers over the repo primitives ───────────────────────────────────

async function table(name: string): Promise<string> {
  return (await addRefTable(name, [], {}, U, T)) as string; // returns the slug id
}

async function field(
  ref: string,
  label: string,
  type: string,
  opts: { options?: string[]; ref?: string; required?: boolean } = {},
): Promise<string> {
  const options = opts.options?.map((l) => ({ label: l, color: null }));
  const r = await addField(
    ref,
    label,
    type,
    options,
    {
      referencedRefTableId: opts.ref,
      displayFields: opts.ref ? ["label"] : undefined,
      required: opts.required,
    },
    U,
    T,
  );
  return r!.field;
}

const rec = (ref: string, key: string, label: string) => addRecordOne(ref, label, key, U, T);
const val = (ref: string, key: string, f: string, v: string | null) =>
  setFieldValue(ref, key, f, v, U, T);

const inject = (ref: string, tbl: string, col: string, vals: Array<[string, number]>) =>
  materializeSourceScanValues(ref, T, {
    occurrences: vals.map(([raw, rows]) => ({ raw, table: tbl, column: col, rows })),
    scannedAt: new Date(),
  });

const map = (ref: string, raw: string, key: string, label: string, by: string = U) =>
  saveDraft(ref, raw, "mapped", label, key, by, T);
const publish = (ref: string) => commit(ref, U, T);

// Populate a table's source values for value-mapping. With the bundled local
// DuckDB warehouse attached, wire the real column and scan it; otherwise inject
// the same values directly so Review is still populated.
async function populate(
  ref: string,
  schemaTable: string,
  column: string,
  fallback: Array<[string, number]>,
): Promise<void> {
  if (env.warehouseAdapter === "duckdb") {
    await addSource(ref, schemaTable, column, T);
    await scanOneDim(ref, T);
  } else {
    await inject(ref, schemaTable, column, fallback);
  }
}

// ── the dataset ──────────────────────────────────────────────────────────────

export async function seedDemo(): Promise<void> {
  // If the bundled local DuckDB warehouse is attached, register it so sources
  // resolve against it (its catalog name is the file stem).
  if (env.warehouseAdapter === "duckdb" && env.duckWarehousePath) {
    const dbName = basename(env.duckWarehousePath).replace(/\.duckdb$/i, "");
    try {
      await addWarehouseDatabase({ databaseName: dbName, label: "Demo warehouse", actorUserId: U });
    } catch {
      /* already registered on a prior boot — fine */
    }
  }

  // 1. Currency — a plain governed list with typed attributes.
  const currency = await table("Currency");
  const cSymbol = await field(currency, "Symbol", "text");
  const cDecimals = await field(currency, "Decimals", "number");
  const currencies: Array<[string, string, string, string]> = [
    ["usd", "US Dollar", "$", "2"],
    ["eur", "Euro", "€", "2"],
    ["gbp", "Pound Sterling", "£", "2"],
    ["sek", "Swedish Krona", "kr", "2"],
    ["nok", "Norwegian Krone", "kr", "2"],
    ["dkk", "Danish Krone", "kr", "2"],
    ["jpy", "Japanese Yen", "¥", "0"],
    ["cad", "Canadian Dollar", "$", "2"],
    ["aud", "Australian Dollar", "$", "2"],
    ["brl", "Brazilian Real", "R$", "2"],
    ["inr", "Indian Rupee", "₹", "2"],
  ];
  for (const [key, label, sym, dec] of currencies) {
    await rec(currency, key, label);
    await val(currency, key, cSymbol, sym);
    await val(currency, key, cDecimals, dec);
  }

  // 2. Region — a self-referencing hierarchy (World › EMEA › Nordics …).
  const region = await table("Region");
  const rParent = await field(region, "Parent", "linked", { ref: region });
  const regions: Array<[string, string, string | null]> = [
    ["world", "World", null],
    ["emea", "EMEA", "world"],
    ["americas", "Americas", "world"],
    ["apac", "APAC", "world"],
    ["nordics", "Nordics", "emea"],
    ["dach", "DACH", "emea"],
    ["benelux", "Benelux", "emea"],
    ["north_america", "North America", "americas"],
    ["latam", "Latin America", "americas"],
    ["south_asia", "South Asia", "apac"],
    ["oceania", "Oceania", "apac"],
  ];
  for (const [key, label] of regions) await rec(region, key, label);
  for (const [key, , parent] of regions) if (parent) await val(region, key, rParent, parent);

  // 3. Country — linked to Region + Currency, plus a boolean and a code.
  //    This one also demonstrates value-mapping: messy country strings → records.
  const country = await table("Country");
  const coIso = await field(country, "ISO-3", "text");
  const coRegion = await field(country, "Region", "linked", { ref: region });
  const coCurrency = await field(country, "Currency", "linked", { ref: currency });
  const coEu = await field(country, "EU member", "boolean");
  const countries: Array<[string, string, string, string, string, string]> = [
    // key, label, iso3, region, currency, eu
    ["us", "United States", "USA", "north_america", "usd", "false"],
    ["gb", "United Kingdom", "GBR", "emea", "gbp", "false"],
    ["de", "Germany", "DEU", "dach", "eur", "true"],
    ["fr", "France", "FRA", "emea", "eur", "true"],
    ["es", "Spain", "ESP", "emea", "eur", "true"],
    ["it", "Italy", "ITA", "emea", "eur", "true"],
    ["nl", "Netherlands", "NLD", "benelux", "eur", "true"],
    ["se", "Sweden", "SWE", "nordics", "sek", "true"],
    ["no", "Norway", "NOR", "nordics", "nok", "false"],
    ["dk", "Denmark", "DNK", "nordics", "dkk", "true"],
    ["fi", "Finland", "FIN", "nordics", "eur", "true"],
    ["br", "Brazil", "BRA", "latam", "brl", "false"],
    ["in", "India", "IND", "south_asia", "inr", "false"],
    ["jp", "Japan", "JPN", "apac", "jpy", "false"],
    ["au", "Australia", "AUS", "oceania", "aud", "false"],
    ["ca", "Canada", "CAN", "north_america", "cad", "false"],
  ];
  for (const [key, label, iso, reg, cur, eu] of countries) {
    await rec(country, key, label);
    await val(country, key, coIso, iso);
    await val(country, key, coRegion, reg);
    await val(country, key, coCurrency, cur);
    await val(country, key, coEu, eu);
  }
  // Messy country strings scanned from the warehouse.
  await populate(country, "raw.orders", "shipping_country", [
    ["United States", 41204],
    ["USA", 18800],
    ["U.S.A.", 2140],
    ["US", 9302],
    ["United Kingdom", 12050],
    ["UK", 6721],
    ["Great Britain", 880],
    ["Deutschland", 3120],
    ["Germany", 7740],
    ["The Netherlands", 410],
    ["Nederland", 220],
    ["Brasil", 1502],
    ["México", 640], // deliberately unmapped — no Mexico record yet
    ["Österreich", 305], // unmapped
  ]);
  // Some published, some left as in-review drafts.
  for (const [raw, key, label] of [
    ["United States", "us", "United States"],
    ["USA", "us", "United States"],
    ["U.S.A.", "us", "United States"],
    ["US", "us", "United States"],
    ["United Kingdom", "gb", "United Kingdom"],
    ["UK", "gb", "United Kingdom"],
    ["Deutschland", "de", "Germany"],
    ["Germany", "de", "Germany"],
  ] as const)
    await map(country, raw, key, label);
  await publish(country); // → the above are live in dim_/map_country
  // These stay as pending drafts (visible in Review as "awaiting publish"):
  await map(country, "Great Britain", "gb", "United Kingdom", LI);
  await map(country, "The Netherlands", "nl", "Netherlands", LI);
  await map(country, "Nederland", "nl", "Netherlands", LI);
  await map(country, "Brasil", "br", "Brazil", CORY);

  // 4. Vendor — the reconciliation hero. Invented company names; messy invoice
  //    strings map to approved vendor records. select + boolean + date columns.
  const vendor = await table("Vendor");
  const vCat = await field(vendor, "Category", "select", {
    options: ["Consulting", "Cloud", "Agency", "SaaS", "Logistics"],
  });
  const vTier = await field(vendor, "Tier", "select", {
    options: ["Strategic", "Preferred", "Standard"],
  });
  const vActive = await field(vendor, "Active", "boolean");
  const vSince = await field(vendor, "Onboarded", "date");
  const vendors: Array<[string, string, string, string, string, string]> = [
    // key, label, category, tier, active, onboarded
    ["vantage_partners", "Vantage Partners", "Consulting", "Strategic", "true", "2021-03-14"],
    ["northgate_advisory", "Northgate Advisory", "Consulting", "Preferred", "true", "2022-07-02"],
    ["brightpath", "Brightpath Consulting", "Consulting", "Standard", "true", "2023-01-19"],
    ["cobalt_cloud", "Cobalt Cloud", "Cloud", "Strategic", "true", "2020-11-05"],
    ["meridian_systems", "Meridian Systems", "Cloud", "Preferred", "true", "2021-09-22"],
    ["cascade_digital", "Cascade Digital", "Agency", "Preferred", "true", "2022-02-11"],
    ["beacon_studio", "Beacon Studio", "Agency", "Standard", "false", "2019-06-30"],
    ["trellis_software", "Trellis Software", "SaaS", "Preferred", "true", "2023-05-08"],
    ["fathom_data", "Fathom Data", "SaaS", "Standard", "true", "2023-08-16"],
    ["harborline", "Harborline Logistics", "Logistics", "Standard", "true", "2021-12-01"],
    ["ironwood_group", "Ironwood Group", "Consulting", "Standard", "false", "2018-04-27"],
    ["solstice_analytics", "Solstice Analytics", "SaaS", "Standard", "true", "2024-01-30"],
  ];
  for (const [key, label, cat, tier, active, since] of vendors) {
    await rec(vendor, key, label);
    await val(vendor, key, vCat, cat);
    await val(vendor, key, vTier, tier);
    await val(vendor, key, vActive, active);
    await val(vendor, key, vSince, since);
  }
  await populate(vendor, "raw.invoices", "vendor_name", [
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
    ["Acme Facilities", 320], // unmapped — no matching record
    ["Blue Ocean Freight", 205], // unmapped
  ]);
  for (const [raw, key, label] of [
    ["Vantage Partners", "vantage_partners", "Vantage Partners"],
    ["Vantage Partners LLC", "vantage_partners", "Vantage Partners"],
    ["Vantage", "vantage_partners", "Vantage Partners"],
    ["Cobalt Cloud", "cobalt_cloud", "Cobalt Cloud"],
    ["Cobalt Cloud, Inc.", "cobalt_cloud", "Cobalt Cloud"],
    ["COBALT", "cobalt_cloud", "Cobalt Cloud"],
    ["Meridian Systems", "meridian_systems", "Meridian Systems"],
    ["Cascade Digital", "cascade_digital", "Cascade Digital"],
    ["Cascade Digital Agency", "cascade_digital", "Cascade Digital"],
  ] as const)
    await map(vendor, raw, key, label);
  await publish(vendor);
  // Pending in Review:
  await map(vendor, "vantage prtnrs", "vantage_partners", "Vantage Partners", CORY);
  await map(vendor, "Meridian Sys", "meridian_systems", "Meridian Systems", CORY);
  await map(vendor, "Trellis Software", "trellis_software", "Trellis Software", LI);
  await map(vendor, "Trellis", "trellis_software", "Trellis Software", LI);
  await map(vendor, "Northgate Advisory", "northgate_advisory", "Northgate Advisory", CORY);

  // 5. Marketing Channel — another value-mapping table (fb/google sprawl).
  const channel = await table("Marketing Channel");
  const chType = await field(channel, "Type", "select", {
    options: ["Paid", "Owned", "Earned"],
  });
  const chPaid = await field(channel, "Paid", "boolean");
  const channels: Array<[string, string, string, string]> = [
    ["paid_search", "Paid Search", "Paid", "true"],
    ["paid_social", "Paid Social", "Paid", "true"],
    ["display", "Display", "Paid", "true"],
    ["email", "Email", "Owned", "false"],
    ["organic_search", "Organic Search", "Earned", "false"],
    ["referral", "Referral", "Earned", "false"],
    ["direct", "Direct", "Owned", "false"],
  ];
  for (const [key, label, type, paid] of channels) {
    await rec(channel, key, label);
    await val(channel, key, chType, type);
    await val(channel, key, chPaid, paid);
  }
  await populate(channel, "marketing.ad_spend", "channel", [
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
    ["bing", 1200], // unmapped
    ["tiktok", 5400], // unmapped
  ]);
  for (const [raw, key, label] of [
    ["google", "organic_search", "Organic Search"],
    ["google ads", "paid_search", "Paid Search"],
    ["adwords", "paid_search", "Paid Search"],
    ["fb", "paid_social", "Paid Social"],
    ["facebook", "paid_social", "Paid Social"],
    ["meta", "paid_social", "Paid Social"],
    ["(direct)", "direct", "Direct"],
  ] as const)
    await map(channel, raw, key, label);
  await publish(channel);
  await map(channel, "facebook ads", "paid_social", "Paid Social", LI);
  await map(channel, "newsletter", "email", "Email", CORY);
  await map(channel, "email", "email", "Email", CORY);

  // 6. Subscription Plan — a small governed list with numbers + boolean.
  const plan = await table("Subscription Plan");
  const pPrice = await field(plan, "Monthly price", "number");
  const pSeats = await field(plan, "Included seats", "number");
  const pActive = await field(plan, "Active", "boolean");
  const plans: Array<[string, string, string, string, string]> = [
    ["free", "Free", "0", "1", "true"],
    ["starter", "Starter", "29", "3", "true"],
    ["growth", "Growth", "99", "10", "true"],
    ["scale", "Scale", "299", "25", "true"],
    ["enterprise", "Enterprise", "0", "0", "true"], // custom pricing
    ["legacy_pro", "Legacy Pro", "149", "15", "false"],
  ];
  for (const [key, label, price, seats, active] of plans) {
    await rec(plan, key, label);
    await val(plan, key, pPrice, price);
    await val(plan, key, pSeats, seats);
    await val(plan, key, pActive, active);
  }

  // 7. Department — cost centers, the finance-close kind of governed list.
  const dept = await table("Department");
  const dCc = await field(dept, "Cost center", "text");
  const dLead = await field(dept, "Lead", "text");
  const depts: Array<[string, string, string, string]> = [
    ["eng", "Engineering", "CC-1000", "Priya Nair"],
    ["product", "Product", "CC-1100", "Diego Fuentes"],
    ["design", "Design", "CC-1200", "Maya Okafor"],
    ["data", "Data & Analytics", "CC-1300", "Tom Lindqvist"],
    ["sales", "Sales", "CC-2000", "Hannah Weber"],
    ["marketing", "Marketing", "CC-2100", "Sofia Rossi"],
    ["success", "Customer Success", "CC-2200", "Kenji Watanabe"],
    ["finance", "Finance", "CC-3000", "Amara Diallo"],
    ["people", "People", "CC-3100", "Lucas Meyer"],
    ["ops", "Operations", "CC-3200", "Ines Almeida"],
  ];
  for (const [key, label, cc, lead] of depts) {
    await rec(dept, key, label);
    await val(dept, key, dCc, cc);
    await val(dept, key, dLead, lead);
  }
}
