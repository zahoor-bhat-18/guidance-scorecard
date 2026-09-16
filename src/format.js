/**
 * How a figure is written, and how a period is written.
 *
 * There was one of these already, private to revisions.js, and it was right:
 * the revision lines have always read "$0.62 to $0.64" and "3% to 3.75%".
 * The record blocks in the email had their own version that printed the bare
 * number, so the same guide appeared twice in one email, once as "$2.80" and
 * once as "2.8".
 *
 * Worse than ugly. "Adjusted EBITDA - guided 68, reported 69" on a company
 * with $22bn of quarterly revenue reads as a broken number, and a reader who
 * cannot tell a margin from a level closes the email.
 *
 * The period label arrived here for the same reason, one change later: the
 * record block printed "Q4 2025" and the revision line under it printed
 * "2026Q4", in the same email, about the same company.
 *
 * So one definition, imported by everything that prints. The same arrangement
 * metrics.js has, for the same reason: two copies of a rule disagree
 * eventually, and the disagreement is invisible until a subscriber finds it.
 */

/**
 * A single number, in its unit.
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
    case "USD per share": return "$" + n;
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
