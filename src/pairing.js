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

/**
 * Of several actuals under one label, the one for this guide's period.
 *
 * Matching on the label alone handed one actual to every guide sharing it.
 * Delta's fourth-quarter release answers two guides both called "Earnings Per
 * Share" - the quarter and the year - and both were paired with whichever
 * actual came first. The year's $5.82 was scored against the quarter's $1.60
 * to $1.90 guide as a 205% beat. It is the same fault that cost the Q1 2026
 * figure in the actuals extraction, one step further down, and it was found
 * the same way: fixing the first exposed the second.
 */
function forPeriod(candidates, period) {
  if (!candidates || !candidates.length) return null;
  const exact = candidates.find((a) => a.period && period && samePeriod(period, a.period));
  if (exact) return exact;
  return candidates.length === 1 ? candidates[0] : null;
}

export function pairUp(guides, actuals) {
  const byLabel = new Map();
  const byMeasure = new Map();

  for (const a of actuals || []) {
    const label = String(a.metric_as_written || "").toLowerCase().trim();
    if (label) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(a);
    }

    const key = metricKey(a.metric_as_written || "");
    if (!key) continue;
    if (!byMeasure.has(key)) byMeasure.set(key, []);
    byMeasure.get(key).push(a);
  }

  const pairs = [];

  for (const g of guides || []) {
    const hasNumber =
      typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number";
    if (!hasNumber) continue;

    const written = String(g.metric_as_written || "");
    const label = written.toLowerCase().trim();
    const key = metricKey(written);

    let a = forPeriod(byLabel.get(label), g.period);
    let matchedOn = a ? "label" : null;
    let ambiguous = false;

    if (!a && key) {
      const candidates = byMeasure.get(key) || [];
      a = forPeriod(candidates, g.period);
      if (a) matchedOn = "measure";
      else if (candidates.length > 1) ambiguous = true;
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
    if (a.period_open) {
      pairs.push({
        ...base,
        comparable: false,
        why: "The period had not ended when this release was filed, so the figure is an outlook, not a result.",
      });
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

  /**
   * A QUARTER CANNOT EQUAL ITS OWN FULL YEAR.
   *
   * A fourth-quarter release reports two figures for the same measure - the
   * quarter and the year - often in adjacent columns. Delta guided its
   * December quarter 2025 EPS at $1.60 to $1.90; the model answered the
   * quarter with $5.82, the full-year figure, and the email showed a 205% beat
   * with a warning mark beside it. The same run answered the full-year guide
   * with the same $5.82, correctly.
   *
   * That is the tell, and it needs no judgement: when the quarter and the year
   * of one measure come back with the same figure from the same release, the
   * quarter has been handed the year. It is refused and says why, rather than
   * printed and flagged. A result can legitimately be flagged; this one is
   * simply the wrong row.
   */
  const yearFigure = new Map();
  for (const p of pairs) {
    const m = String(p.guide_period || "").match(/^(\d{4})FY$/);
    if (!m || typeof p.actual !== "number") continue;
    yearFigure.set(metricKey(p.metric_as_written || "") + "|" + m[1], p.actual);
  }
  for (const p of pairs) {
    const m = String(p.guide_period || "").match(/^(\d{4})Q4$/);
    if (!m || !p.comparable || typeof p.actual !== "number") continue;
    const year = yearFigure.get(metricKey(p.metric_as_written || "") + "|" + m[1]);
    if (typeof year !== "number") continue;
    if (Math.abs(year - p.actual) <= Math.abs(year) * 0.005) {
      p.comparable = false;
      p.why = "The figure taken for the fourth quarter is the full-year figure.";
    }
  }

  return pairs;
}

/* ------------------------------------------------------------------ *
 * Per-share figures across a share split
 * ------------------------------------------------------------------ */

function ratioWords(r) {
  if (r >= 1) return (Number.isInteger(r) ? r : r.toFixed(1)) + "-for-1 split";
  const k = 1 / r;
  return "1-for-" + (Number.isInteger(Math.round(k)) ? Math.round(k) : k.toFixed(1)) + " reverse split";
}

/**
 * A per-share guide from before a split, against a result from after it.
 *
 * Walmart guided first-quarter fiscal 2025 EPS at $1.48 to $1.56 on 20
 * February 2024. It split its shares three for one days later and reported
 * $0.60 in May. The email printed "below by $0.88", with a flag, and the
 * closing analysis counted it as a miss - when $1.48 to $1.56 is about $0.49
 * to $0.52 on the new share count and $0.60 was above it. Not a miss: two
 * share counts.
 *
 * REFUSED, NOT RESTATED. Dividing the guide by three would print a figure the
 * company never published, and nothing in this product does that. The pair
 * is dropped and says why.
 *
 * WHEN IS A GUIDE "BEFORE"? A split is known only to fall between two cover
 * dates (see shareCountChangesFrom). A guide filed before that window and a
 * result filed after it straddle the split for certain. When either date
 * falls INSIDE the window, the figures decide: a result that sits far closer
 * to the guide divided by the ratio than to the guide itself was reported on
 * the other share count. Walmart's full-year 2024 guide of $6.40 to $6.48 and
 * result of $6.65 were both on the old count, both dated inside the window,
 * and are kept.
 *
 * Per-share figures only. A split changes nothing about revenue or margins.
 */
export function refuseAcrossSplit(pairs, dates) {
  const changes = (dates && dates.changes) || [];
  const guideFiled = dates && dates.guideFiled;
  const actualFiled = dates && dates.actualFiled;
  if (!changes.length || !guideFiled || !actualFiled) return pairs;

  for (const p of pairs) {
    if (!p.comparable || p.unit !== "USD per share" || typeof p.actual !== "number") continue;
    const g = p.guide || {};
    const level = typeof g.low === "number" ? g.low : typeof g.value === "number" ? g.value : g.high;
    if (typeof level !== "number" || level === 0) continue;

    for (const c of changes) {
      // Entirely before the window, or entirely after it: this change is not
      // between them.
      if (String(actualFiled) <= String(c.from) || String(guideFiled) > String(c.to)) continue;

      const certain = String(guideFiled) <= String(c.from) && String(actualFiled) > String(c.to);
      let across = certain;
      if (!certain && p.actual > 0 && level > 0) {
        const same = Math.abs(Math.log(p.actual / level));
        const moved = Math.abs(Math.log(p.actual / (level / c.ratio)));
        across = moved < same;
      }
      if (!across) continue;

      p.comparable = false;
      p.split = { ratio: c.ratio, between: [c.from, c.to] };
      p.why = "The share count changed in a " + ratioWords(c.ratio) + " between this guide and the result,"
        + " so a per-share guide from before it cannot be compared with a result after it."
        + " Restating the guide would print a figure the company never published.";
      break;
    }
  }
  return pairs;
}
