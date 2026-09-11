/**
 * Actuals, from the company's own tagged filings.
 *
 * This is the half of the product that needs no model at all. SEC publishes
 * every figure a company files as XBRL, with the concept, the period and the
 * unit attached. One request per company returns all of it.
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
 * The dates are reliable, so the period is derived from them instead.
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

  let endsIn = y;
  const thisYearEnd = Date.UTC(y, fye.month - 1, fye.day);
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
 * The company states its own answer in dei.DocumentFiscalYearFocus. Pairing
 * that with the period end gives the offset directly, with nothing inferred.
 *
 * TWO CHANGES, both because this kept falling through to the fallback and
 * reporting "assumed from the year end month" on a company whose 10-K clearly
 * carries the tag:
 *
 *   - 10-Q filings are read as well as 10-K. A quarterly report states the
 *     same fiscal year focus, and there are four times as many of them, so a
 *     filer whose annual tag is missing or oddly formed is still covered.
 *   - Every candidate examined is reported in `evidence`, whether it was used
 *     or rejected and why. Guessing at why a detector is silent has cost this
 *     project more time than any other single thing, and the answer is always
 *     the same: make it say what it saw.
 */
function learnLabelOffset(dei, fye) {
  const node = dei && dei.DocumentFiscalYearFocus;
  const evidence = [];

  if (node && node.units) {
    const all = [];
    for (const facts of Object.values(node.units)) {
      for (const f of facts) all.push(f);
    }
    // Newest first: a company that changed convention is read on its current
    // one.
    all.sort((a, b) => (String(a.end || "") < String(b.end || "") ? 1 : -1));

    for (const f of all.slice(0, 12)) {
      const row = { form: f.form, end: f.end, val: f.val };

      if (f.form !== "10-K" && f.form !== "10-Q") {
        row.rejected = "not an annual or quarterly report";
        evidence.push(row);
        continue;
      }
      if (!f.end) {
        row.rejected = "no period end date";
        evidence.push(row);
        continue;
      }

      const label = parseInt(f.val, 10);
      if (!Number.isFinite(label)) {
        row.rejected = "fiscal year focus is not a number";
        evidence.push(row);
        continue;
      }

      const { endsIn } = fiscalPosition(f.end, fye);
      const offset = endsIn - label;
      row.impliedOffset = offset;

      if (offset === 0 || offset === 1) {
        row.used = true;
        evidence.push(row);
        return { offset, source: "DocumentFiscalYearFocus", evidence };
      }

      row.rejected = "implied offset of " + offset + " is not 0 or 1";
      evidence.push(row);
    }
  } else {
    evidence.push({ rejected: "companyfacts carries no dei.DocumentFiscalYearFocus" });
  }

  // Fallback: whichever calendar year holds most of the fiscal year. Right for
  // Macy's and wrong for Autodesk, which is why it is only a fallback and why
  // the answer is reported for checking.
  if (fye.month === 12) return { offset: 0, source: "calendar year end", evidence };
  return { offset: fye.month <= 6 ? 1 : 0, source: "assumed from the year end month", evidence };
}

/**
 * The company's calendar, on its own.
 *
 * The period normaliser needs the same two facts every fact here is labelled
 * with - where the fiscal year ends, and whether the company names a year by
 * its start or its end - and must get them from the same place, or a guide and
 * an actual for the same period end up with different labels and never match.
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
      evidence: convention.evidence,
    },
  };
}

/* Ordered fallbacks per metric. First match wins, so the most specific and
   most modern tag goes first. These lists grow as filers are tested. */
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
  operating_income: ["OperatingIncomeLoss"],
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets",
  ],
  operating_cash_flow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  tax_rate: ["EffectiveIncomeTaxRateContinuingOperations"],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
};

/* Units that mean the same thing. XBRL reports EPS in "USD/shares" and money
   in "USD"; a rate arrives as a decimal fraction, not a percentage. */
function normalise(metric, value, unit) {
  if (metric === "tax_rate") {
    return { value: Math.abs(value) <= 1.5 ? value * 100 : value, unit: "percent" };
  }
  if (unit === "USD/shares") return { value, unit: "USD per share" };
  if (unit === "USD") return { value: value / 1e6, unit: "USD millions" };
  return { value, unit: unit || "" };
}

/**
 * Every usable fact for one company, keyed by metric and fiscal period.
 *
 * A fact is usable when it has a duration matching what the period claims to
 * be - a quarterly tag carrying a year-to-date figure is the single most
 * common way a scorecard reads 300% beats out of nothing.
 */
export async function factsFor(env, cik) {
  const url = "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json";
  const [doc, fye] = await Promise.all([secJson(env, url), fiscalYearEnd(env, cik)]);
  const us = (doc.facts && doc.facts["us-gaap"]) || {};
  const dei = (doc.facts && doc.facts.dei) || {};
  const convention = learnLabelOffset(dei, fye);
  const labelOffset = convention.offset;

  const out = {};

  for (const [metric, concepts] of Object.entries(CONCEPTS)) {
    for (const concept of concepts) {
      const node = us[concept];
      if (!node || !node.units) continue;

      for (const [unit, facts] of Object.entries(node.units)) {
        for (const f of facts) {
          if (!f.end || !f.start) continue;
          if (f.form !== "10-Q" && f.form !== "10-K") continue;

          const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
          const isYear = days >= 300 && days <= 400;
          const isQuarter = days >= 60 && days <= 120;
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

          // Keep the EARLIEST filing of a period, not the latest. XBRL carries
          // every restatement, and a figure restated two years later is not
          // what management was judged against at the time.
          const held = out[key];
          if (!held || rec.filed < held.filed) out[key] = rec;
        }
      }
      if (Object.keys(out).some((k) => k.startsWith(metric + "|"))) break;
    }
  }

  // Free cash flow is not a tag. It is operating cash flow less capex, and
  // both are, so it is derived exactly rather than estimated.
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
      derived: "operating cash flow less capital expenditure",
    };
  }

  // Fourth quarter, by subtraction. Companies do not tag Q4; the 10-K reports
  // the full year and Q4 is left implied. Only for measures that add up across
  // a year - earnings per share does not, because the share count moves.
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

  const meta = {
    fiscalYearEnd: String(fye.month).padStart(2, "0") + "/" + String(fye.day).padStart(2, "0"),
    labelConvention: labelOffset === 1
      ? "fiscal year is labelled by the year it STARTS in"
      : "fiscal year is labelled by the year it ENDS in",
    conventionFrom: convention.source,
    evidence: convention.evidence,
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
