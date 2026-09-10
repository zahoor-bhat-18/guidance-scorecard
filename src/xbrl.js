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

/**
 * fy and fp cannot be trusted as a fact's period.
 *
 * In companyfacts they describe the REPORT the fact was filed in, not the
 * period the fact covers. A 10-Q for FY2026 Q1 also carries last year's
 * comparative column, and both rows come back tagged fy 2026, fp Q1 - so
 * Macy's quarter ending May 2025 arrived labelled 2026Q1. Every match built on
 * that would be a year out.
 *
 * The dates are reliable, so the period is derived from them instead: which
 * fiscal year the end date falls in, and which quarter of it.
 */

/** The company's fiscal year end, as month and day, from EDGAR. */
async function fiscalYearEnd(env, cik) {
  const subs = await secJson(env, "https://data.sec.gov/submissions/CIK" + cik + ".json");
  const raw = String(subs.fiscalYearEnd || "").replace(/[^0-9]/g, "");
  const name = subs.name || "";
  if (!/^\d{4}$/.test(raw)) return { month: 12, day: 31, name };
  return { month: parseInt(raw.slice(0, 2), 10), day: parseInt(raw.slice(2), 10), name };
}

/**
 * Which fiscal year does a date fall in, and which quarter of it?
 *
 * Returned as the calendar year the fiscal year ENDS in, plus a quarter
 * number. Turning that into the company's own label needs one more step,
 * because the conventions disagree: Macy's FY2025 ends January 2026, while
 * Autodesk's FY2027 also ends January 2027. Nothing in a date says which.
 */
function fiscalPosition(endDate, fye) {
  const d = new Date(endDate + "T00:00:00Z");
  const y = d.getUTCFullYear();

  // The fiscal year end on or after this date.
  let endsIn = y;
  const thisYearEnd = Date.UTC(y, fye.month - 1, fye.day);
  // A week either side, because a 52/53-week filer's year end moves.
  if (d.getTime() > thisYearEnd + 8 * 86400000) endsIn = y + 1;

  const yearEnd = Date.UTC(endsIn, fye.month - 1, fye.day);
  const yearStart = Date.UTC(endsIn - 1, fye.month - 1, fye.day);
  const through = (d.getTime() - yearStart) / (yearEnd - yearStart);
  const quarter = Math.min(4, Math.max(1, Math.round(through * 4)));

  return { endsIn, quarter };
}

/**
 * Does this filer label a fiscal year by the year it starts or the year it
 * ends?
 *
 * There is no rule. Macy's year ending January 2026 is its fiscal 2025;
 * Autodesk's year ending January 2027 is its fiscal 2027. Nothing in a date
 * distinguishes them, and fy in companyfacts cannot help - it is the year of
 * the REPORT, which is what sent the first two attempts at this a year out.
 *
 * The company states its own answer. DocumentFiscalYearFocus, in the dei
 * section of the same document, is the label it puts on the report. Pairing
 * that with the period end gives the offset directly, with nothing inferred.
 *
 * Where dei is absent, the fallback is where most of the year falls: a year
 * running February to January is eleven months in the earlier calendar year.
 * That is right for Macy's and wrong for Autodesk, which is why it is only a
 * fallback and why the answer is reported in _meta for checking.
 */
function learnLabelOffset(dei, fye) {
  const node = dei && dei.DocumentFiscalYearFocus;
  if (node && node.units) {
    for (const facts of Object.values(node.units)) {
      // Newest first: a company that changed its convention should be read on
      // its current one.
      const sorted = facts.slice().sort((a, b) => (a.end < b.end ? 1 : -1));
      for (const f of sorted) {
        if (f.form !== "10-K" || !f.end) continue;
        const label = parseInt(f.val, 10);
        if (!Number.isFinite(label)) continue;
        const { endsIn } = fiscalPosition(f.end, fye);
        const offset = endsIn - label;
        if (offset === 0 || offset === 1) return { offset, source: "DocumentFiscalYearFocus" };
      }
    }
  }

  // Fallback: whichever calendar year holds most of the fiscal year.
  if (fye.month === 12) return { offset: 0, source: "calendar year end" };
  return { offset: fye.month <= 6 ? 1 : 0, source: "assumed from the year end month" };
}

/**
 * The company's calendar, on its own.
 *
 * ADDED, and additive only: nothing below is changed. The period normaliser
 * needs the same two facts every fact here is labelled with - where the
 * fiscal year ends, and whether the company names a year by its start or its
 * end - and it has to get them from the same place, or a guide and an actual
 * for the same period end up with different labels and never match.
 *
 * It refetches companyfacts rather than threading the values out of
 * factsFor(). EDGAR is cached for a day, so the second request is nearly free,
 * and factsFor() is proven and left alone.
 */
export async function companyCalendar(env, cik) {
  const url = "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json";
  const [doc, fye] = await Promise.all([secJson(env, url), fiscalYearEnd(env, cik)]);
  const dei = (doc.facts && doc.facts.dei) || {};
  const convention = learnLabelOffset(dei, fye);

  return {
    fye: { month: fye.month, day: fye.day },
    labelOffset: convention.offset,
    meta: {
      fiscalYearEnd:
        String(fye.month).padStart(2, "0") + "/" + String(fye.day).padStart(2, "0"),
      labelConvention: convention.offset === 1
        ? "fiscal year is labelled by the year it STARTS in"
        : "fiscal year is labelled by the year it ENDS in",
      conventionFrom: convention.source,
    },
  };
}

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
  const [doc, fye] = await Promise.all([secJson(env, url), fiscalYearEnd(env, cik)]);
  const us = (doc.facts && doc.facts["us-gaap"]) || {};
  const dei = (doc.facts && doc.facts.dei) || {};
  const convention = learnLabelOffset(dei, fye);
  const labelOffset = convention.offset;

  const out = {};   // "revenue|2026Q2" -> { value, unit, concept, filed, accession }

  for (const [metric, concepts] of Object.entries(CONCEPTS)) {
    for (const concept of concepts) {
      const node = us[concept];
      if (!node || !node.units) continue;

      for (const [unit, facts] of Object.entries(node.units)) {
        for (const f of facts) {
          if (!f.end || !f.start) continue;
          if (f.form !== "10-Q" && f.form !== "10-K") continue;

          // The period comes from the dates, never from fy and fp.
          const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
          const isYear = days >= 300 && days <= 400;
          const isQuarter = days >= 60 && days <= 120;
          // Anything else is year-to-date or half-year: real figures, but not
          // comparable with a quarterly or annual guide.
          if (!isYear && !isQuarter) continue;

          const pos = fiscalPosition(f.end, fye);
          const label = pos.endsIn - labelOffset;
          const period = isYear ? `${label}FY` : `${label}Q${pos.quarter}`;
          const key = metric + "|" + period;

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

  // Fourth quarter, by subtraction.
  //
  // Companies do not tag Q4. The 10-K reports the full year and Q4 is left
  // implied, so a company guiding Q4 revenue has nothing to match against.
  // The four figures are all filed, so the answer is exact arithmetic rather
  // than an estimate: the year less the three quarters.
  //
  // Only for measures that add up across a year. Earnings per share does not
  // - the share count moves - and a tax rate certainly does not.
  const ADDITIVE = ["revenue", "operating_income", "net_income", "capex", "operating_cash_flow"];
  for (const metric of ADDITIVE) {
    for (const key of Object.keys(out)) {
      if (!key.startsWith(metric + "|") || !key.endsWith("FY")) continue;
      const year = key.split("|")[1].replace("FY", "");
      const q = [1, 2, 3].map((n) => out[`${metric}|${year}Q${n}`]);
      if (q.some((x) => !x)) continue;
      const fy = out[key];
      const q4key = `${metric}|${year}Q4`;
      if (out[q4key]) continue;
      out[q4key] = {
        metric, period: `${year}Q4`,
        value: fy.value - q.reduce((n, x) => n + x.value, 0),
        unit: fy.unit,
        concept: fy.concept,
        form: fy.form, end: fy.end, filed: fy.filed, accession: fy.accession,
        derived: "full year less Q1, Q2 and Q3",
      };
    }
  }

  // Free cash flow again, so a derived Q4 gets one too.
  for (const key of Object.keys(out)) {
    if (!key.startsWith("operating_cash_flow|")) continue;
    const period = key.split("|")[1];
    if (out["fcf|" + period]) continue;
    const ocf = out[key], capex = out["capex|" + period];
    if (!capex) continue;
    out["fcf|" + period] = {
      metric: "fcf", period,
      value: ocf.value - Math.abs(capex.value),
      unit: ocf.unit, concept: ocf.concept + " less " + capex.concept,
      form: ocf.form, end: ocf.end, filed: ocf.filed, accession: ocf.accession,
      derived: "operating cash flow less capital expenditure",
    };
  }

  // Kept OUT of the facts map. It lived inside it and the caller, grouping by
  // rec.metric, produced a metric called "undefined" with one entry.
  const meta = {
    fiscalYearEnd: String(fye.month).padStart(2, "0") + "/" + String(fye.day).padStart(2, "0"),
    labelConvention: labelOffset === 1
      ? "fiscal year is labelled by the year it STARTS in"
      : "fiscal year is labelled by the year it ENDS in",
    conventionFrom: convention.source,
  };

  return { facts: out, meta };
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
