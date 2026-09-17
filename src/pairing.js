/**
 * Pairing a guide to its actual.
 *
 * One definition, imported by the backfill and the live send. There were two,
 * and they were the last place in the project still deciding what counts as
 * one measure by comparing raw strings.
 *
 * WHAT WENT WRONG
 *
 * Walmart's Q2 FY2025 release guides three lines for Q3: "Consolidated net
 * sales (cc)", "Consolidated operating income (cc)", "Adjusted EPS". The Q3
 * release reports operating income as "Adjusted operating income, constant
 * currency". Two labels, one measure, and pairing matched on the lowercased
 * string - so net sales and EPS paired and operating income did not.
 *
 * The record then showed no Q3 2025 operating income pair, and the email,
 * having been taught to print gaps, said "not guided". Walmart had guided it,
 * in a table, in a range. The product was calling a company silent because it
 * had renamed a row.
 *
 * Every other part of this project already grouped these correctly, through
 * metricKey: the email's blocks, the coverage count, the revision path. Only
 * the step that decides whether a pair EXISTS was still on exact match. It is
 * the same lesson as metrics.js and format.js, arrived at for the fourth time.
 *
 * HOW IT MATCHES NOW
 *
 * The exact label first, because when the company uses the same words on both
 * sides there is nothing to interpret. Only if that misses does it fall back to
 * the measure key.
 *
 * THE FALLBACK REFUSES TO GUESS. metricKey strips "adjusted" and "constant
 * currency", so a release reporting both GAAP and adjusted operating income
 * produces two actuals with the same key. Picking one would be a coin toss
 * dressed as an answer, so an ambiguous key is refused and says so. The basis
 * check downstream would catch some of those; some is not enough when the
 * output is a number a portfolio manager acts on.
 *
 * Every fuzzy match is RECORDED on the pair - matched_on, and the label the
 * actual was found under. A wrong match is then visible in /api/record rather
 * than being an invisible assumption, which is the same reason every other
 * diagnostic in this project exists.
 */

import { metricKey } from "./metrics.js";
import { samePeriod } from "./period.js";

export function pairUp(guides, actuals) {
  const byLabel = new Map();
  const byMeasure = new Map();
  const measureCount = new Map();

  for (const a of actuals || []) {
    const label = String(a.metric_as_written || "").toLowerCase().trim();
    if (label && !byLabel.has(label)) byLabel.set(label, a);

    const key = metricKey(a.metric_as_written || "");
    if (!key) continue;
    measureCount.set(key, (measureCount.get(key) || 0) + 1);
    if (!byMeasure.has(key)) byMeasure.set(key, a);
  }

  const pairs = [];

  for (const g of guides || []) {
    const hasNumber =
      typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number";
    if (!hasNumber) continue;

    const written = String(g.metric_as_written || "");
    const label = written.toLowerCase().trim();
    const key = metricKey(written);

    let a = byLabel.get(label);
    let matchedOn = a ? "label" : null;
    let ambiguous = false;

    if (!a && key) {
      if (measureCount.get(key) === 1) {
        a = byMeasure.get(key);
        matchedOn = "measure";
      } else if ((measureCount.get(key) || 0) > 1) {
        ambiguous = true;
      }
    }

    const base = {
      metric: g.metric,
      metric_as_written: g.metric_as_written,
      basis: g.basis,
      unit: g.unit,
      shape: g.shape,
      guide: { low: g.low ?? null, high: g.high ?? null, value: g.value ?? null },
      guide_period: g.period,
      guide_period_text: g.period_text,
    };

    if (ambiguous) {
      pairs.push({
        ...base,
        comparable: false,
        why: "More than one reported figure could be this measure, so none was chosen.",
      });
      continue;
    }

    if (!a) {
      pairs.push({ ...base, comparable: false, why: "No actual was looked for under this metric." });
      continue;
    }

    base.actual = a.value;
    base.actual_unit = a.unit;
    base.actual_period = a.period;
    // Carried onto the pair. It was not, and the backfill's own diagnostic for
    // unreadable periods reads this field - so it printed "(none returned)" for
    // every pair regardless of what the model actually said, and three rounds
    // of debugging were spent reasoning from it.
    base.actual_period_text = a.period_text;
    base.period_assumed = Boolean(a.period_assumed);
    base.actual_found_as = a.found_as;
    base.quote = a.quote;

    base.matched_on = matchedOn;
    if (matchedOn === "measure") {
      // The two labels, kept, because this match was a judgement and the
      // judgement should be checkable.
      base.actual_matched_as = a.metric_as_written;
    }

    if (a.value === null) {
      pairs.push({ ...base, comparable: false, why: "The release does not report this figure." });
      continue;
    }
    if (!g.period) {
      pairs.push({ ...base, comparable: false, why: "The guide's period could not be read." });
      continue;
    }
    if (!a.period) {
      pairs.push({ ...base, comparable: false, why: "The actual's period could not be read." });
      continue;
    }
    if (!samePeriod(g.period, a.period)) {
      pairs.push({
        ...base,
        comparable: false,
        why: "Different periods: the guide is for " + g.period
          + " and the figure reported is for " + a.period + ".",
      });
      continue;
    }
    if (a.unit_mismatch) {
      pairs.push({ ...base, comparable: false, why: "The figure reported is not the kind of number that was guided." });
      continue;
    }
    if (a.basis_mismatch) {
      pairs.push({ ...base, comparable: false, why: a.basis_mismatch });
      continue;
    }

    pairs.push({ ...base, comparable: true });
  }

  return pairs;
}
