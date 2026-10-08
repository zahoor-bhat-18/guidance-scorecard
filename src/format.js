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
  const m = moneyScale(n, unit);
  if (m) return sign(n) + "$" + m.size + m.suffix;
  const size = Math.abs(n);
  switch (unit) {
    case "percent": return sign(n) + size + "%";
    case "USD per share": return sign(n) + "$" + size.toFixed(2);
    // A ratio in turns. Delta guides "adjusted debt to EBITDAR 2x - 3x", and
    // leverage, coverage and turns guides across several sectors are written
    // the same way. Printed bare, "2 to 3" beside a column of percentages and
    // dollar figures reads as a number missing its unit.
    case "multiple": return sign(n) + size + "x";
    // A change against last year, in basis points: Levi's gross margin "up
    // 130 basis points". The plus is said, because the figure is a movement.
    case "basis points": return (n > 0 ? "+" : sign(n)) + size + " bps";
    default: return String(n);
  }
}

/* A minus sign, not a hyphen, and IN FRONT OF the dollar sign. Carnival's
   second-quarter 2024 guide printed as "$-35m", which reads as a typo. */
function sign(n) {
  return n < 0 ? "\u2212" : "";
}

/**
 * Money in millions is written in billions once it reaches a billion.
 *
 * Carnival guides net income in millions some quarters and billions others,
 * and the email printed "$1800m" beside "$1.86bn" and "raised to $3080m (was
 * $3.07bn)". The same size of number, written two ways, reads as two
 * different sizes. Every digit the company gave is kept: 1,982 becomes
 * $1.982bn, not $2.0bn.
 *
 * `atLeast` lets a range decide once for both ends, so "$950m to $1,050m"
 * prints as "$0.95bn to $1.05bn" rather than one end in each unit.
 */
function moneyScale(n, unit, atLeast) {
  // To the nearest million here too: a median of two gaps ($0.3bn and
  // $3.229bn) printed for Micron as "$1.7645bn".
  if (unit === "USD billions") return { size: Number(Math.abs(n).toFixed(3)), suffix: "bn" };
  if (unit !== "USD millions") return null;
  const big = Math.abs(typeof atLeast === "number" ? atLeast : n) >= 1000;
  if (!big) return { size: Math.abs(n), suffix: "m" };
  // To the nearest million: FactSet reports revenue to the thousand
  // ($2,476.256m), and "$2.476256bn" is noise, not precision.
  return { size: Number((Math.abs(n) / 1000).toFixed(3)), suffix: "bn" };
}

/* A money figure in the scale chosen by the larger end of its range. */
function formatInScale(n, unit, larger) {
  const m = moneyScale(n, unit, larger);
  if (!m) return formatValue(n, unit);
  return sign(n) + "$" + m.size + m.suffix;
}

/**
 * A difference between two figures, written in the unit it was measured in.
 *
 * Percentage guides get POINTS, not percent: a growth rate 1.2 points above
 * its guide is "1.2pp", and "1.2%" would say something else. Money follows the
 * same billion rule as formatValue. `signed` puts a + or − in front.
 */
export function formatGap(d, unit, signed) {
  if (typeof d !== "number" || !Number.isFinite(d)) return "";
  const x = Number(d.toFixed(4));
  const lead = signed ? (x > 0 ? "+" : x < 0 ? "\u2212" : "") : "";
  const size = Math.abs(x);
  const m = moneyScale(size, unit);
  if (m) return lead + "$" + m.size + m.suffix;
  switch (unit) {
    case "percent": return lead + size + "pp";
    case "USD per share": return lead + "$" + size.toFixed(2);
    case "multiple": return lead + size + "x";
    default: return lead + size;
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
    const larger = Math.max(Math.abs(g.low), Math.abs(g.high));
    const lo = Math.min(g.low, g.high), hi = Math.max(g.low, g.high);
    return formatInScale(lo, unit, larger) + " to " + formatInScale(hi, unit, larger);
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

/* Words that stay in capitals when an all-capitals SEC name is set in normal
   case. Everything else becomes Title Case. */
const KEEP_UPPER = new Set(["LLC", "PLC", "LP", "NV", "SA", "AG", "SE", "ASA", "USA", "US", "UK", "AB", "BV", "II", "III", "IV"]);

/**
 * A company name as a reader expects it.
 *
 * SEC's own list spells many names in capitals - "DELTA AIR LINES, INC.",
 * "COCA COLA CO" - which in an email reads as shouting. A name that already
 * has lower-case letters is the company's own styling and is left alone.
 */
export function displayName(name) {
  // SEC appends the state of incorporation to some names: "BERKSHIRE
  // HATHAWAY INC /DE/". A reader does not need it.
  // Also without the closing slash: "WELLS FARGO & COMPANY/MN".
  const s = String(name || "").replace(/\s*\/[A-Za-z]{2,3}\/?\s*$/, "").trim();
  if (!s || /[a-z]/.test(s)) return s;
  return s.split(/(\s+|-)/).map((w) => {
    const bare = w.replace(/[^A-Za-z]/g, "");
    if (!bare) return w;
    if (KEEP_UPPER.has(bare)) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join("");
}
