/**
 * Actuals, from the company's own tagged filings.
 *
 * This is the half of the product that needs no model at all. SEC publishes
 * every figure a company files as XBRL, with the concept, the period and the
 * unit attached.
 *
 * The label is never the thing to match on. A company guides "net sales" and
 * files "RevenueFromContractWithCustomerExcludingAssessedTax". So each metric
 * carries an ORDERED list of concepts and the first with a fact for the period
 * wins.
 */

import { secJson, fetchDoc } from "./sec.js";

/** The company's fiscal year end, as month and day, from EDGAR. */
async function fiscalYearEnd(env, cik) {
  const subs = await secJson(env, "https://data.sec.gov/submissions/CIK" + cik + ".json");
  const raw = String(subs.fiscalYearEnd || "").replace(/[^0-9]/g, "");
  const name = subs.name || "";
  if (!/^\d{4}$/.test(raw)) return { month: 12, day: 31, name };
  return { month: parseInt(raw.slice(0, 2), 10), day: parseInt(raw.slice(2), 10), name };
}

/**
 * fy and fp cannot be trusted as a fact's period.
 *
 * In companyfacts they describe the REPORT the fact was filed in, not the
 * period the fact covers. A 10-Q for FY2026 Q1 also carries last year's
 * comparative column, and both rows come back tagged fy 2026, fp Q1 - so
 * Macy's quarter ending May 2025 arrived labelled 2026Q1.
 *
 * The dates are reliable, so the period is derived from them instead.
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

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Does this filer label a fiscal year by the year it starts or the year it
 * ends, from the company's own cover page?
 *
 * There is no rule and the year-end month settles nothing. Macy's, Walmart and
 * Autodesk all close in late January. Macy's year ending January 2026 is its
 * fiscal 2025. Walmart's year ending January 2027 is its fiscal 2027.
 *
 * Two sources were tried and both are now ruled out by evidence rather than
 * suspicion: companyfacts carries no dei document tags at all, and
 * companyconcept returns 404 for DocumentFiscalYearFocus on every company
 * tested. The guess that replaced them was wrong for Walmart and cost a real
 * scoreable pair - a net sales guide of 4.0-5.0% answered by a reported 5.0%,
 * thrown away because the two sides were labelled a year apart.
 *
 * But the company does state it, on the cover page of its own 10-K. SEC
 * renders that page as R1.htm inside the filing, and it carries Document
 * Fiscal Year Focus and Document Period End Date as adjacent rows. One says
 * the label, the other says when the year ended. The offset is the difference,
 * with nothing inferred and no proximity heuristic involved.
 *
 * A 10-Q cover page carries the same two fields and is used if no 10-K is to
 * hand.
 */
async function latestAnnualFiling(env, cik) {
  const subs = await secJson(env, "https://data.sec.gov/submissions/CIK" + cik + ".json");
  const r = (subs.filings && subs.filings.recent) || {};
  const forms = r.form || [];

  let fallback = null;
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === "10-K") {
      return { accession: r.accessionNumber[i], form: "10-K", filed: r.filingDate[i] };
    }
    if (!fallback && forms[i] === "10-Q") {
      fallback = { accession: r.accessionNumber[i], form: "10-Q", filed: r.filingDate[i] };
    }
  }
  return fallback;
}

/* R1.htm is a rendered table. Rows out, cells spaced, tags gone - enough to
   read two labelled values out of it and no more. */
function coverPageText(html) {
  return html
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
}

async function focusFromCoverPage(env, cik, fye) {
  const filing = await latestAnnualFiling(env, cik);
  if (!filing) {
    return { offset: null, evidence: [{ rejected: "no 10-K or 10-Q found in the submissions index" }] };
  }

  const noDash = filing.accession.replace(/-/g, "");
  const base = "https://www.sec.gov/Archives/edgar/data/" + Number(cik) + "/" + noDash;

  let html;
  try {
    html = await fetchDoc(env, base + "/R1.htm");
  } catch (e) {
    return {
      offset: null,
      evidence: [{ form: filing.form, accession: filing.accession, rejected: "no rendered cover page (" + e.message + ")" }],
    };
  }

  const text = coverPageText(html);

  const label = text.match(/Document Fiscal Year Focus\s*(\d{4})/i);
  const ended = text.match(
    /Document Period End Date\s*([A-Za-z]{3,9})\.?\s*(\d{1,2}),?\s*(\d{4})/i
  );

  const row = { form: filing.form, accession: filing.accession, filed: filing.filed };

  if (!label) {
    row.rejected = "the cover page does not state a fiscal year focus";
    return { offset: null, evidence: [row] };
  }
  if (!ended) {
    row.rejected = "the cover page does not state a period end date";
    row.fiscalYearFocus = label[1];
    return { offset: null, evidence: [row] };
  }

  const month = MONTHS[ended[1].slice(0, 3).toLowerCase()];
  const day = parseInt(ended[2], 10);
  const year = parseInt(ended[3], 10);

  if (!month || !day || !year) {
    row.rejected = "the period end date could not be read: " + ended[0];
    return { offset: null, evidence: [row] };
  }

  const iso = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  const focus = parseInt(label[1], 10);
  const { endsIn } = fiscalPosition(iso, fye);
  const offset = endsIn - focus;

  row.fiscalYearFocus = focus;
  row.periodEnd = iso;
  row.impliedOffset = offset;

  if (offset !== 0 && offset !== 1) {
    row.rejected = "implied offset of " + offset + " is not 0 or 1";
    return { offset: null, evidence: [row] };
  }

  row.used = true;
  return { offset, evidence: [row] };
}

/* The last resort, and a guess. Right for Macy's, wrong for Walmart and
   Autodesk, which is why it is labelled and reported. */
function assumeFromMonth(fye) {
  if (fye.month === 12) return { offset: 0, source: "calendar year end" };
  return { offset: fye.month <= 6 ? 1 : 0, source: "assumed from the year end month" };
}

/**
 * The company's calendar.
 *
 * The period normaliser needs the same two facts every XBRL fact is labelled
 * with - where the fiscal year ends, and whether the company names a year by
 * its start or its end - and must get them from the same place, or a guide and
 * an actual for the same period get different labels and never match.
 *
 * A calendar-year filer needs none of this: if the year ends in December the
 * label is the year it ends in, and there is nothing to learn. The cover page
 * is only fetched when the answer is genuinely open.
 */
export async function companyCalendar(env, cik) {
  const fye = await fiscalYearEnd(env, cik);

  if (fye.month === 12) {
    return {
      fye: { month: fye.month, day: fye.day },
      labelOffset: 0,
      meta: {
        fiscalYearEnd: "12/" + String(fye.day).padStart(2, "0"),
        labelConvention: "fiscal year is labelled by the year it ENDS in",
        conventionFrom: "calendar year end, which admits no other reading",
        evidence: [],
      },
    };
  }

  const cover = await focusFromCoverPage(env, cik, fye);
  const chosen = cover.offset !== null
    ? { offset: cover.offset, source: "Document Fiscal Year Focus on the company's own cover page" }
    : assumeFromMonth(fye);

  return {
    fye: { month: fye.month, day: fye.day },
    labelOffset: chosen.offset,
    meta: {
      fiscalYearEnd:
        String(fye.month).padStart(2, "0") + "/" + String(fye.day).padStart(2, "0"),
      labelConvention: chosen.offset === 1
        ? "fiscal year is labelled by the year it STARTS in"
        : "fiscal year is labelled by the year it ENDS in",
      conventionFrom: chosen.source,
      evidence: cover.evidence,
    },
  };
}

/* Ordered fallbacks per metric. First match wins, so the most specific and
   most modern tag goes first. */
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
 * A fact is usable when its duration matches what the period claims to be - a
 * quarterly tag carrying a year-to-date figure is the single most common way a
 * scorecard reads 300% beats out of nothing.
 */
export async function factsFor(env, cik, calendar) {
  const cal = calendar || await companyCalendar(env, cik);
  const doc = await secJson(env, "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json");
  const us = (doc.facts && doc.facts["us-gaap"]) || {};
  const fye = cal.fye;
  const labelOffset = cal.labelOffset;

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

          // Keep the EARLIEST filing of a period. XBRL carries every
          // restatement, and a figure restated two years later is not what
          // management was judged against at the time.
          const held = out[key];
          if (!held || rec.filed < held.filed) out[key] = rec;
        }
      }
      if (Object.keys(out).some((k) => k.startsWith(metric + "|"))) break;
    }
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

  // Free cash flow is not a tag. It is operating cash flow less capex, and
  // both are, so it is derived exactly rather than estimated. Run after the Q4
  // derivation so a derived quarter gets one too.
  for (const key of Object.keys(out)) {
    if (!key.startsWith("operating_cash_flow|")) continue;
    const period = key.split("|")[1];
    if (out["fcf|" + period]) continue;
    const ocf = out[key], capex = out["capex|" + period];
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

  return { facts: out, meta: cal.meta, shareChanges: shareCountChangesFrom(doc) };
}

/* ------------------------------------------------------------------ *
 * Share splits
 * ------------------------------------------------------------------ */

/* The ratios a split or a reverse split is actually declared in. A share
   count that moves by one of these between two cover pages, to within 4%,
   has been split; buybacks and issuance never move it that far that cleanly
   in one quarter. */
const SPLIT_RATIOS = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50];

function cleanRatio(r) {
  for (const k of SPLIT_RATIOS) {
    if (Math.abs(r / k - 1) <= 0.04) return k;
    if (Math.abs(r * k - 1) <= 0.04) return 1 / k;
  }
  return null;
}

/**
 * When did the share count jump, and by how much?
 *
 * READ FROM THE COVER PAGE. Every 10-Q and 10-K states the shares outstanding
 * on a recent date (dei:EntityCommonStockSharesOutstanding). Walmart's covers
 * read about 2.7 billion through late 2023 and about 8.1 billion from early
 * 2024: the three-for-one split of February 2024, visible in the company's own
 * filings, for every company that files, with no list of splits to maintain.
 *
 * The date is known only to lie between two cover dates. Each change is
 * returned as that window - after `from`, on or before `to` - and pairing.js
 * decides what a guide inside the window means.
 *
 * `ratio` is new shares per old share: 3 for a three-for-one split, 0.1 for a
 * one-for-ten reverse split.
 */
export function shareCountChangesFrom(doc) {
  const dei = (doc && doc.facts && doc.facts.dei) || {};
  const node = dei.EntityCommonStockSharesOutstanding;
  if (!node || !node.units) return [];

  // One figure per cover date: the earliest filing that states it.
  const byDate = new Map();
  for (const facts of Object.values(node.units)) {
    for (const f of facts) {
      if (!f.end || typeof f.val !== "number" || !(f.val > 0)) continue;
      if (!/^10-[QK]/.test(String(f.form || ""))) continue;
      const held = byDate.get(f.end);
      if (!held || String(f.filed) < String(held.filed)) byDate.set(f.end, f);
    }
  }

  const points = Array.from(byDate.values()).sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const r = b.val / a.val;
    if (r < 1.4 && r > 1 / 1.4) continue;
    const ratio = cleanRatio(r);
    if (!ratio) continue;
    out.push({ from: a.end, to: b.end, ratio, before: a.val, after: b.val });
  }
  return out;
}

/** The same, for a path that has not fetched companyfacts for anything else. */
export async function shareCountChanges(env, cik) {
  const doc = await secJson(env, "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json");
  return shareCountChangesFrom(doc);
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
