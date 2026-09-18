/**
 * How a figure is written, how a period is written, and what order periods go
 * in.
 *
 * There was one of these already, private to revisions.js, and the record
 * blocks in the email had their own version that printed the bare number - so
 * the same guide appeared twice in one email, once as "$2.80" and once as
 * "2.8". "Adjusted EBITDA - guided 68, reported 69" on a company with $22bn of
 * quarterly revenue reads as a broken number.
 *
 * The period label arrived here for the same reason, one change later: the
 * record block printed "Q4 2025" and the revision line under it printed
 * "2026Q4", in the same email, about the same company.
 *
 * So one definition, imported by everything that prints.
 */

/**
 * A single number, in its unit.
 *
 * PER-SHARE FIGURES CARRY TWO DECIMALS, ALWAYS. A guide of "$1.00 to $2.00"
 * was printing as "$1 to $2" beside a result of "$1.99", and money written
 * without its cents looks like a number someone rounded rather than a number
 * a company published. Every other unit keeps the precision it arrived with -
 * Broadcom guides $29.4bn and reports $29.6bn, and padding those to two
 * decimals would invent precision the company did not state.
 *
 * Unknown units fall through to the bare number rather than guessing a symbol.
 * A wrong unit is worse than none: "$66bn" against an operating margin guide
 * is a fabricated number, and this product does not print those.
 */
export function formatValue(n, unit) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  switch (unit) {
    case "percent": return n + "%";
    case "USD billions": return "$" + n + "bn";
    case "USD millions": return "$" + n + "m";
    case "USD per share": return "$" + n.toFixed(2);
    // A ratio in turns. Delta guides "adjusted debt to EBITDAR 2x - 3x", and
    // leverage, coverage and turns guides across several sectors are written
    // the same way. Printed bare, "2 to 3" beside a column of percentages and
    // dollar figures reads as a number missing its unit.
    case "multiple": return n + "x";
    default: return String(n);
  }
}

/**
 * A guide: a range if it has two ends, a point if it has one.
 *
 * Tested on the number rather than on `!== null`, because the pairs the email
 * renders may carry undefined where the revision path carries null, and
 * "undefined to undefined" is the kind of line that ends a subscription.
 */
export function formatFigure(guide, unit) {
  const g = guide || {};
  const hasLow = typeof g.low === "number" && Number.isFinite(g.low);
  const hasHigh = typeof g.high === "number" && Number.isFinite(g.high);
  const hasValue = typeof g.value === "number" && Number.isFinite(g.value);

  if (hasLow && hasHigh) {
    return formatValue(g.low, unit) + " to " + formatValue(g.high, unit);
  }
  if (hasValue) return formatValue(g.value, unit);
  if (hasLow) return formatValue(g.low, unit);
  if (hasHigh) return formatValue(g.high, unit);
  return "no figure";
}

/**
 * 2026Q2 reads as "Q2 2026"; 2026FY as "FY2026".
 *
 * The stored form sorts; the written form reads. The record block has always
 * used this; the revision summaries were built from the raw stored string, so
 * one email carried "Q4 2025" in its table and "2026Q4" in the paragraph
 * underneath.
 *
 * Anything that does not match the stored form is passed through untouched
 * rather than mangled. A period that could not be parsed is a problem
 * upstream, and printing it verbatim is how it gets noticed.
 */
export function periodLabel(period) {
  const m = String(period || "").match(/^(\d{4})(FY|Q([1-4]))$/);
  if (!m) return String(period || "");
  return m[2] === "FY" ? "FY" + m[1] : "Q" + m[3] + " " + m[1];
}

/**
 * Where a period sits in time, for putting rows in order.
 *
 * The blocks were sorted on the stored string, which is alphabetical, so
 * "2026FY" landed before "2026Q1" - F comes before Q. Walmart's record read
 * Q2 2027, Q1 2027, Q3 2026, Q2 2026, Q1 2026, FY2026, and the full year sat
 * three rows below the quarters it followed.
 *
 * THE FULL YEAR SORTS WHERE Q4 WOULD BE, because for these companies that is
 * what it is. Walmart guides a fourth quarter and then reports a year instead
 * of one, so the year-end row IS the answer to Q4 and belongs in Q4's place.
 *
 * Deliberately NOT the same as periodOrder in revisions.js, which puts the
 * full year after its own quarters. That one answers "has this period been
 * overtaken", where a year is not closed until its quarters are. This one
 * answers "what goes above what". Same input, two honest answers, so they stay
 * apart.
 */
export function periodSortKey(period) {
  const m = String(period || "").match(/^(\d{4})(FY|Q([1-4]))$/);
  if (!m) return -1;
  const year = parseInt(m[1], 10);
  const slot = m[2] === "FY" ? 4 : parseInt(m[3], 10);
  return year * 10 + slot;
}
