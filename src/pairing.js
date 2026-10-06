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

import { metricKey, labelAsCompany, namesSaidBy } from "./metrics.js";
import { samePeriod, periodIsClosedBy } from "./period.js";

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
  let low = g.low ?? null;
  let high = g.high ?? null;
  const value = g.value ?? null;

  /* The ends in order. Constellation Brands guided fiscal 2026 net sales
     "down 4% to 6%", read as low -4 and high -6. Every check that uses "low"
     as the bottom then measured the -10.48% result from -4: "below by
     6.48pp" instead of 4.48. A range is a range whichever end is written
     first. */
  if (typeof low === "number" && typeof high === "number" && low > high) {
    [low, high] = [high, low];
  }

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
function forPeriod(candidates, period, askedFor) {
  if (!candidates || !candidates.length) return null;
  const exact = candidates.find((a) => a.period && period && samePeriod(period, a.period));
  if (exact) return exact;
  /* THE ANSWER TO THIS GUIDE'S OWN QUESTION.
   *
   * Every actual records which guide period it was asked for. When no answer
   * carries the period itself - because the model returned nothing - the
   * answer that was asked for this period is still the right one to attach:
   * it says what the model found (or that it found nothing), and the checks
   * below give the true reason.
   *
   * Without this, Carnival's second-quarter 2026 release was refused fourteen
   * times as "more than one reported figure could be this measure". There
   * was not one figure, let alone two: the quarter and the year had each been
   * asked for, both came back empty, and two empty answers under one label
   * looked like a choice between two figures.
   *
   * Only for the exact label (askedFor). Under the looser measure key, two
   * different measures - GAAP and adjusted - can each have been asked for the
   * same period, and picking one would be a guess. */
  if (askedFor) {
    const own = candidates.filter((a) => a.guide_period && period && a.guide_period === period);
    if (own.length === 1) return own[0];
  }
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

    let a = forPeriod(byLabel.get(label), g.period, true);
    let matchedOn = a ? "label" : null;
    let ambiguous = false;
    let nothingFound = false;

    if (!a && key) {
      const candidates = byMeasure.get(key) || [];
      a = forPeriod(candidates, g.period);
      if (a) matchedOn = "measure";
      // Ambiguous only when two or more answers actually carry a figure.
      // Several empty answers are not a choice between figures.
      else if (candidates.filter((c) => c.value !== null && c.value !== undefined).length > 1) ambiguous = true;
      else if (candidates.length > 1) nothingFound = true;
    }

    const base = {
      metric: g.metric,
      metric_as_written: g.metric_as_written,
      basis: g.basis,
      unit: g.unit,
      shape: g.shape,
      guide: figureOf(g),
      // The company's own words when the range was read from them
      // ("decline high-single digits"), so the email can show both.
      guide_words: g.from_words || null,
      guide_period: g.period,
      guide_period_text: g.period_text,
      // Set when a mid-quarter 8-K replaced the release's guide. The pair is
      // scored against the guide in force; this says where it came from.
      guide_updated: g.updated || null,
      // The guide's own sentence: score.js reads "less than" / "greater than"
      // in it to tell a ceiling or a floor from a single figure.
      guide_quote: g.quote || null,
      // Set on a guide carried forward from an older release (see
      // guidesToCarry): when it was given, and in which filing.
      guide_filed: g.filed_from || null,
      carried_from: g.carried_from || null,
    };

    if (ambiguous) {
      pairs.push({
        ...base,
        comparable: false,
        why: "More than one reported figure could be this measure, so none was chosen.",
      });
      continue;
    }

    if (!a && nothingFound) {
      pairs.push({ ...base, comparable: false, why: "No reported figure was found for this in the release." });
      continue;
    }

    if (!a) {
      pairs.push({ ...base, comparable: false, why: "No actual was looked for under this metric." });
      continue;
    }

    /* WHAT THE MODEL ANSWERED, KEPT ON EVERY PAIR.
     *
     * A refused pair used to keep only its reason, so a wrong refusal could
     * not be diagnosed from the record - Carnival's missing second quarter had
     * to be re-run by hand to see that the model had simply returned nothing.
     * The answer is small and is the evidence; it stays. */
    base.answer = {
      asked_as: a.asked_as ?? null,
      found_as: a.found_as ?? null,
      section: a.section ?? null,
      period_text: a.period_text ?? null,
      period: a.period ?? null,
      period_why: a.period_why ?? null,
      value: a.value ?? null,
      unit: a.unit ?? null,
      quote: a.quote ?? null,
      second_look: a.second_look || null,
      stated_vs_guide: a.stated_vs_guide || null,
      gaap_recheck: a.gaap_recheck || null,
    };

    const inGuideUnit = sameMoneyUnit(g, a);
    base.actual = thousandsFixed(g, inGuideUnit);
    if (inGuideUnit.value !== a.value) base.actual_scaled = "converted from " + a.unit + " to " + g.unit;
    else if (base.actual !== a.value) base.actual_scaled = "read in thousands; divided by 1,000";
    base.actual_unit = inGuideUnit.unit;
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

    /* A label that names no measure. Constellation's tax-rate line was
       split, and one guide came back labelled just "comparable" - then
       paired with comparable OPERATING MARGIN, 34% against an 18.5% tax
       rate. A label that is only a basis word cannot be matched to anything
       safely. */
    if (/^\s*(comparable|adjusted|reported|gaap|non-?gaap|organic|core|underlying|as reported)\s*$/i
      .test(String(g.metric_as_written || ""))) {
      pairs.push({ ...base, comparable: false, why: "The guide's label names no measure, only a basis." });
      continue;
    }

    /* "Reported" in the guide's own label is the GAAP figure. Constellation's
       "Enterprise operating income growth: reported" (10%-12%) was scored
       against COMPARABLE operating income growth (7%). A guide labelled
       reported or GAAP is never scored against a result labelled
       comparable, adjusted or non-GAAP. */
    if (a.value !== null) {
      const gl = String(g.metric_as_written || "");
      const saysReported = /\b(reported|gaap)\b/i.test(gl) && !/non-?gaap|adjusted|comparable/i.test(gl);
      const took = String(a.found_as || "") + " " + String(a.quote || "").slice(0, 80);
      if (saysReported && /\b(comparable|adjusted|non-?gaap|core)\b/i.test(took)) {
        pairs.push({ ...base, comparable: false,
          why: "The guide is the reported (GAAP) figure; the result found is " + (a.found_as || "an adjusted figure") + "." });
        continue;
      }
    }

    /* THE GUIDE'S OWN YARDSTICK. McCormick writes "2024 earnings per share
       to be in the range of $2.81 to $2.86, compared to $2.52 of earnings
       per share in 2023". $2.52 was its GAAP EPS for 2023; adjusted was
       $2.70. The guide was scored against adjusted EPS ($2.95, "above"),
       whose own line prints $2.70 for the year before. When a guide names
       the prior-year figure it is measured from, the result's line must
       show that same figure for its prior year - or it is a different
       basis, and the pair is refused. */
    if (a.value !== null && typeof a.value === "number") {
      const m = String(g.quote || "").match(/compared\s+(?:to|with)\s+\$\s?(\d[\d,]*\.?\d*)/i);
      if (m && (g.unit === "USD per share" || /^USD /.test(String(g.unit || "")))) {
        const prior = Number(m[1].replace(/,/g, ""));
        const shown = String(a.quote || "").replace(/,/g, "");
        const nums = (shown.match(/\d+\.?\d*/g) || []).map(Number);
        const hasPrior = nums.some((x) => Math.abs(x - prior) < 0.0051);
        // Only when the result's line shows a prior year at all (two or more
        // figures) - a one-figure line proves nothing either way.
        if (!hasPrior && nums.length >= 2 && Math.abs(a.value - prior) > 0.0051) {
          pairs.push({ ...base, comparable: false,
            why: "The guide is measured from $" + prior + " last year; the result's line shows a different prior-year figure, so it is a different basis (GAAP vs adjusted)." });
          continue;
        }
      }
    }

    /* A guide for one part of the company is never scored against the
       whole. If the result's own line is the consolidated, total or
       enterprise figure and does not name the part, the pair is refused -
       left unscored rather than scored wrongly. */
    if (g.segment && a.value !== null) {
      const where = String(a.found_as || "") + " " + String(a.quote || "");
      const namesPart = new RegExp("\\b" + String(g.segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(where);
      if (!namesPart && /\b(consolidated|total|enterprise|company[- ]wide)\b/i.test(where)) {
        pairs.push({ ...base, comparable: false, segment: g.segment,
          why: "The guide is for " + g.segment + " only; the figure found is for the whole company." });
        continue;
      }
    }

    if (a.value === null) {
      pairs.push({ ...base, comparable: false, why: "No reported figure was found for this in the release." });
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

export function ratioWords(r) {
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
/**
 * A money result read in THOUSANDS where the guide is in millions.
 *
 * Helen of Troy states its results in thousands ("Adjusted EBITDA $ 289,322")
 * and guides in millions ("$292 million to $295 million"). On 1 Oct 2026 a
 * re-asked answer came back as 289,322 "USD millions", and the pair read
 * $289bn against a $295m guide - scored "above". The figure was right; the
 * scale was not.
 *
 * Corrected only when all of these hold: both sides are money in the same
 * unit; the result is between 300 and 3,000 times the guide (a thousand-fold
 * slip, not a real beat); and the result is printed in its own quote with a
 * thousands separator, exactly as read. Anything else is left alone - the
 * size check in score.js is there for the rest.
 */
/**
 * A money result in the guide's own scale.
 *
 * Lamb Weston guided fiscal 2023 net sales as "$5.25 billion to $5.35
 * billion" and reports in millions ("$5,350.6"); the answer came back as
 * 5,350.6 USD millions and was compared, as a bare number, with 5.35 - an
 * "above" by a thousand times. Millions and billions are the same measure in
 * two scales: the result is put in the guide's before anything compares
 * them. Nothing else is converted.
 */
function sameMoneyUnit(g, a) {
  const scale = { "USD millions": 1e6, "USD billions": 1e9 };
  const from = scale[a.unit], to = scale[g.unit];
  if (!from || !to || from === to || typeof a.value !== "number") return a;
  return { ...a, value: Number((a.value * from / to).toFixed(6)), unit: g.unit };
}

function thousandsFixed(g, a) {
  const v = a.value;
  if (typeof v !== "number") return v;
  const money = /^USD (millions|billions)$/;
  if (!money.test(String(g.unit || "")) || a.unit !== g.unit) return v;
  const ends = [g.low, g.high, g.value].filter((x) => typeof x === "number" && x !== 0);
  if (!ends.length) return v;
  const mid = ends.reduce((x, y) => x + y, 0) / ends.length;
  const ratio = Math.abs(v / mid);
  if (ratio < 300 || ratio > 3000) return v;
  // As printed, with or without its decimals: Helen of Troy "289,322",
  // Lamb Weston "5,350.6" (millions, against a guide in billions).
  const q = String(a.quote || "");
  const printed = [
    Math.round(Math.abs(v)).toLocaleString("en-US"),
    Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 3 }),
  ];
  if (!printed.some((x) => q.includes(x))) return v;
  return Number((v / 1000).toFixed(6));
}

/* Measures a deal does not disturb: they are stated without the deal. */
const DEAL_PROOF = /\b(organic|comparable|like[-\s]for[-\s]like|same[-\s]store|excluding (acquisitions|divestitures|m&a)|ex[-\s]m&a|core sales)\b/i;

/**
 * Mark each pair with a completed deal (8-K item 2.01) filed between its
 * guide and its result. score.js cautions (†) such a pair rather than
 * refusing it: most deals are small against the whole company, and the
 * figure is still the company's; but a guide made before a spin-off is for a
 * different company than the result. Organic and comparable measures are
 * stated without the deal and are left alone.
 */
function markAcrossDeals(pairs, dates) {
  const deals = (dates && dates.deals) || [];
  const actualFiled = dates && dates.actualFiled;
  if (!deals.length || !actualFiled) return;
  for (const p of pairs) {
    if (!p.comparable) continue;
    if (DEAL_PROOF.test(String(p.metric_as_written || ""))) continue;
    const guideFiled = (p.guide_updated && p.guide_updated.filed) || p.guide_filed || dates.guideFiled;
    if (!guideFiled) continue;
    const d = deals.find((x) => String(x.filed) > String(guideFiled) && String(x.filed) <= String(actualFiled));
    if (d) p.deal_between = { filed: d.filed, accession: d.accession };
  }
}

export function refuseAcrossSplit(pairs, dates) {
  markAcrossDeals(pairs, dates);
  const changes = (dates && dates.changes) || [];
  const actualFiled = dates && dates.actualFiled;
  if (!changes.length || !dates || !dates.guideFiled || !actualFiled) return pairs;

  for (const p of pairs) {
    if (!p.comparable || p.unit !== "USD per share" || typeof p.actual !== "number") continue;
    // A guide replaced mid-quarter dates from the update, not the release.
    const guideFiled = (p.guide_updated && p.guide_updated.filed) || p.guide_filed || dates.guideFiled;
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

/**
 * A guide whose period had not ended when the next release was filed.
 *
 * Every full-year guide is carried to the next quarter's release and asked
 * about there, where the year is still running. The answer is nothing - or a
 * year-to-date figure the model cannot tell apart from others - and the pair
 * was refused as "the release does not report this figure" or "more than one
 * reported figure could be this measure". Both are wrong about what happened,
 * and the email counted each as "a guided period left out, no matching
 * reported figure found". United's showed three.
 *
 * Marked, not dropped: the record keeps it, the reason says what is true, and
 * the email does not count it as a gap.
 */
export function markOpenAtAnswer(pairs, answerFiled, cal) {
  if (!answerFiled || !cal) return pairs;
  for (const p of pairs) {
    if (p.comparable || !p.guide_period) continue;
    let closed = true;
    try { closed = periodIsClosedBy(p.guide_period, answerFiled, cal); } catch { closed = true; }
    if (closed) continue;
    p.open_at_answer = true;
    p.why = "The period had not ended when the next release was filed, so there was no result to compare yet.";
  }
  return pairs;
}

/**
 * Guides to carry forward to this release from older ones.
 *
 * Each release's results were compared only with the release just before it.
 * United guides full-year EPS in January and July and usually says nothing
 * about the year in October - so when January's release reports the year, the
 * release before it (October) had no full-year guide, and FY2023, FY2024 and
 * FY2025 were never scored at all.
 *
 * The guide in force when a period ends is the LATEST one given for it,
 * wherever it was given. So: every guide from an older release whose period
 * ended after the previous release and before this one - which makes this the
 * release that reports it - and that the previous release did not restate.
 * Newest first, so the latest version wins.
 *
 * `older` is [{ guides, filed, accession }] newest first, beginning with the
 * release before the previous one. Returns copies marked with where they came
 * from; nothing about the originals changes.
 */
/**
 * The measure, loosely, for deciding whether a later release has REPLACED an
 * older guide.
 *
 * Jabil set a long-range target in March 2024 - "core EPS of $10.65 for
 * FY25" - and from September 2024 guided the same year as "Core diluted
 * earnings per share (Non-GAAP)": $8.65, later $9.33. The two labels gave
 * different keys ("earnings per share" and "diluted earnings per share"), so
 * the newer guides did not block the old target, it was carried to the
 * FY2025 result, and the email reported a $0.90 miss against a number the
 * company had long since replaced.
 *
 * "Diluted", "common" and the "U.S." in "U.S. GAAP" do not change which
 * measure is meant. This looser key is used only to BLOCK a carry: the worst
 * it can do is leave an old guide unscored. It is never used to pair a guide
 * with a result.
 */
function replacedKey(label) {
  return metricKey(label)
    .replace(/\bu s\b/g, " ")
    // "Growth" too: GE guided 2025 adjusted revenue at "10%" in April and
    // then as "adjusted revenue growth" of "mid-teens" in July and October.
    // The later guides were the same measure in other words, and the April
    // 10% was still carried past them.
    .replace(/\b(diluted|common|growth)\b/g, " ")
    .replace(/\bper share(\s+per share)+\b/g, "per share")
    .replace(/\s+/g, " ")
    .trim();
}

export function guidesToCarry(older, inForce, answerFiled, priorFiled, cal) {
  if (!cal || !answerFiled || !priorFiled) return [];
  /* A mention WITHOUT a number blocks too. GE guided 2025 adjusted revenue
     growth at a figure in April and then as "mid-teens" in July and October;
     the April number was carried past both and scored as the guide in force.
     A later release that restates the guide in words has replaced it, even
     though there is no figure left to score. So every key a newer release
     mentions is blocked, whether or not it carries a number. */
  const has = new Set();
  for (const g of inForce || []) {
    if (!g.period) continue;
    has.add(replacedKey(g.metric_as_written || g.metric) + "|" + g.period);
  }
  /* Names the company has gone by in the NEWER releases. An older guide for
     a part by one of those names is a guide for the company - see
     labelAsCompany. `older` runs newest first, so the set grows as it goes. */
  const laterNames = namesSaidBy(inForce);
  const out = [];
  for (const src of older || []) {
    for (const g of src.guides || []) {
      if (!g.period) continue;
      const key = replacedKey(labelAsCompany(g, laterNames) || g.metric) + "|" + g.period;
      if (has.has(key)) continue;
      if (!hasFigure(g)) { has.add(key); continue; }
      let endsNow = false;
      try {
        endsNow = periodIsClosedBy(g.period, answerFiled, cal) && !periodIsClosedBy(g.period, priorFiled, cal);
      } catch { endsNow = false; }
      if (!endsNow) continue;
      has.add(key);
      out.push({ ...g, filed_from: src.filed, carried_from: src.accession });
    }
    namesSaidBy(src.guides, laterNames);
  }
  return out;
}

function hasFigure(g) {
  return typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number";
}
