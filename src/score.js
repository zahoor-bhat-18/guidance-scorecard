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

/**
 * The precision a guide was stated to.
 *
 * MONEY PER SHARE IS ALWAYS STATED TO THE CENT. Delta guided "$0.50 to $0.90"
 * for the March quarter of 2026 and reported $0.64. The guide arrives as the
 * numbers 0.5 and 0.9 - a number does not keep its trailing zero - so this
 * read the guide as stated to one decimal, rounded the result to match, and
 * the email printed "$0.60". Its second quarter read "$1.60, above by $0.10"
 * when the company reported $1.56, above by $0.06. Both are figures the company
 * never published.
 *
 * The rule that judges a guide at the precision it was stated to is right. The
 * number simply cannot say what precision a price was written at, and for a
 * per-share figure the answer is not in doubt: cents.
 */
function guidePrecision(guide, unit) {
  const stated = Math.max(
    decimalsOf(guide.low),
    decimalsOf(guide.high),
    decimalsOf(guide.value)
  );
  return unit === "USD per share" ? Math.max(2, stated) : stated;
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
/* Leveraged measures: earnings, and everything that sits below revenue the way
   earnings do. Cash flow and operating profit move several times as far as
   revenue for the same surprise - GE carried four "check this" flags on
   ordinary free-cash-flow and profit beats of 5-6% because they were held to
   revenue's 5%. */
function looksLikeEarnings(pair) {
  const label = String(pair.metric_as_written || "");
  return /eps|earnings per share|earnings/i.test(label)
    || /cash flow|\bfcf\b|operating (profit|income)|ebitda|ebit\b|net income|pre-?tax/i.test(label)
    || ["eps", "free_cash_flow", "operating_cash_flow", "operating_income", "ebitda", "net_income"].includes(pair.metric);
}

/**
 * Did the release itself state the gap against guidance?
 *
 * Carnival guided first-quarter 2025 adjusted net income at "approx. $1"
 * million and reported $174 million, and its release said so in words: it
 * "outperformed December guidance by $173 million". The size check saw a gap
 * of 17,300% and marked it as a probable wrong row - and the email then left
 * a real result out of its summary. When the company's own sentence measures
 * the result against its guidance, the pairing is confirmed by the company.
 */
const STATED_AGAINST_GUIDE = /\b(outperform\w*|better than|exceed\w*|ahead of|above|beat|below|short of|missed|in line with|consistent with)\b[^.]{0,80}\b(guidance|outlook|forecast)\b/i;

function flagsFor(pair, actual, low, high, value) {
  const flags = [];
  if (STATED_AGAINST_GUIDE.test(String(pair.quote || ""))) return flags;
  // The same, found anywhere in the release rather than only in the line the
  // figure was taken from (actuals.js looks; see statedAgainstGuide there).
  if (pair.answer && pair.answer.stated_vs_guide) return flags;
  /* A completed acquisition or disposal between the guide and the result
     brings back the stricter size test that applied before 30 Sep 2026. Not
     a caution on every such pair: Carnival filed one in May 2026 for a
     restructuring that changed nothing a guide measures. But a gap that would
     be ordinary on its own is suspect when the company changed shape in
     between - Honeywell's spin-off, GE's, Broadcom's VMware purchase. */
  const deal = pair.deal_between
    ? " An acquisition or disposal was completed in between (8-K filed " + pair.deal_between.filed
      + "), so the guide may be for a different company than the result."
    : "";
  const isGrowth = pair.shape === "growth_range" || pair.shape === "growth_point";

  const bound = typeof low === "number" && typeof high === "number"
    ? (actual > high ? high : actual < low ? low : null)
    : typeof value === "number" ? value : null;

  if (bound === null) return flags;
  const gap = Math.abs(actual - bound);

  /* A guide of about nothing - "approximately breakeven", "$0.00 a share" -
     makes any real result an enormous percentage of it. A percentage of
     nearly zero says nothing about whether the row is right, so the size
     check is not applied when the guide is under 2% of the result. */
  const nearZero = Math.abs(bound) < Math.abs(actual) * 0.02;

  /* About a thousand times the guide, in money: a thousands-for-millions
     slip, not a guide of about nothing. Helen of Troy's $289,322 thousand,
     read as millions against a $295 million guide, passed every check here.
     pairing.js corrects the slip when the quote proves it; this catches the
     rest. */
  const thousandFold = /^USD (millions|billions)$/.test(String(pair.unit || ""))
    && bound !== 0 && Math.abs(actual / bound) >= 300 && Math.abs(actual / bound) <= 3000;
  if (thousandFold) {
    flags.push("The result is about a thousand times the guide - most likely a figure in thousands"
      + " read as millions, not a beat or a miss.");
    return flags;
  }

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
  /* Five points, not three (30 Sep 2026). Micron's June 2026 gross margin
     came in 3.9 points above an 81% guide - a real quarter, in the release's
     own headline - and was marked as a probable wrong row. A wrong row for a
     margin (gross read as operating, a segment read as the total) is usually
     ten points or more away. */
  if (pair.unit === "percent") {
    if (gap > (deal ? 3 : 5)) {
      flags.push("The gap is " + Number(gap.toFixed(4)) + " percentage points, which is very"
        + " large for a margin or rate. Check for a change in scope, a restatement, or the"
        + " wrong row before treating this as a miss or a beat." + deal);
    }
    return flags;
  }

  /* A percentage of a figure near zero is meaningless. United guided a LOSS of
     $0.85 to $0.35 a share and delivered a loss of $0.15 - an ordinary result
     that read as a 57% gap. */
  const scale = Math.abs(bound);
  const spansZero = typeof low === "number" && typeof high === "number" && low * high <= 0;
  if (!scale || spansZero || scale < 0.5 || nearZero) return flags;

  /* The threshold has to differ by what is being measured, which the first
     version ignored and so flagged every ordinary beat.
     Earnings are leveraged: a company that beats revenue by one per cent beats
     earnings by ten, and Macy's at 5.6%, Walmart's at 9.5% and Delta's at 6.7%
     were all perfectly normal quarters wearing a warning label.
     Revenue is not leveraged. Honeywell missing sales by 8% is not a quarter,
     it is a company that sold half of itself. */
  /* Loosened 30 Sep 2026, because the caution was hiding real quarters:
     Jabil's revenue came in 6-7% above the top of its range three times in
     two years, Micron's 21% in a quarter it plainly described as a record,
     and each was marked as a probable wrong row and left out of the counts.
     Every figure now carries the line it was read from, which is a better
     guard against a wrong row than its size; the size check is kept only
     for gaps too large to be an ordinary result - a quarter of revenue, or
     half of earnings.

     Earnings guided small against what was earned are skipped too. Carnival
     guided second-quarter 2024 adjusted net income at a $35m LOSS and earned
     $134m; guided the fourth quarter at $60m and earned $186m. A gap as a
     share of a guide that small, or of the wrong sign, measures the guide,
     not the row. */
  const earnings = looksLikeEarnings(pair);
  /* ...but never for a result twenty or more times its guide. That is not
     a small guide; it is a wrong row or a wrong scale (Helen of Troy's
     $289,322 thousand read as millions against a $295 million guide), and
     the exemption above was hiding it. */
  const absurd = Math.abs(actual) > 20 * Math.abs(bound);
  /* Opposite signs are exempt only when the guide is the SMALLER side.
     Carnival guided a $35m loss and earned $134m: a small guide, and the
     company itself called it a beat. Constellation Brands guided $13.40 to
     $13.70 of GAAP EPS and reported -$0.45 after an impairment: a large guide
     wiped out by a one-off, which is exactly what the caution is for. */
  if (earnings && !deal && !absurd) {
    const sameSign = bound * actual > 0;
    // ...or when the swing is within the width of the range guided:
    // Carnival guided fiscal 2023 at a $50m to $150m loss and came in at
    // about breakeven - $51m past a range $100m wide.
    const width = typeof low === "number" && typeof high === "number" ? Math.abs(high - low) : 0;
    if (!sameSign && (Math.abs(bound) <= Math.abs(actual) || gap <= width)) return flags;
    if (sameSign && Math.abs(bound) < Math.abs(actual) * 0.5) return flags;
  }
  const limit = deal ? (earnings ? 0.25 : 0.05) : (earnings ? 0.5 : 0.25);

  if (gap / scale > limit) {
    flags.push("The gap is " + Math.round((gap / scale) * 1000) / 10 + "% of the guided figure."
      + " Check for a change in scope, a restatement, or the wrong row before treating this"
      + " as a miss or a beat." + deal);
  }
  return flags;
}

/**
 * One pair, scored.
 *
 * Only a comparable pair is scored. Everything else already carries the reason
 * it was not, and attaching a number to it would invite someone to read it.
 */
/* ------------------------------------------------------------------ *
 * Floors and ceilings
 * ------------------------------------------------------------------ */

const CEILING_WORDS = "less than|below|under|no more than|not (?:to )?exceed|up to|at most|<|≤";
const FLOOR_WORDS = "greater than|more than|at least|in excess of|above|over|>|≥";

/**
 * Is this guide a floor or a ceiling rather than a figure?
 *
 * "Greater than $7.35" (Delta's 2025 EPS) and "less than $6.5 billion"
 * (United's capital spending) were scored as single figures: a result of
 * $5.9bn against "less than $6.5bn" read "-$0.6bn vs single figure", when
 * the company had simply spent within its cap.
 *
 * The extraction's shape says so when it can (at_least, at_most). Otherwise
 * the guide's own sentence decides - and only when the bound word sits
 * directly in front of THE GUIDED NUMBER, so a "less than" elsewhere in the
 * sentence is not taken for this guide's. One number only: a range is a range.
 */
export function boundOf(pair) {
  const g = pair.guide || {};
  const nums = ["low", "high", "value"].filter((k) => typeof g[k] === "number");
  if (nums.length !== 1) return null;
  const x = g[nums[0]];

  if (pair.shape === "at_most") return { kind: "ceiling", value: x };
  if (pair.shape === "at_least") return { kind: "floor", value: x };

  const quote = String(pair.guide_quote || "");
  if (!quote) return null;
  const n = String(Math.abs(x)).replace(".", "\\.") + "(?:\\.0+)?";
  const tail = "\\s*\\(?-?\\$?\\s*" + n + "(?![\\d.])";
  if (new RegExp("(?:" + CEILING_WORDS + ")" + tail, "i").test(quote)) return { kind: "ceiling", value: x };
  if (new RegExp("(?:" + FLOOR_WORDS + ")" + tail, "i").test(quote)) return { kind: "floor", value: x };
  return null;
}

export function scorePair(pair, originalGuide) {
  if (!pair || !pair.comparable) return pair;

  const actual = pair.actual;
  let low = pair.guide ? pair.guide.low : null;
  let high = pair.guide ? pair.guide.high : null;
  const value = pair.guide ? pair.guide.value : null;
  // Ends in order (see figureOf in pairing.js), for records built before.
  if (typeof low === "number" && typeof high === "number" && low > high) {
    [low, high] = [high, low];
    pair = { ...pair, guide: { ...pair.guide, low, high } };
  }

  if (typeof actual !== "number") return pair;

  /* A percentage over 100 that the guide's own sentence never prints as a
     percentage is a misread, not a guide. Constellation Brands' "operating
     income growth, guided 657 to 677%" was a dollar range in millions, and
     scored "below by 665.88 percentage points" with no warning at all. A
     real guide of that size - a company expecting to triple - prints the %
     sign, and passes. */
  if (pair.unit === "percent") {
    const g = pair.guide || {};
    const big = ["low", "high", "value"].map((k) => g[k]).filter((x) => typeof x === "number" && Math.abs(x) > 100);
    const quote = String(pair.guide_quote || pair.quote || "").replace(/(\d),(?=\d{3}\b)/g, "$1");
    const printed = (x) => new RegExp("(^|[^\\d.])" + String(Math.abs(x)).replace(".", "\\.") + "(\\.0+)?\\s*(%|percent)", "i").test(quote);
    // Printed or not, a guide in the hundreds of percent against a result
    // a fifth its size is the same misread seen from the other side.
    const dwarfs = big.length && Math.abs(actual) < Math.min(...big.map(Math.abs)) / 5;
    if (big.length && (!big.every(printed) || dwarfs)) {
      return {
        ...pair,
        comparable: false,
        why: "The guide reads as a percentage over 100 that its own sentence does not print as one, so it"
          + " is taken to be a misread amount, not a guide.",
      };
    }
  }

  /* A floor or a ceiling is a one-sided range: at or beyond the right side of
     it is "within", the wrong side is above or below. The guide is stored in
     that shape - a ceiling as a high with no low - so everything downstream
     (the tables, the medians, the strips) reads it as the range it is. */
  const bound = boundOf(pair);
  if (bound) {
    const places = guidePrecision({ value: bound.value }, pair.unit);
    const compared = places > 0 ? Number(actual.toFixed(places)) : tidy(actual);
    const x = bound.value;
    const ceiling = bound.kind === "ceiling";
    const inside = ceiling ? compared <= x : compared >= x;
    const position = inside ? "within" : ceiling ? "above" : "below";
    const words = ceiling ? "a ceiling of " + x : "a floor of " + x;
    // The same size check as any figure: a result many times its bound is a
    // wrong row, not a result. GE's "costs" ceiling of 1 was matched to total
    // costs of $34.6bn and scored "above by $33.6bn" with no warning.
    const flags = inside ? [] : flagsFor(pair, compared, null, null, x);
    const summary = inside
      ? "Within " + words + " (reported " + compared + ", " + withUnit(tidy(Math.abs(compared - x)), pair.unit)
        + (ceiling ? " under it)." : " over it).")
      : (ceiling ? "Above " : "Below ") + words + " by " + withUnit(tidy(Math.abs(compared - x)), pair.unit)
        + " (reported " + compared + ").";
    return {
      ...pair,
      bound: bound.kind,
      guide: ceiling ? { low: null, high: x, value: null } : { low: x, high: null, value: null },
      score: {
        position,
        comparedAt: places,
        actualAsGuided: compared,
        deltaToLow: ceiling ? null : tidy(compared - x),
        deltaToHigh: ceiling ? tidy(compared - x) : null,
        units: unitWord(pair.unit),
        flags,
        summary: summary + (flags.length ? " " + flags.join(" ") : ""),
      },
    };
  }

  // Rounding applies ONLY where the guide carried decimals.
  //
  // "$22.3bn to $22.5bn" is stated to a tenth and implies a tenth of
  // tolerance. "7% to 10%" is not stated to a whole point and implies nothing
  // of the kind - a whole number is usually just a round number. Rounding to
  // the guide's precision regardless turned a 17.4% result into 17%, and a
  // reported 2.6 into 3 against a guide of 2, which is worse than the problem
  // it was fixing.
  const places = guidePrecision(pair.guide || {}, pair.unit);
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
