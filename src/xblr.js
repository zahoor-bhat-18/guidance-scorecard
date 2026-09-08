/**
 * Actuals, from the company's own tagged filings.
 *
 * This is the half of the product that needs no model at all. SEC publishes
 * every figure a company files as XBRL, with the concept, the period and the
 * unit attached. One request per company returns all of it.
 *
 * Why it matters: the old version asked the earnings release for actuals, and
 * some are not in the release. Capital expenditure is guided in the release
 * and reported in the cash flow statement, so it could never be matched, and
 * the page said "not reported" about a number filed every quarter.
 *
 * The label is never the thing to match on. A company guides "net sales" and
 * files "RevenueFromContractWithCustomerExcludingAssessedTax". So each metric
 * carries an ORDERED list of concepts and the first one that has a fact for
 * the period wins.
 */

import { secJson } from "./sec.js";

/* Ordered fallbacks per metric. First match wins, so the most specific and
   most modern tag goes first. These lists grow as filers are tested - that is
   expected, and each addition should be recorded against the company that
   needed it. */
export const CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
  ],
  eps_gaap: [
    "EarningsPerShareDiluted",
    "IncomeLossFromContinuingOperationsPerDilutedShare",
  ],
  operating_income: [
    "OperatingIncomeLoss",
  ],
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets",
  ],
  operating_cash_flow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  tax_rate: [
    "EffectiveIncomeTaxRateContinuingOperations",
  ],
  net_income: [
    "NetIncomeLoss",
    "ProfitLoss",
  ],
};

/* Units that mean the same thing. XBRL reports EPS in "USD/shares" and money
   in "USD"; a rate arrives as a decimal fraction, not a percentage. */
function normalise(metric, value, unit) {
  if (metric === "tax_rate") {
    // 0.235 in XBRL is 23.5% in every release ever written.
    return { value: Math.abs(value) <= 1.5 ? value * 100 : value, unit: "percent" };
  }
  if (unit === "USD/shares") return { value, unit: "USD per share" };
  if (unit === "USD") {
    // Canonical money is millions, matching how releases are written.
    return { value: value / 1e6, unit: "USD millions" };
  }
  return { value, unit: unit || "" };
}

/**
 * Every usable fact for one company, keyed by metric and fiscal period.
 *
 * A fact is usable when it has a fiscal year, a fiscal period, and a duration
 * that matches what the period claims to be - a quarterly tag carrying a
 * year-to-date figure is the single most common way a scorecard reads 300%
 * beats out of nothing.
 */
export async function factsFor(env, cik) {
  const url = "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json";
  const doc = await secJson(env, url);
  const us = (doc.facts && doc.facts["us-gaap"]) || {};

  const out = {};   // "revenue|2026Q2" -> { value, unit, concept, filed, accession }

  for (const [metric, concepts] of Object.entries(CONCEPTS)) {
    for (const concept of concepts) {
      const node = us[concept];
      if (!node || !node.units) continue;

      for (const [unit, facts] of Object.entries(node.units)) {
        for (const f of facts) {
          if (!f.fy || !f.fp || !f.end) continue;
          if (f.form !== "10-Q" && f.form !== "10-K") continue;

          const period = f.fp === "FY" ? `${f.fy}FY` : `${f.fy}${f.fp}`;
          const key = metric + "|" + period;

          // Duration check. A quarter is about 90 days, a year about 365.
          // Without this, a year-to-date figure filed under Q3 gets scored
          // against a quarterly guide.
          if (f.start) {
            const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
            const wantYear = f.fp === "FY";
            if (wantYear && (days < 300 || days > 400)) continue;
            if (!wantYear && (days < 60 || days > 120)) continue;
          }

          const norm = normalise(metric, f.val, unit);
          const rec = {
            metric, period,
            value: norm.value, unit: norm.unit,
            concept, form: f.form,
            end: f.end, filed: f.filed, accession: f.accn,
          };

          // Keep the EARLIEST filing of a period, not the latest.
          //
          // XBRL carries every restatement, and a figure restated two years
          // later is not what management was judged against at the time. The
          // guide was answered by what they filed then.
          const held = out[key];
          if (!held || rec.filed < held.filed) out[key] = rec;
        }
      }
      // First concept that produced anything for this metric wins; the rest
      // are fallbacks for filers that do not use it.
      if (Object.keys(out).some((k) => k.startsWith(metric + "|"))) break;
    }
  }

  // Free cash flow is not a tag. It is operating cash flow less capex, and
  // both are, so it can be derived exactly rather than estimated.
  for (const key of Object.keys(out)) {
    if (!key.startsWith("operating_cash_flow|")) continue;
    const period = key.split("|")[1];
    const ocf = out[key];
    const capex = out["capex|" + period];
    if (!capex) continue;
    out["fcf|" + period] = {
      metric: "fcf", period,
      value: ocf.value - Math.abs(capex.value),
      unit: ocf.unit,
      concept: ocf.concept + " less " + capex.concept,
      form: ocf.form, end: ocf.end, filed: ocf.filed, accession: ocf.accession,
      derived: true,
    };
  }

  return out;
}

/** Ticker to CIK, from SEC's own list. */
export async function resolveCik(env, ticker) {
  const map = await secJson(env, "https://www.sec.gov/files/company_tickers.json");
  const want = String(ticker || "").toUpperCase();
  for (const k of Object.keys(map)) {
    if (String(map[k].ticker).toUpperCase() === want) {
      return { cik: String(map[k].cik_str).padStart(10, "0"), name: map[k].title };
    }
  }
  throw new Error("EDGAR has no company registered under " + want + ".");
}
