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
 * But something happens in every one of its releases. In March it guided net
 * sales of $21.4bn to $21.65bn for the year. In June it guided $21.5bn to
 * $21.75bn. They raised. No actual is needed to see that, and for a full-year
 * guider it is the only thing that can be seen for three quarters out of four.
 *
 * It may also be the more valuable half of the product. A company revises more
 * often than it completes a guided period, and the revision is a decision
 * management took deliberately and recently. A serial raiser that merely
 * reaffirms has said something, and said it quietly.
 *
 * Nothing here interprets. It reports what moved, in which direction, by how
 * much. Whether a cut is bad news depends on why, and the reader knows his own
 * position.
 */

/* Metric labels drift between releases even at the same company. Walmart wrote
   "Adj. operating income (cc)" in one and "Operating income (cc)" in the next,
   meaning the same line. So matching is on a stripped label, and falls back to
   the internal metric name when the wording has moved too far. */
function labelKey(guide) {
  return String(guide.metric_as_written || "")
    .toLowerCase()
    .replace(/\badj(\.|usted)?\b/g, "")
    .replace(/\(cc\)|constant[-\s]currency/g, "")
    .replace(/[^a-z ]/g, " ")
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

function unitWord(unit) {
  return unit === "percent" ? "percentage points" : unit || "";
}

/**
 * Which way did it move?
 *
 * Both ends are compared, never a midpoint - the same rule the scorer follows,
 * for the same reason. A range that moves up at one end and down at the other
 * has not been raised or cut; it has been narrowed or widened, and saying so
 * is more useful than forcing it into one of two words.
 */
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

function describe(metric, period, before, after, unit, dir) {
  const word = unitWord(unit);
  const range = (g) =>
    g.low !== null && g.high !== null ? g.low + " to " + g.high
      : g.value !== null ? String(g.value)
      : "no figure";

  if (dir === "unchanged") {
    return metric + " for " + period + " held at " + range(after) + " " + word + ".";
  }
  return metric + " for " + period + " " + dir + " from " + range(before)
    + " to " + range(after) + " " + word + ".";
}

/**
 * Two releases of guidance, compared.
 *
 * Only guides carrying numbers are compared - a qualitative guide has nothing
 * to move. A guide present in one release and not the other is reported as
 * such rather than as a change: a company that simply did not repeat a figure
 * has not withdrawn it, and saying it did would be an accusation.
 */
export function revisionsBetween(beforeGuides, afterGuides) {
  const index = new Map();
  for (const g of beforeGuides || []) {
    const n = numbersOf(g);
    if (n.low === null && n.high === null && n.value === null) continue;
    index.set(labelKey(g) + "|" + (g.period || ""), g);
  }

  const seen = new Set();
  const out = [];

  for (const g of afterGuides || []) {
    const n = numbersOf(g);
    if (n.low === null && n.high === null && n.value === null) continue;

    const key = labelKey(g) + "|" + (g.period || "");
    const before = index.get(key);

    if (!before) {
      out.push({
        metric: g.metric_as_written,
        period: g.period,
        unit: g.unit,
        direction: "new",
        after: n,
        summary: g.metric_as_written + " for " + g.period + " is guided for the first time at "
          + (n.low !== null ? n.low + " to " + n.high : n.value) + " " + unitWord(g.unit) + ".",
        quote: g.quote,
      });
      continue;
    }

    seen.add(key);
    const b = numbersOf(before);
    const dir = direction(b, n);

    out.push({
      metric: g.metric_as_written,
      period: g.period,
      unit: g.unit,
      direction: dir,
      before: b,
      after: n,
      moveLow: b.low !== null && n.low !== null ? tidy(n.low - b.low) : null,
      moveHigh: b.high !== null && n.high !== null ? tidy(n.high - b.high) : null,
      movePoint: b.value !== null && n.value !== null ? tidy(n.value - b.value) : null,
      wasReaffirmed: Boolean(g.was_reaffirmed),
      summary: describe(g.metric_as_written, g.period, b, n, g.unit, dir),
      quote: g.quote,
    });
  }

  // Guided before, absent now. Reported plainly, with no verdict attached.
  for (const [key, before] of index.entries()) {
    if (seen.has(key)) continue;
    out.push({
      metric: before.metric_as_written,
      period: before.period,
      unit: before.unit,
      direction: "not repeated",
      before: numbersOf(before),
      summary: before.metric_as_written + " for " + before.period
        + " was guided in the previous release and does not appear in this one."
        + " That is not necessarily a withdrawal.",
    });
  }

  const tally = {};
  for (const r of out) tally[r.direction] = (tally[r.direction] || 0) + 1;

  return { revisions: out, tally };
}
