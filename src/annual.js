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

/* The units these measures can actually be compared in. Anything else - and
   "other" in particular - is the extraction having failed to read a unit, not
   the company having stated an exotic one. */
const USABLE_UNITS = ["percent", "USD millions", "USD billions"];

function usableUnit(u) {
  return USABLE_UNITS.includes(u);
}

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

/**
 * A guide with one bound is a point guide.
 *
 * United's fiscal 2024 capital expenditure guide arrived as {low: 6.5, high:
 * null} - "approximately $6.5 billion", read as the bottom of a range that was
 * never stated. score.js scores a range or a point and that is neither, so it
 * produced no position; the table then printed the guide and the result and
 * left the outcome column empty, which reads as a figure that failed to
 * render.
 *
 * Nothing is invented by this: the number the company printed is the number
 * compared. What changes is that it is treated as the single figure it is, so
 * it gets a distance and no verdict - the rule for point guides everywhere
 * else in the product.
 */
function asPoint(f) {
  if (f.value !== null) return f;

  // Equal ends are a point too. Coca-Cola's comparable EPS growth arrived as
  // low 8, high 8 and printed as "8% to 8%" - a range from a number to itself.
  if (f.low !== null && f.high !== null && f.low === f.high) {
    return { low: null, high: null, value: f.low };
  }

  const ends = [f.low, f.high].filter((n) => n !== null);
  if (ends.length !== 1) return f;
  return { low: null, high: null, value: ends[0] };
}

/**
 * Does the company's own label say this guide is adjusted?
 *
 * XBRL tags GAAP. So a guide the company calls adjusted and a tagged figure
 * are two different measures, and comparing them without saying so produces
 * exactly what United's table showed: capital expenditure landing $0.6bn,
 * $0.9bn and $1.3bn under guidance three years running. United did not
 * undershoot three times. It guides capital expenditure net of aircraft
 * purchase deposit returns and sale-leaseback proceeds, and the cash flow
 * statement tags the gross figure.
 *
 * KEYED ON THE LABEL, NOT ON THE BASIS FIELD. The first version used the
 * guide's basis, which the extraction sets from the heading over the whole
 * outlook table - Walmart's says non-GAAP because of EPS and operating income,
 * so "the company guided this on an adjusted basis" appeared against plain
 * "Capital expenditures", which has no adjusted version. The label is the
 * company's own word for the measure and does not spread across a table.
 *
 * Not computed away. United's adjustment is deposits and sale-leaseback
 * proceeds, neither reliably tagged, and what is included changes between
 * years. Assembling it from parts would mean guessing which parts and
 * publishing the guess as a fact. Saying the two are not the same number is
 * true, checkable, and costs nothing.
 */
function labelSaysAdjusted(written) {
  // The words companies actually use. Coca-Cola writes "Underlying effective
  // tax rate (non-GAAP)" and never the word adjusted, so the caveat did not
  // fire and the email showed KO missing its tax guidance by 280 basis points
  // three years running - comparing an underlying rate that excludes items
  // against the GAAP rate that includes them. United writes "Adjusted", Macy's
  // writes "Core", others write "Comparable" or "Organic". All mean the same
  // thing here: this is not the number XBRL tags.
  return /\b(adj(\.|usted)?|underlying|comparable|core|organic|normali[sz]ed|non[- ]?gaap)\b/i
    .test(String(written || ""));
}

function hasFigure(f) {
  return f.low !== null || f.high !== null || f.value !== null;
}

/* Dollars, in whichever scale the guide was stated in.
 *
 * United guides "adjusted capital expenditures of approximately $6.5 billion".
 * xbrl.js normalises every USD fact to millions, so the tagged answer arrives
 * as 6500 USD millions and the two were refused as a unit mismatch - the same
 * number, written at two scales, called incomparable.
 *
 * Only between USD scales, and only by a factor of a thousand. This is not a
 * unit conversion table; it is the one conversion that is arithmetic rather
 * than judgement. */
const USD_SCALE = { "USD millions": 1, "USD billions": 1000 };

function toScale(value, from, to) {
  const a = USD_SCALE[from];
  const b = USD_SCALE[to];
  if (!a || !b) return null;
  return Number(((value * a) / b).toFixed(6));
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

      const figure = asPoint(figureOf(g));
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

      /**
       * The figure is last-wins. THE UNIT IS NOT.
       *
       * Walmart's fiscal 2025 capital expenditure guide - "Approximately 3.0%
       * to 3.5% of net sales", the same sentence in every release - came back
       * as "percent" from February 2024 and as "other" from a later one. The
       * later guide won, so the comparison went looking for dollars, found the
       * tagged figure in millions, and refused its own guide as a unit
       * mismatch. The model had simply read the same sentence two ways, which
       * it does.
       *
       * So a usable unit is never given up for an unusable one. A company
       * revising a guide changes the number, not the unit it states it in -
       * and if one genuinely switched from a percentage of sales to a dollar
       * figure, the two would be orders of magnitude apart and the row would
       * be visibly absurd rather than quietly wrong.
       */
      held.guide = figure;
      held.metric_as_written = g.metric_as_written;
      if (usableUnit(g.unit) || !usableUnit(held.unit)) held.unit = g.unit;
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
    /**
     * A year the company has not finished cannot be answered.
     *
     * Walmart's fiscal 2027 guide collected a row reading "not tagged", which
     * is trivially true of a year still running and tells a reader nothing -
     * the same noise the main record was making when it asked the model for
     * full-year figures every quarter.
     *
     * The test is whether the company has tagged its revenue for that year. A
     * closed year has a revenue fact; an open one does not. That is the
     * company's own statement about its own calendar, which beats anything
     * derived from a filing date.
     */
    const closed = Boolean(facts["revenue|" + g.period]);

    /**
     * A year still running: the guide, and no pretence of an answer.
     *
     * The first version dropped these, because "not tagged" against a year
     * that has not ended tells a reader nothing. But dropping the row dropped
     * the guide with it: United cut its fiscal 2026 capital expenditure from
     * $8bn to $7.5bn and that guide appeared nowhere in the email - not in the
     * table, not underneath it. A live guide with no home is worse than a row
     * that says the year is not over.
     *
     * The test is the company's own: a closed year has a tagged revenue
     * figure, an open one does not. Nothing derived from a filing date.
     */
    if (!closed) {
      pairs.push({
        metric: g.metric,
        metric_as_written: g.metric_as_written,
        guide_period: g.period,
        unit: g.unit,
        guide: g.guide,
        first: g.first,
        comparable: false,
        refusal: "year not ended",
        why: "The fiscal year has not finished, so there is nothing to compare it to yet.",
      });
      continue;
    }

    /**
     * A guide with no unit cannot be compared to anything.
     *
     * Walmart's fiscal 2025 capital expenditure guide arrived as "3 to 3.5"
     * with no unit, where every other capex guide carries "percent". It then
     * printed as bare numbers in a column of percentages. The comparison is
     * refused and the reason names the extraction rather than the company -
     * Walmart stated "approximately 3.0% to 3.5% of net sales"; the unit was
     * lost on the way in.
     */
    if (!usableUnit(g.unit)) {
      pairs.push({
        metric: g.metric,
        metric_as_written: g.metric_as_written,
        guide_period: g.period,
        unit: g.unit,
        guide: g.guide,
        first: g.first,
        comparable: false,
        refusal: "no unit",
        why: "The guide was stored without a usable unit, so there is nothing to compare it to.",
      });
      continue;
    }

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
        refusal: "not tagged",
        why: "The company has not tagged a figure for this year yet.",
      });
      continue;
    }

    // The unit the company guided in has to be the unit that came back, or the
    // comparison is between two different things wearing the same name.
    //
    // Dollars at two scales are the same thing, so those are converted rather
    // than refused.
    if (actual.unit !== g.unit && USD_SCALE[actual.unit] && USD_SCALE[g.unit]) {
      const rescaled = toScale(actual.value, actual.unit, g.unit);
      if (rescaled !== null) {
        actual.value = rescaled;
        actual.unit = g.unit;
      }
    }

    if (actual.unit !== g.unit) {
      pairs.push({
        metric: g.metric,
        metric_as_written: g.metric_as_written,
        guide_period: g.period,
        unit: g.unit,
        guide: g.guide,
        first: g.first,
        comparable: false,
        refusal: "unit mismatch",
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
      basisCaveat: labelSaysAdjusted(g.metric_as_written),
      // Keyed on the company's own label, never on the extraction's basis
      // flag.
      //
      // It was set from the guide's basis field, and the extraction marks a
      // whole outlook table non-GAAP when its heading says so - Walmart's does,
      // because of EPS and operating income. That put "the company guided this
      // on an adjusted basis" against capital expenditure, which has no
      // adjusted version. There is no non-GAAP capex and no non-GAAP cash
      // spend; the caveat was false wherever it appeared here.
      quote: g.quote,
      comparable: true,
    });
  }

  const scored = scoreAll(pairs).pairs;

  /* Grouped by measure, then newest year first. Read down a column rather than
     across: three years of the tax rate together, then three of capex. Sorting
     by year alone interleaved them and made the table look like a list. */
  scored.sort((a, b) => {
    const order = ANNUAL_METRICS.indexOf(a.metric) - ANNUAL_METRICS.indexOf(b.metric);
    if (order !== 0) return order;
    return periodSortKey(b.guide_period) - periodSortKey(a.guide_period);
  });

  // Keep the most recent years only, counted in YEARS rather than rows: two
  // measures across three years is six rows, and that is the table.
  /* Three CLOSED years, plus any year still running.
   *
   * The open year is the current guide and belongs at the top whatever else is
   * shown; it must not take one of the three slots meant for history, or
   * showing this year's guide would cost the reader a year of record. */
  const open = new Set(scored.filter((p) => p.refusal === "year not ended")
    .map((p) => p.guide_period));

  const years = Array.from(new Set(scored.map((p) => p.guide_period)))
    .filter((y) => !open.has(y))
    .sort((a, b) => periodSortKey(b) - periodSortKey(a));
  const wanted = new Set([...open, ...years.slice(0, YEARS)]);

  return scored.filter((p) => wanted.has(p.guide_period));
}
