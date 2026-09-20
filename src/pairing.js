/**
 * Pairing a guide to its actual.
 *
 * One definition, imported by the backfill and the live send. There were two,
 * and they were the last place in the project still deciding what counts as
 * one measure by comparing raw strings.
 *
 * HOW IT MATCHES
 *
 * The exact label first, because when the company uses the same words on both
 * sides there is nothing to interpret. Only if that misses does it fall back
 * to the measure key.
 *
 * THE FALLBACK REFUSES TO GUESS. metricKey strips "adjusted" and "constant
 * currency", so a release reporting both GAAP and adjusted operating income
 * produces two actuals with the same key. Picking one would be a coin toss
 * dressed as an answer, so an ambiguous key is refused and says so.
 *
 * Every fuzzy match is RECORDED on the pair - matched_on, and the label the
 * actual was found under - so a wrong match is visible in /api/record rather
 * than being an invisible assumption.
 */

import { metricKey } from "./metrics.js";
import { samePeriod } from "./period.js";

/**
 * A RANGE WHOSE ENDS ARE EQUAL IS A POINT.
 *
 * Coca-Cola's first-quarter 2024 comparable EPS growth arrived as low 8, high
 * 8, and the email printed "guided 8% to 8%" - a range from a number to
 * itself, which reads as a figure that failed to render. It is a point guide
 * the extraction gave two ends to.
 *
 * It matters beyond the wording. score.js treats a range and a point
 * differently on purpose: a range gets a verdict, a point gets a distance and
 * no verdict, because inventing a tolerance around someone else's single
 * figure is a judgement this tool has no standing to make. A degenerate range
 * was collecting "above" and "below" verdicts against a number the company
 * gave as one figure.
 *
 * revisions.js collapses the same shape for the same reason. Both are needed:
 * the pairs and the revision path read the guides separately.
 */
function figureOf(g) {
  const low = g.low ?? null;
  const high = g.high ?? null;
  const value = g.value ?? null;

  if (typeof low === "number" && typeof high === "number" && low === high) {
    return { low: null, high: null, value: low };
  }

  return { low, high, value };
}

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
      guide: figureOf(g),
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
    // every pair regardless of what the model actually said.
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
