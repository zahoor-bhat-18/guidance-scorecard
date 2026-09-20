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
 *
 * WHAT THIS FILE DECIDES, AND WHAT IT DOES NOT
 *
 * It decides what moved: the matching, the direction, the scope-change test.
 * It does not decide how any of it is written. It owned a copy of the figure
 * formatter, the period formatter and the label cleaner, and all three drifted
 * from the copies the record block uses. The wording lives in summary.js now,
 * and the stored summary here is only a fallback for records built before it
 * existed.
 */

import { revisionSentence } from "./summary.js";

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

function numbersOf(g) {
  const low = typeof g.low === "number" ? g.low : null;
  const high = typeof g.high === "number" ? g.high : null;
  const value = typeof g.value === "number" ? g.value : null;

  /* A RANGE WHOSE ENDS ARE EQUAL IS A POINT. Coca-Cola's first-quarter 2024
     comparable EPS growth arrived as low 8, high 8, and the email printed
     "guided 8% to 8%" - a range from a number to itself, which reads as a
     figure that failed to render. It is a point guide the extraction gave two
     ends to. */
  if (low !== null && high !== null && low === high) {
    return { low: null, high: null, value: low };
  }

  return { low, high, value };
}

/**
 * One guide per measure and period, from a release that stated it more than
 * once.
 *
 * Coca-Cola's release produced two lines about the same thing - "Comparable
 * net revenues for FY2026 held at 1%" directly above "Comparable net revenues
 * for FY2026 raised. Was 1% to 2%, now 2% to 3%." General Electric produced
 * three for operating profit. Both companies state a measure in the outlook
 * table and again in the prose, and labelKey strips the asterisk and the
 * qualifier that told them apart, so every occurrence was compared separately
 * and each produced its own sentence.
 *
 * Two contradictory sentences about one guide are worse than either alone. A
 * reader cannot tell which is true and stops believing both.
 *
 * A RANGE BEATS A POINT. Where a release states the same guide twice and one
 * reading has two ends and the other one, the range is the fuller reading and
 * the point is usually half of it - Coca-Cola's "held at 1%" is the bottom of
 * "1% to 2%" with the top lost. Between two readings of the same shape the
 * later one wins, on the reasoning the record uses everywhere: the last thing
 * the release says is what management is standing behind.
 *
 * KNOWN LIMIT: where a company genuinely guides a segment and a total under
 * names differing only by a qualifier labelKey removes, this keeps one of
 * them. That is a real loss, and still better than printing both as though
 * they contradicted each other. Telling them apart needs labelKey to stop
 * stripping the qualifier, which would split measures that today group
 * correctly.
 */
function oneGuidePerPeriod(guides) {
  const byKey = new Map();

  for (const g of guides || []) {
    const n = numbersOf(g);
    if (n.low === null && n.high === null && n.value === null) continue;
    if (!g.period) continue;

    const key = labelKey(g) + "|" + g.period;
    const held = byKey.get(key);
    if (!held) { byKey.set(key, g); continue; }

    const heldNumbers = numbersOf(held);
    const heldIsRange = heldNumbers.low !== null && heldNumbers.high !== null;
    const isRange = n.low !== null && n.high !== null;

    if (isRange || !heldIsRange) byKey.set(key, g);
  }

  return Array.from(byKey.values());
}

function tidy(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
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
function looksLikeScopeChange(before, after, unit, label) {
  if (unit === "percent" || !unit || unit === "other") return false;

  // Earnings are exempt. United cut adjusted earnings per share from $12-14 to
  // $7-11 on fuel prices - a 42% cut, brutal and entirely real - and it was
  // reported as a spin-off. Earnings are leveraged and can halve for ordinary
  // reasons. Revenue and cash flow cannot: those halve when the company does.
  if (/eps|earnings per share|earnings/i.test(String(label || ""))) return false;

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

/* 2027Q2 comes before 2027Q3; 2026FY before 2027FY. Enough ordering to tell a
   closed period from an open one. Ordering works on the stored form of the
   period, never on the written one. */
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
export function revisionsBetween(rawBefore, rawAfter, opts) {
  const options = opts || {};
  const reportedPeriods = options.reportedPeriods || [];

  // Both sides, before anything is compared. A release that states a guide
  // twice must not produce two revision lines, and a PREVIOUS release that
  // stated it twice must not leave the wrong reading as the thing moved from.
  const beforeGuides = oneGuidePerPeriod(rawBefore);
  const afterGuides = oneGuidePerPeriod(rawAfter);

  /**
   * The previous release's readings, ALL of them, by measure and period.
   *
   * Collapsing the before side to one reading the way the after side is
   * collapsed produced a new lie. Coca-Cola's email read "Comparable net
   * revenues for FY2026 cut. Was 4%, now 2% to 3%" - a cut the company never
   * made. Both releases had stated that guide twice, and the two sides were
   * collapsed independently: the after side kept a range, the before side kept
   * a point from a different sentence, and the arithmetic between them
   * invented a revision.
   *
   * So the before side keeps every reading, and the one compared against is
   * the one whose SHAPE matches what the company is saying now. A range is
   * measured against the range it replaced, a point against a point. Only when
   * no reading matches does it fall back, and then to a range over a point,
   * for the same reason the after side prefers one: a point is usually half of
   * a range with the other end lost.
   */
  const index = new Map();
  for (const g of rawBefore || []) {
    const n = numbersOf(g);
    if (n.low === null && n.high === null && n.value === null) continue;
    if (!g.period) continue;

    const key = labelKey(g) + "|" + g.period;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(g);
  }

  /* The reading to measure against: same shape first, then a range, then
     whatever came last. */
  function readingFor(key, after) {
    const readings = index.get(key);
    if (!readings || !readings.length) return null;

    const wantRange = after.low !== null && after.high !== null;
    const shaped = readings.filter((r) => {
      const n = numbersOf(r);
      const isRange = n.low !== null && n.high !== null;
      return isRange === wantRange;
    });
    if (shaped.length) return shaped[shaped.length - 1];

    const ranges = readings.filter((r) => {
      const n = numbersOf(r);
      return n.low !== null && n.high !== null;
    });
    if (ranges.length) return ranges[ranges.length - 1];

    return readings[readings.length - 1];
  }

  const seen = new Set();
  const out = [];

  for (const g of afterGuides) {
    const n = numbersOf(g);
    const key = labelKey(g) + "|" + (g.period || "");
    const before = readingFor(key, n);

    if (!before) {
      const row = {
        metric: g.metric,
        metric_as_written: g.metric_as_written,
        period: g.period,
        unit: g.unit,
        direction: "new",
        after: n,
        quote: g.quote,
      };
      row.summary = revisionSentence(row);
      out.push(row);
      continue;
    }

    seen.add(key);
    const b = numbersOf(before);
    const scope = looksLikeScopeChange(b, n, g.unit, g.metric_as_written);
    const dir = scope ? "scope change" : direction(b, n);

    const row = {
      metric: g.metric,
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
      quote: g.quote,
    };
    row.summary = revisionSentence(row);
    out.push(row);
  }

  // Guided before, absent now. Only worth saying when the period is still
  // open - a guide for a period that has since been reported was answered,
  // not dropped.
  for (const [key, readings] of index.entries()) {
    if (seen.has(key)) continue;
    const before = readings[readings.length - 1];
    if (isClosed(before.period, reportedPeriods, afterGuides)) continue;

    const row = {
      metric: before.metric,
      metric_as_written: before.metric_as_written,
      period: before.period,
      unit: before.unit,
      direction: "not repeated",
      before: numbersOf(before),
    };
    row.summary = revisionSentence(row);
    out.push(row);
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
        r.summary = revisionSentence(r) || r.summary;
      }
    }
  }

  const tally = {};
  for (const r of out) tally[r.direction] = (tally[r.direction] || 0) + 1;

  return { revisions: out, tally };
}
