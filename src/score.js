/**
 * Scoring.
 *
 * THE RULES, and why each one is what it is:
 *
 * No midpoint. Most scorecards compare the result to the middle of the guided
 * range, and the middle is a number management never gave. An outcome is
 * reported by its position against the range the company actually printed.
 *
 * No label on a point guide. Broadcom guides "approximately $34.8 billion".
 * Inventing a tolerance band around someone else's "approximately" is a
 * judgement this tool has no standing to make. A point guide gets a distance
 * and no verdict.
 *
 * No inversion for capex or tax rate. That is only needed if the output says
 * "beat" or "missed". It says "above" and "below", which are facts and mean
 * the same thing for every metric. A PM knows what a higher tax rate means.
 *
 * COMPARED AT THE PRECISION THE GUIDE WAS STATED TO. Added after Macy's
 * guided net sales of $22.3bn to $22.5bn, delivered $22,293m, and the
 * scorecard called it "below the guided range by 0.007 USD billions". A $7m
 * gap on $22.3bn - three hundredths of one per cent - against a guide stated
 * to one decimal place. Arithmetically true, professionally absurd, and
 * exactly the row an analyst would use to dismiss everything else on the page.
 * A company that guides to one decimal is judged to one decimal.
 */

function unitWord(unit) {
  if (unit === "percent") return "percentage points";
  if (!unit || unit === "other") return "";
  return unit;
}

/* " 0.07 USD per share" reads well; " 0.6 other" does not. */
function withUnit(n, unit) {
  const word = unitWord(unit);
  return word ? n + " " + word : String(n);
}

function tidy(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

/* How precisely was this guide stated? "$22.3bn to $22.5bn" is one decimal;
   "$0.72 to $0.74" is two. */
function decimalsOf(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  const s = String(n);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

function guidePrecision(guide) {
  return Math.max(
    decimalsOf(guide.low),
    decimalsOf(guide.high),
    decimalsOf(guide.value)
  );
}

/**
 * Is this gap too large to take at face value?
 *
 * Honeywell scored seven "below" results in nine pairs, and the reason was not
 * that Honeywell missed seven guides. It separated its businesses: the sales
 * guide went from $38.8-39.8bn to $19.8-20.0bn between two releases, and
 * comparisons across that break are comparing two different companies.
 *
 * A gap that size is far more likely to be a change in scope, a restatement,
 * or the wrong row than a genuine miss. So it is FLAGGED, not refused and not
 * hidden. Refusing would throw away real outsized results - Walmart genuinely
 * delivered 17.4% against a 7-10% guide - and hiding it is how the Honeywell
 * lines would have reached a subscriber.
 *
 * Growth guides are exempt. A percentage change is volatile by nature and a
 * large gap there is ordinary.
 */
function looksLikeEarnings(pair) {
  return /eps|earnings per share|earnings/i.test(String(pair.metric_as_written || ""))
    || pair.metric === "eps";
}

function flagsFor(pair, actual, low, high, value) {
  const flags = [];
  const isGrowth = pair.shape === "growth_range" || pair.shape === "growth_point";

  const bound = typeof low === "number" && typeof high === "number"
    ? (actual > high ? high : actual < low ? low : null)
    : typeof value === "number" ? value : null;

  if (bound === null) return flags;
  const gap = Math.abs(actual - bound);

  /* A growth guide answered with a level.
     Honeywell guided adjusted earnings growth of 3% and the release reported
     9.78 - which is not 9.78% growth, it is $9.78 of earnings per share. Both
     are "percent" as far as the unit check is concerned, so nothing caught it.
     A reported rate several times the guided one is far more likely to be a
     different number entirely. */
  if (isGrowth) {
    const ceiling = Math.abs(typeof high === "number" ? high : value);
    if (ceiling > 0 && Math.abs(actual) > ceiling * 3) {
      flags.push("The figure is more than three times the guided rate. That usually means a"
        + " level has been reported where a rate was guided. Check the row before using it.");
    }
    return flags;
  }

  /* A margin or a rate. Three points off a guided margin is not a miss, it is
     a different business. */
  if (pair.unit === "percent") {
    if (gap > 3) {
      flags.push("The gap is " + Number(gap.toFixed(4)) + " percentage points, which is very"
        + " large for a margin or rate. Check for a change in scope, a restatement, or the"
        + " wrong row before treating this as a miss or a beat.");
    }
    return flags;
  }

  /* A percentage of a figure near zero is meaningless. United guided a LOSS of
     $0.85 to $0.35 a share and delivered a loss of $0.15 - an ordinary result
     that read as a 57% gap. */
  const scale = Math.abs(bound);
  const spansZero = typeof low === "number" && typeof high === "number" && low * high <= 0;
  if (!scale || spansZero || scale < 0.5) return flags;

  /* The threshold has to differ by what is being measured, which the first
     version ignored and so flagged every ordinary beat.
     Earnings are leveraged: a company that beats revenue by one per cent beats
     earnings by ten, and Macy's at 5.6%, Walmart's at 9.5% and Delta's at 6.7%
     were all perfectly normal quarters wearing a warning label.
     Revenue is not leveraged. Honeywell missing sales by 8% is not a quarter,
     it is a company that sold half of itself. */
  const limit = looksLikeEarnings(pair) ? 0.25 : 0.05;

  if (gap / scale > limit) {
    flags.push("The gap is " + Math.round((gap / scale) * 1000) / 10 + "% of the guided figure."
      + " Check for a change in scope, a restatement, or the wrong row before treating this"
      + " as a miss or a beat.");
  }
  return flags;
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

  if (typeof actual !== "number") return pair;

  // Rounding applies ONLY where the guide carried decimals.
  //
  // "$22.3bn to $22.5bn" is stated to a tenth and implies a tenth of
  // tolerance. "7% to 10%" is not stated to a whole point and implies nothing
  // of the kind - a whole number is usually just a round number. Rounding to
  // the guide's precision regardless turned a 17.4% result into 17%, and a
  // reported 2.6 into 3 against a guide of 2, which is worse than the problem
  // it was fixing.
  const places = guidePrecision(pair.guide || {});
  const compared = places > 0 ? Number(actual.toFixed(places)) : tidy(actual);
  const rounded = compared !== tidy(actual);
  const asGuided = rounded
    ? " Reported " + actual + ", which is " + compared + " at the precision guided."
    : "";

  const flags = flagsFor(pair, compared, low, high, value);

  if (typeof low === "number" && typeof high === "number") {
    let position;
    let summary;

    if (compared > high) {
      position = "above";
      summary = "Above the guided range by " + withUnit(tidy(compared - high), pair.unit)
        + " (guided " + low + " to " + high + ", reported " + compared + ")." + asGuided;
    } else if (compared < low) {
      position = "below";
      summary = "Below the guided range by " + withUnit(tidy(low - compared), pair.unit)
        + " (guided " + low + " to " + high + ", reported " + compared + ")." + asGuided;
    } else {
      position = "within";
      summary = "Within the guided range (guided " + low + " to " + high
        + ", reported " + compared + ")." + asGuided;
    }

    return {
      ...pair,
      score: {
        position,
        comparedAt: places,
        actualAsGuided: compared,
        deltaToLow: tidy(compared - low),
        deltaToHigh: tidy(compared - high),
        units: unitWord(pair.unit),
        flags,
        summary: summary + (flags.length ? " " + flags.join(" ") : ""),
        ...originalDelta(compared, originalGuide, unitWord(pair.unit)),
      },
    };
  }

  if (typeof value === "number") {
    const delta = tidy(compared - value);
    return {
      ...pair,
      score: {
        position: null,
        comparedAt: places,
        actualAsGuided: compared,
        delta,
        units: unitWord(pair.unit),
        flags,
        summary: "Guided " + value + ", reported " + compared + " - a difference of "
          + withUnit(delta, pair.unit)
          + ". A single figure carries no range, so this is reported as a distance and not"
          + " as a beat or a miss." + asGuided
          + (flags.length ? " " + flags.join(" ") : ""),
        ...originalDelta(compared, originalGuide, unitWord(pair.unit)),
      },
    };
  }

  return pair;
}

/**
 * The same outcome against the FIRST guide for the period.
 *
 * Two companies can both land inside their most recent full-year guide, one
 * having held it all year and the other having cut twice to get there. The
 * revision path shows the difference to a reader who looks; this makes it a
 * number that can be sorted on.
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
 * comparable pair and the number meant nothing.
 *
 * Point guides are counted on their own. They were scored - they carry a
 * distance - but deliberately carry no verdict.
 */
export function scoreAll(pairs, originals) {
  const scored = (pairs || []).map((p) => {
    const key = (p.metric_as_written || "") + "|" + (p.guide_period || "");
    return scorePair(p, originals ? originals[key] : null);
  });

  const tally = { above: 0, within: 0, below: 0, noVerdict: 0, flagged: 0 };
  for (const p of scored) {
    if (!p.comparable || !p.score) continue;
    if (p.score.position === "above") tally.above += 1;
    else if (p.score.position === "within") tally.within += 1;
    else if (p.score.position === "below") tally.below += 1;
    else tally.noVerdict += 1;
    if (p.score.flags && p.score.flags.length) tally.flagged += 1;
  }

  return { pairs: scored, tally, notComparable: scored.filter((p) => !p.comparable).length };
}
