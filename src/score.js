/**
 * Scoring.
 *
 * The last step before a scorecard is something a person can read, and the
 * shortest file in the project - because the rules were settled before any of
 * it was written and none of them require a judgement at runtime.
 *
 * THE RULES, and why each one is what it is:
 *
 * No midpoint. Most scorecards compare the result to the middle of the guided
 * range, and the middle is a number management never gave. Beating it is not
 * an event that happened. An outcome is reported by its position against the
 * range the company actually printed - above it, within it, below it - with
 * the distance to each end.
 *
 * No label on a point guide. Broadcom guided fourth-quarter revenue at
 * "approximately $34.8 billion". Inventing a tolerance band around someone
 * else's "approximately" is a judgement this tool has no standing to make, and
 * an argument with an analyst that cannot be won. A point guide gets a
 * distance and no verdict.
 *
 * No inversion, and this is deliberate. An earlier plan was to flip the
 * scoring for capital expenditure and tax rate, where coming in above the
 * guide is bad news rather than good. That is only needed if the output says
 * "beat" or "missed". It says "above" and "below", which are facts and mean
 * the same thing for every metric. A PM knows what a higher tax rate means;
 * the tool does not need to tell him, and the moment it starts to, it is
 * editorialising.
 *
 * The distance from the ORIGINAL guide is carried as well as the latest one,
 * where a history exists. Two companies can both land inside their most recent
 * full-year guide, one having held it all year and the other having cut twice
 * to get there. The revision path shows the difference to a reader who looks;
 * this makes it a number that can be sorted on.
 */

/* Percentages move in percentage points, and calling a 2-point gap "2 percent"
   is the kind of sloppiness a PM notices immediately. */
function unitWord(unit) {
  if (unit === "percent") return "percentage points";
  return unit || "";
}

/* Enough precision for money and cents, without trailing noise from floating
   point arithmetic. */
function tidy(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

/**
 * One pair, scored.
 *
 * Only a comparable pair is scored. Everything else already carries the reason
 * it was not, and attaching a number to it would invite someone to read it.
 */
export function scorePair(pair, originalGuide) {
  if (!pair || !pair.comparable) return pair;

  const actual = pair.actual;
  const low = pair.guide ? pair.guide.low : null;
  const high = pair.guide ? pair.guide.high : null;
  const value = pair.guide ? pair.guide.value : null;
  const word = unitWord(pair.unit);

  if (typeof actual !== "number") return pair;

  // A range. The common case, and the one the no-midpoint rule exists for.
  if (typeof low === "number" && typeof high === "number") {
    const toLow = tidy(actual - low);
    const toHigh = tidy(actual - high);

    let position;
    let summary;

    if (actual > high) {
      position = "above";
      summary = "Above the guided range by " + tidy(actual - high) + " " + word
        + " (guided " + low + " to " + high + ", reported " + actual + ").";
    } else if (actual < low) {
      position = "below";
      summary = "Below the guided range by " + tidy(low - actual) + " " + word
        + " (guided " + low + " to " + high + ", reported " + actual + ").";
    } else {
      position = "within";
      summary = "Within the guided range (guided " + low + " to " + high
        + ", reported " + actual + ").";
    }

    return {
      ...pair,
      score: {
        position,
        deltaToLow: toLow,
        deltaToHigh: toHigh,
        units: word,
        summary,
        ...originalDelta(actual, originalGuide, word),
      },
    };
  }

  // A point. Distance only - no verdict, by the rule above.
  if (typeof value === "number") {
    const delta = tidy(actual - value);
    return {
      ...pair,
      score: {
        position: null,
        delta,
        units: word,
        summary: "Guided " + value + ", reported " + actual + " - a difference of "
          + delta + " " + word + ". A single figure carries no range, so this is"
          + " reported as a distance and not as a beat or a miss.",
        ...originalDelta(actual, originalGuide, word),
      },
    };
  }

  return pair;
}

/**
 * The same outcome against the FIRST guide for the period.
 *
 * Only meaningful once a history exists, so it is optional and absent until
 * the historical engine fills it in. Recording the shape of it now costs
 * nothing and is expensive to backfill later.
 */
function originalDelta(actual, originalGuide, word) {
  if (!originalGuide) return {};

  const { low, high, value } = originalGuide;

  if (typeof low === "number" && typeof high === "number") {
    return {
      againstOriginalGuide: {
        low, high,
        deltaToLow: tidy(actual - low),
        deltaToHigh: tidy(actual - high),
        position: actual > high ? "above" : actual < low ? "below" : "within",
        units: word,
      },
    };
  }
  if (typeof value === "number") {
    return {
      againstOriginalGuide: { value, delta: tidy(actual - value), units: word },
    };
  }
  return {};
}

/**
 * Every pair, scored, with a count of how each landed.
 *
 * The tally covers COMPARABLE pairs only. An earlier version counted every
 * rejected pair as "unscored", so Broadcom reported three unscored against one
 * comparable pair and the number meant nothing. A pair that was refused for a
 * period or basis mismatch already carries its reason; it is not an outcome
 * and does not belong in a count of outcomes.
 *
 * Point guides are counted on their own. They were scored - they carry a
 * distance - but deliberately carry no verdict, and folding them into
 * "unscored" would hide that the figure is there.
 */
export function scoreAll(pairs, originals) {
  const scored = (pairs || []).map((p) => {
    const key = (p.metric_as_written || "") + "|" + (p.guide_period || "");
    return scorePair(p, originals ? originals[key] : null);
  });

  const tally = { above: 0, within: 0, below: 0, noVerdict: 0 };
  for (const p of scored) {
    if (!p.comparable || !p.score) continue;
    if (p.score.position === "above") tally.above += 1;
    else if (p.score.position === "within") tally.within += 1;
    else if (p.score.position === "below") tally.below += 1;
    else tally.noVerdict += 1;
  }

  return { pairs: scored, tally, notComparable: scored.filter((p) => !p.comparable).length };
}
