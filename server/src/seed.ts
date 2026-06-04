/* seed.ts — provision demo dimensions in MotherDuck so the app runs end-to-end.
   Grounded in the real bc-dbt warehouse: `country` is a free-text VARCHAR across
   ~20 ad-platform source tables, so it's the flagship reconciliation dimension.
   Canonical starts as a small ISO set; everything else surfaces as "new" to
   reconcile — which is exactly the demo. Idempotent (safe to re-run). */

import { addDimension, addCanonical } from "./repo.ts";

const COUNTRY_SOURCES = [
  { table: "active_revenue.r_statistics", column: "country" },
  { table: "adcash.r_advertiser_report", column: "country" },
  { table: "adform.r_bids", column: "country" },
  { table: "pushground.r_statistics", column: "country" },
  { table: "similarweb.r_total_traffic_visits", column: "country" },
  { table: "smadex.r_report", column: "country" },
  { table: "taboola.r_reporting", column: "country" },
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

const CHANNEL_SOURCES = [
  { table: "appsflyer.r_installs", column: "channel" },
  { table: "appsflyer.r_in_app_events", column: "channel" },
  { table: "salesforce.r_commercial_link", column: "channel" },
];

const CHANNEL_CANONICAL = [
  { key: "paid_search", label: "Paid Search" },
  { key: "paid_social", label: "Paid Social" },
  { key: "organic", label: "Organic" },
  { key: "display", label: "Display" },
  { key: "affiliate", label: "Affiliate" },
  { key: "email", label: "Email" },
  { key: "direct", label: "Direct" },
];

export async function seedDemo(): Promise<void> {
  await addDimension("Country", COUNTRY_SOURCES, {}, "u_verify");
  await addCanonical("country", COUNTRY_CANONICAL);

  await addDimension("Channel", CHANNEL_SOURCES, {}, "u_verify");
  await addCanonical("channel", CHANNEL_CANONICAL);
}
