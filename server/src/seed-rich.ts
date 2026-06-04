/* one-shot enrichment seed — add attribute columns + values to the demo
   dimensions so the Master-lists grid shows off select chips, number/boolean
   cells, etc. Idempotent: tries to add columns, ignores conflicts. */

import { addField, addColumnOption, setFieldValue } from "./repo.ts";
import type { OptionDef } from "./repo.ts";

async function ensureField(dimId: string, label: string, type: string, options?: string[]) {
  try {
    const opts: OptionDef[] | undefined = options?.map((label) => ({ label, color: null }));
    const r = await addField(dimId, label, type, opts);
    return r?.field ?? label.toLowerCase().replace(/\s+/g, "_");
  } catch {
    return label.toLowerCase().replace(/\s+/g, "_");
  }
}

async function ensureOption(dimId: string, field: string, label: string) {
  try { await addColumnOption(dimId, field, label); } catch { /* exists */ }
}

const COUNTRY_REGIONS: Record<string, string> = {
  US: "Americas", CA: "Americas", BR: "Americas",
  GB: "EMEA", DE: "EMEA", FR: "EMEA", ES: "EMEA", IT: "EMEA",
  NL: "EMEA", SE: "EMEA", NO: "EMEA", DK: "EMEA", FI: "EMEA", PL: "EMEA",
  IN: "APAC", JP: "APAC", AU: "APAC",
};
const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", BR: "BRL",
  GB: "GBP", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR",
  NL: "EUR", SE: "SEK", NO: "NOK", DK: "DKK", FI: "EUR", PL: "PLN",
  IN: "INR", JP: "JPY", AU: "AUD",
};
const COUNTRY_TIER: Record<string, number> = {
  US: 1, GB: 1, DE: 1, FR: 1, JP: 1, AU: 1, CA: 1,
  ES: 2, IT: 2, NL: 2, SE: 2, NO: 2, DK: 2, FI: 2, BR: 2,
  PL: 3, IN: 3,
};
const COUNTRY_GDPR: Record<string, boolean> = {
  GB: true, DE: true, FR: true, ES: true, IT: true,
  NL: true, SE: true, NO: true, DK: true, FI: true, PL: true,
  US: false, CA: false, BR: false, IN: false, JP: false, AU: false,
};

const CHANNEL_PAID: Record<string, boolean> = {
  paid_search: true, paid_social: true, display: true, affiliate: true,
  organic: false, email: false, direct: false,
};
const CHANNEL_FUNNEL: Record<string, string> = {
  paid_search: "Mid", paid_social: "Top", display: "Top",
  affiliate: "Bottom", organic: "Top", email: "Bottom", direct: "Bottom",
};

console.log("· enriching demo dimensions with attribute columns + values\n");

// Country
const regionField   = await ensureField("country", "Region", "select", ["EMEA", "Americas", "APAC"]);
const currencyField = await ensureField("country", "Currency", "select", ["USD","EUR","GBP","SEK","NOK","DKK","PLN","BRL","INR","JPY","AUD","CAD"]);
const tierField     = await ensureField("country", "Tier", "number");
const gdprField     = await ensureField("country", "GDPR", "boolean");

for (const opt of new Set(Object.values(COUNTRY_REGIONS)))   await ensureOption("country", regionField, opt);
for (const opt of new Set(Object.values(COUNTRY_CURRENCY))) await ensureOption("country", currencyField, opt);

for (const [key, v] of Object.entries(COUNTRY_REGIONS))   await setFieldValue("country", key, regionField, v);
for (const [key, v] of Object.entries(COUNTRY_CURRENCY))  await setFieldValue("country", key, currencyField, v);
for (const [key, v] of Object.entries(COUNTRY_TIER))      await setFieldValue("country", key, tierField, String(v));
for (const [key, v] of Object.entries(COUNTRY_GDPR))      await setFieldValue("country", key, gdprField, v ? "true" : "false");

console.log("  Country: +Region (select), +Currency (select), +Tier (number), +GDPR (boolean)");

// Channel
const funnelField = await ensureField("channel", "Funnel stage", "select", ["Top", "Mid", "Bottom"]);
const paidField   = await ensureField("channel", "Paid", "boolean");

for (const opt of new Set(Object.values(CHANNEL_FUNNEL))) await ensureOption("channel", funnelField, opt);
for (const [key, v] of Object.entries(CHANNEL_FUNNEL))    await setFieldValue("channel", key, funnelField, v);
for (const [key, v] of Object.entries(CHANNEL_PAID))      await setFieldValue("channel", key, paidField, v ? "true" : "false");

console.log("  Channel: +Funnel stage (select), +Paid (boolean)");

console.log("\nDone. Reload /app/tables to see the chips.");
process.exit(0);
