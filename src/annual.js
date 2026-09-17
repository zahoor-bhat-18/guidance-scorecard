/**
 * The annual measures.
 *
 * A separate record, built a separate way, for the guides the main one cannot
 * reach.
 *
 * WHY IT HAS TO BE SEPARATE
 *
 * Walmart guides its effective tax rate and its capital expenditure once a
 * year. Three matched pairs therefore means three closed fiscal years, and the
 * backfill reads fourteen releases - about three and a half years of them. So
 * the tax rate sits at two pairs and capital expenditure at one, and neither
 * will earn a table for another year or two. They are not missing from the
 * email because anything is broken; they are missing because the main record
 * answers a guide with a figure printed in the NEXT release, and an annual
 * guide is answered once.
 *
 * WHERE THE NUMBERS COME FROM
 *
 * Not the release. The company's own tagged XBRL, which carries every year at
 * once, so a measure guided annually has a full history the moment it is
 * looked at rather than after fourteen more releases.
 *
 * This is the opposite trade from the main record, and it is deliberate: XBRL
 * is GAAP-only and management often guides adjusted, which is exactly why the
 * main path reads the release instead. Here the measures are ones where the
 * GAAP tag IS what was guided, or close enough to say so plainly - and where
 * it is not, the row says so rather than pretending.
 *
 * WHAT IS COMPUTED, AND WHAT IS NOT
 *
 * The effective tax rate is taken from the company's own tagged rate, never
 * from tax expense over pre-tax income. The two differ - discontinued
 * operations, non-controlling interests and equity-method income all sit
 * differently - and when the company has published the answer, publishing our
 * arithmetic instead is the wrong choice.
 *
 * Capital expenditure guided as a percentage of sales IS divided: capex over
 * revenue, both tagged by the company in the same filing, for the same year.
 * That is arithmetic on two published figures, which is a different thing from
 * restating a published figure.
 */

import { periodSortKey } from "./format.js";

/* The measures this record covers. Interest is not here yet: Walmart guides it
   as a CHANGE - "increase approximately $200M to $300M" - so the actual is
   this year's net interest less last year's, and us-gaap tagging for interest
   varies far more than it does for capex. Worth doing, not worth doing
   blind. */
const ANNUAL_METRICS = ["tax_rate", "capex"];

/* Three closed years. Enough to be a pattern, recent enough to be about the
   business as it is now - the same reasoning as the eight-period cap on the
   main tables. */
const YEARS = 3;

function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function figureOf(g) {
  return {
    low: num(g.low),
    high: num(g.high),
    value: num(g.value),
  };
}

function hasFigure(f) {
  return f.low !== null || f.high !== null || f.value !== null;
}

/**
 * The actual, from the tagged facts.
 *
 * Returns null rather than a number whenever the fact that would answer the
 * guide is missing or is not the same kind of number. A missing row is a fact
 * about the filing; a wrong row is a fact about nothing.
 */
function actualFor(metric, period, unit, facts) {
  if (metric === "tax_rate") {
    const f = facts["tax_rate|" + period];
    if (!f) return null;
    // Already normalised to percent in xbrl.js.
    return { value: f.value, unit: "percent", from: f.concept, filed: f.filed };
  }

  if (metric === "capex") {
    const capex = facts["capex|" + period];
    if (!capex) return null;

    // Guided in money: the tagged figure, as filed. Capex is tagged as a cash
    // OUTFLOW and comes back positive or negative depending on the company, so
    // the sign is taken off - a guide of "$5bn of capital expenditure" is not
    // answered by "-5000".
    if (unit !== "percent") {
      return { value: Math.abs(capex.value), unit: capex.unit, from: capex.concept, filed: capex.filed };
    }

    // Guided as a percentage of sales, which is how Walmart states it. Both
    // sides tagged by the company, for the same year, in the same filing.
    const revenue = facts["revenue|" + period];
    if (!revenue || !revenue.value) return null;

    return {
      value: Number(((Math.abs(capex.value) / revenue.value) * 100).toFixed(4)),
      unit: "percent",
      from: capex.concept + " over " + revenue.concept,
      filed: capex.filed,
      computed: true,
    };
  }

  return null;
}

/**
 * Every annual guide, from every release, collapsed to one per measure and
 * year - the last guide standing, with the first kept alongside.
 *
 * The same rule the main record follows. A company that opens the year at 3.0%
 * of sales and closes it at 4.0% has told you something, and the final figure
 * alone does not.
 */
function annualGuides(guidanceByRelease) {
  const byKey = new Map();

  // Oldest release first, so "first" means earliest and "last" means latest.
  for (let i = guidanceByRelease.length - 1; i >= 0; i--) {
    const entry = guidanceByRelease[i];
    for (const g of entry.guides || []) {
      if (!g.period || !/FY$/.test(String(g.period))) continue;
      if (!ANNUAL_METRICS.includes(g.metric)) continue;

      const figure = figureOf(g);
      if (!hasFigure(figure)) continue;

      const key = g.metric + "|" + g.period;
      const held = byKey.get(key);

      if (!held) {
        byKey.set(key, {
          metric: g.metric,
          metric_as_written: g.metric_as_written,
          period: g.period,
          unit: g.unit,
          basis: g.basis,
          first: figure,
          guide: figure,
          quote: g.quote,
          releases: 1,
        });
        continue;
      }

      held.guide = figure;
      held.metric_as_written = g.metric_as_written;
      held.unit = g.unit;
      held.basis = g.basis;
      held.quote = g.quote;
      held.releases += 1;
    }
  }

  return Array.from(byKey.values());
}

/**
 * One annual guide against the tagged result.
 *
 * Deliberately NOT its own scoring rule. The position, the precision and the
 * flags all come from score.js, because a second opinion on what counts as
 * "within" is how two halves of one email end up disagreeing - which has
 * happened in this project with figures, with periods and with labels, three
 * times.
 */
export function annualRecord(guidanceByRelease, facts, scoreAll) {
  const guides = annualGuides(guidanceByRelease);
  const pairs = [];

  for (const g of guides) {
    const actual = actualFor(g.metric, g.period, g.unit, facts);
    if (!actual) {
      pairs.push({
        metric: g.metric,
        metric_as_written: g.metric_as_written,
        guide_period: g.period,
        unit: g.unit,
        guide: g.guide,
        first: g.first,
        comparable: false,
        why: "The company has not tagged a figure for this year yet.",
      });
      continue;
    }

    // The unit the company guided in has to be the unit that came back, or the
    // comparison is between two different things wearing the same name.
    if (actual.unit !== g.unit) {
      pairs.push({
        metric: g.metric,
        metric_as_written: g.metric_as_written,
        guide_period: g.period,
        unit: g.unit,
        guide: g.guide,
        first: g.first,
        comparable: false,
        why: "Guided in " + g.unit + ", tagged in " + actual.unit + ".",
      });
      continue;
    }

    pairs.push({
      metric: g.metric,
      metric_as_written: g.metric_as_written,
      guide_period: g.period,
      unit: g.unit,
      shape: g.guide.value !== null ? "point" : "range",
      guide: g.guide,
      first: g.first,
      actual: actual.value,
      actual_period: g.period,
      source: actual.from,
      computed: Boolean(actual.computed),
      // The company guided an ADJUSTED figure and XBRL tags the GAAP one.
      // Walmart guides "effective tax rate" in some releases and the adjusted
      // rate in others, and the two are not the same number. Said on the row
      // rather than silently compared - this is the exact mismatch that cost
      // the main record a quarter of operating income.
      basisCaveat: g.basis === "non_gaap",
      quote: g.quote,
      comparable: true,
    });
  }

  const scored = scoreAll(pairs).pairs;

  scored.sort((a, b) => periodSortKey(b.guide_period) - periodSortKey(a.guide_period));

  // Keep the most recent years only, counted in YEARS rather than rows: two
  // measures across three years is six rows, and that is the table.
  const years = [];
  for (const p of scored) {
    if (!years.includes(p.guide_period)) years.push(p.guide_period);
  }
  const wanted = new Set(years.slice(0, YEARS));

  return scored.filter((p) => wanted.has(p.guide_period));
}
