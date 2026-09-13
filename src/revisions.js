/**
 * The revision path.
 *
 * Guide against guide, rather than guide against actual.
 *
 * This exists because of Macy's. It produces zero comparable pairs every
 * quarter and that is not a fault - it guides the full year and reports a
 * quarter, so there is nothing to match until the year ends. Under the
 * publication rule it would never appear at all, and a great many retailers
 * are the same.
 *
 * But something happens in every one of its releases. In June it guided net
 * sales of $21.5bn to $21.75bn for the year. In September it guided $21.675bn
 * to $21.825bn, and raised all four of its guides at once. No actual is needed
 * to see that, and for a full-year guider it is the only thing that can be
 * seen for three quarters out of four.
 *
 * It may also be the more valuable half of the product. A company revises more
 * often than it completes a guided period, and a revision is a decision
 * management took deliberately and recently.
 *
 * Nothing here interprets. It reports what moved, in which direction, by how
 * much. Whether a cut is bad news depends on why, and the reader knows his own
 * position.
 */

/* Metric labels drift between releases even at the same company. Walmart wrote
   "Adj. operating income (cc)" in one and "Operating income (cc)" in the next,
   meaning the same line. So matching is on a stripped label. */
function labelKey(guide) {
  return String(guide.metric_as_written || "")
    .toLowerCase()
    .replace(/\badj(\.|usted)?\b/g, "")
    .replace(/\(cc\)|constant[-\s]currency/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The label, without the table's footnote markers.
 *
 * Outlook tables hang reference numbers off their row labels, and they come
 * through verbatim: "Adjusted EBITDA 3 as a percent of total revenue",
 * "Adjusted diluted EPS 3,4". Harmless in a JSON field, wrong in a sentence a
 * subscriber reads.
 *
 * Only a one or two digit number sitting on its own after a word is removed -
 * never a number attached to a unit or a decimal, which would eat the figures
 * the whole product exists to report.
 */
function displayLabel(written) {
  return String(written || "")
    .replace(/([a-zA-Z)])\s+\d{1,2}(?:\s*,\s*\d{1,2})*(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function numbersOf(g) {
  return {
    low: typeof g.low === "number" ? g.low : null,
    high: typeof g.high === "number" ? g.high : null,
    value: typeof g.value === "number" ? g.value : null,
  };
}

function tidy(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

/**
 * A figure, written the way the release wrote it.
 *
 * The first version printed "raised from 21.5 to 21.75 to 21.675 to 21.825
 * USD billions" - four numbers and three "to"s, which nobody can parse. A
 * range needs to look like a range before it reaches an email.
 */
function money(n, unit) {
  if (n === null) return "";
  switch (unit) {
    case "percent": return n + "%";
    case "USD billions": return "$" + n + "bn";
    case "USD millions": return "$" + n + "m";
    case "USD per share": return "$" + n;
    default: return String(n);
  }
}

function figure(g, unit) {
  if (g.low !== null && g.high !== null) {
    return money(g.low, unit) + " to " + money(g.high, unit);
  }
  if (g.value !== null) return money(g.value, unit);
  return "no figure";
}

/**
 * Which way did it move?
 *
 * Both ends are compared, never a midpoint - the same rule the scorer follows,
 * for the same reason. A range that moves up at one end and down at the other
 * has not been raised or cut; it has been narrowed or widened, and saying so
 * is more useful than forcing it into one of two words.
 */
/**
 * Has the company changed shape rather than changed its mind?
 *
 * Honeywell's sales guide went from $38.8bn to $39.8bn to $19.8bn to $20.0bn
 * between two releases. Reported as a "cut" - which is what the arithmetic
 * says - it would be the most damaging line this product could send. Honeywell
 * did not cut its outlook by half. It separated its businesses.
 *
 * A level guide that moves by more than a third is not a revision. No
 * management team cuts revenue by that much between quarters and stays in
 * post; a spin-off, a divestiture or a restatement does it routinely.
 *
 * Growth rates and margins are exempt: those move around for ordinary reasons
 * and a percentage is not a level.
 */
function looksLikeScopeChange(before, after, unit) {
  if (unit === "percent" || !unit || unit === "other") return false;

  const b = before.low !== null ? before.low : before.value;
  const a = after.low !== null ? after.low : after.value;
  if (typeof b !== "number" || typeof a !== "number" || b === 0) return false;

  return Math.abs(a - b) / Math.abs(b) > 0.33;
}

function direction(before, after) {
  if (before.low !== null && before.high !== null && after.low !== null && after.high !== null) {
    const lowMove = after.low - before.low;
    const highMove = after.high - before.high;

    if (lowMove === 0 && highMove === 0) return "unchanged";
    if (lowMove >= 0 && highMove >= 0) return "raised";
    if (lowMove <= 0 && highMove <= 0) return "cut";
    if (lowMove > 0 && highMove < 0) return "narrowed";
    if (lowMove < 0 && highMove > 0) return "widened";
    return "changed";
  }

  const b = before.value !== null ? before.value : before.low;
  const a = after.value !== null ? after.value : after.low;
  if (b === null || a === null) return "changed";
  if (a === b) return "unchanged";
  return a > b ? "raised" : "cut";
}

/* Two short sentences rather than one long one. A reader takes in "they
   raised" and then the figures, which is the order the information matters
   in. */
function describe(label, period, before, after, unit, dir) {
  if (dir === "unchanged") {
    return label + " for " + period + " held at " + figure(after, unit) + ".";
  }
  return label + " for " + period + " " + dir + ". Was " + figure(before, unit)
    + ", now " + figure(after, unit) + ".";
}

/* 2027Q2 comes before 2027Q3; 2026FY before 2027FY. Enough ordering to tell a
   closed period from an open one. */
function periodOrder(period) {
  const m = String(period || "").match(/^(\d{4})(FY|Q([1-4]))$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const quarter = m[3] ? parseInt(m[3], 10) : 5;   // a year sits after its quarters
  return year * 10 + quarter;
}

/**
 * Has this period already been reported?
 *
 * Added because "not repeated" was firing on periods that had simply finished.
 * Walmart guided net sales, operating income and adjusted EPS for Q2, then
 * reported Q2 - and three of its twelve revision lines said those guides had
 * gone missing. They had not gone missing, they had been answered, and the
 * answers were sitting in the comparable pairs directly above.
 *
 * In an email that would read as a company quietly dropping three guides.
 *
 * Two tests, either of which settles it: the current release reports a figure
 * for that period, or the company has moved on to guiding a later quarter of
 * the same year.
 */
function isClosed(period, reportedPeriods, afterGuides) {
  if (!period) return false;
  if (reportedPeriods && reportedPeriods.includes(period)) return true;

  const order = periodOrder(period);
  if (order === null) return false;

  for (const g of afterGuides || []) {
    const other = periodOrder(g.period);
    if (other !== null && other > order && String(g.period).includes("Q") && String(period).includes("Q")) {
      return true;
    }
  }
  return false;
}

/**
 * Two releases of guidance, compared.
 *
 * Only guides carrying numbers are compared - a qualitative guide has nothing
 * to move. A guide present in one release and not the other is reported as
 * such rather than as a change: a company that simply did not repeat a figure
 * has not withdrawn it, and saying it did would be an accusation.
 */
export function revisionsBetween(beforeGuides, afterGuides, opts) {
  const options = opts || {};
  const reportedPeriods = options.reportedPeriods || [];

  const index = new Map();
  for (const g of beforeGuides || []) {
    const n = numbersOf(g);
    if (n.low === null && n.high === null && n.value === null) continue;
    if (!g.period) continue;
    index.set(labelKey(g) + "|" + g.period, g);
  }

  const seen = new Set();
  const out = [];

  for (const g of afterGuides || []) {
    const n = numbersOf(g);
    if (n.low === null && n.high === null && n.value === null) continue;

    // "organic growth for null is guided for the first time" reached a summary
    // once. A guide whose period could not be read cannot be placed on a
    // revision path, and saying nothing is better than saying null.
    if (!g.period) continue;

    const label = displayLabel(g.metric_as_written);
    const key = labelKey(g) + "|" + (g.period || "");
    const before = index.get(key);

    if (!before) {
      out.push({
        metric: label,
        metric_as_written: g.metric_as_written,
        period: g.period,
        unit: g.unit,
        direction: "new",
        after: n,
        summary: label + " for " + g.period + " is guided for the first time at "
          + figure(n, g.unit) + ".",
        quote: g.quote,
      });
      continue;
    }

    seen.add(key);
    const b = numbersOf(before);
    const scope = looksLikeScopeChange(b, n, g.unit);
    const dir = scope ? "scope change" : direction(b, n);

    out.push({
      metric: label,
      metric_as_written: g.metric_as_written,
      period: g.period,
      unit: g.unit,
      direction: dir,
      before: b,
      after: n,
      moveLow: b.low !== null && n.low !== null ? tidy(n.low - b.low) : null,
      moveHigh: b.high !== null && n.high !== null ? tidy(n.high - b.high) : null,
      movePoint: b.value !== null && n.value !== null ? tidy(n.value - b.value) : null,
      wasReaffirmed: Boolean(g.was_reaffirmed),
      relativeMove: (() => {
        const bb = b.low !== null ? b.low : b.value;
        const aa = n.low !== null ? n.low : n.value;
        return typeof bb === "number" && typeof aa === "number" && bb !== 0
          ? Math.abs(aa - bb) / Math.abs(bb) : null;
      })(),
      summary: scope
        ? label + " for " + g.period + " changed scale. Was " + figure(b, g.unit)
          + ", now " + figure(n, g.unit) + ". A move that large is not a revision - it"
          + " usually means a spin-off, a disposal or a restatement has changed what is"
          + " being counted. Not reported as a raise or a cut."
        : describe(label, g.period, b, n, g.unit, dir),
      quote: g.quote,
    });
  }

  // Guided before, absent now. Only worth saying when the period is still
  // open - a guide for a period that has since been reported was answered,
  // not dropped.
  for (const [key, before] of index.entries()) {
    if (seen.has(key)) continue;
    if (isClosed(before.period, reportedPeriods, afterGuides)) continue;

    const label = displayLabel(before.metric_as_written);
    out.push({
      metric: label,
      metric_as_written: before.metric_as_written,
      period: before.period,
      unit: before.unit,
      direction: "not repeated",
      before: numbersOf(before),
      summary: label + " for " + before.period + " was guided at "
        + figure(numbersOf(before), before.unit)
        + " in the previous release and does not appear in this one."
        + " That is not necessarily a withdrawal.",
    });
  }

  /**
   * One scope change taints its neighbours.
   *
   * When Honeywell separated its businesses the sales guide halved, which is
   * unmistakable. But its adjusted earnings per share guide fell 22% in the
   * same release - large, below the scale threshold, and reported as a plain
   * cut. It was not a cut either; the company had fewer businesses.
   *
   * So once any metric in a release has changed scale, every other sizeable
   * move in that same release is noted as possibly part of it. Noted, not
   * relabelled: earnings really may have been cut as well, and the reader is
   * told what is uncertain rather than having it decided for him.
   */
  const scoped = out.some((r) => r.direction === "scope change");
  if (scoped) {
    for (const r of out) {
      if (r.direction === "scope change") continue;
      if (typeof r.relativeMove === "number" && r.relativeMove > 0.15) {
        r.possibleScopeChange = true;
        r.summary += " Another metric in this release changed scale, so some of this move"
          + " may be the same change in what is being counted rather than a revision.";
      }
    }
  }

  const tally = {};
  for (const r of out) tally[r.direction] = (tally[r.direction] || 0) + 1;

  return { revisions: out, tally };
}
