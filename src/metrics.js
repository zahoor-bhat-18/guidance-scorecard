/**
 * What counts as one measure.
 *
 * This lived in the backfill script, and the email quietly grew its own
 * version - group by whatever the company called it. Two places deciding the
 * same thing, and they disagreed.
 *
 * The disagreement was visible: Broadcom's record showed Adjusted EBITDA with
 * seven matched pairs and revenue with four, and the email showed "Fourth
 * quarter revenue guidance" with three. Broadcom names the quarter inside the
 * label, so the email split one measure into four, and only the fourth-quarter
 * group cleared the three-pair bar. Everything else was silently dropped, and
 * a company with a twelve-period record looked like one with six.
 *
 * So there is one definition and both import it.
 */

/**
 * The key two labels share when they mean the same measure.
 *
 * Everything that is scaffolding comes off: the period, the words that mark a
 * forecast, parenthetical asides, footnote markers, the adjusted and constant
 * currency qualifiers, and the prefixes that only say "the whole company".
 *
 * Each removal was earned by a real split:
 *   Broadcom - "First quarter Adjusted EBITDA guidance" against "Fourth
 *              quarter Adjusted EBITDA guidance"
 *   Walmart  - "Net sales (cc)" against "Consolidated net sales (cc)"
 *   United   - 'Adjusted diluted earnings per share' against the same with
 *              '("EPS")' appended
 *   Macy's   - "Adjusted EBITDA as a percent of total revenue" renamed "Core
 *              Adjusted EBITDA as a percent of total revenue"
 *   Delta    - "Earnings Per Share" in the table, "adjusted EPS" in the prose
 */
export function metricKey(guide) {
  const written = typeof guide === "string" ? guide : (guide && guide.metric_as_written);
  return String(written || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(first|second|third|fourth)\s+quarter\b/g, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+quarter\b/g, " ")
    .replace(/\bof\s+fiscal\s+year\s*\d{2,4}\b/g, " ")
    .replace(/\bfiscal\s+(year\s+)?\d{2,4}\b/g, " ")
    .replace(/\bfull[-\s]?year\b/g, " ")
    .replace(/\b[1-4]q\s?\d{0,4}\b/g, " ")
    .replace(/\bq[1-4]\b/g, " ")
    .replace(/\bfy\s?\d{2,4}\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(guidance|outlook|forecast|expectations?|expected|projected)\b/g, " ")
    .replace(/\badj(\.|usted)?\b/g, " ")
    .replace(/\bcore\b/g, " ")
    .replace(/\bconstant[-\s]currency\b/g, " ")
    // "Enterprise" is Constellation's word for the whole company.
    .replace(/\b(consolidated|total|company|enterprise)\b/g, " ")
    .replace(/\beps\b/g, "earnings per share")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name to print for a measure, given every label the company has used for
 * it.
 *
 * The shortest cleaned variant, because the alternative is whichever arrived
 * first - and that was "Second quarter fiscal year 2026 Adjusted EBITDA
 * guidance" heading a group spanning six different quarters.
 *
 * Footnote markers go: outlook tables hang reference numbers off their row
 * labels and they arrive verbatim, so "Organic 1 Growth" and "Adjusted
 * earnings per share 2,3" were reaching the page.
 */
export function displayLabel(labels) {
  const list = Array.isArray(labels) ? labels : [labels];

  const cleaned = list
    .map((l) => String(l || "")
      // Footnote markers, as numbers AND as asterisks or daggers. GE writes
      // "Adjusted EPS*" and "Free Cash Flow*" in its outlook table, with the
      // non-GAAP reconciliation note at the foot of the page, and the marker
      // arrived in the email as though it were part of the measure's name.
      .replace(/([a-zA-Z)])\s*[*\u2020\u2021]+(?=\s|$)/g, "$1")
      .replace(/([a-zA-Z)])\s+\d{1,2}(?:\s*,\s*\d{1,2})*(?=\s|$)/g, "$1")
      .replace(/\b(first|second|third|fourth)\s+quarter\b/gi, " ")
      .replace(/\bof\s+fiscal\s+year\s*\d{2,4}\b/gi, " ")
      .replace(/\bfiscal\s+year\s*\d{2,4}\b/gi, " ")
      .replace(/\b(guidance|outlook)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter((l) => l.length >= 3)
    .sort((a, b) => a.length - b.length);

  const chosen = cleaned[0] || String(list[0] || "");

  /**
   * Capitalised, because these open sentences and head columns.
   *
   * The label arrives as the company wrote it in its own table, which is
   * sometimes "revenue" and sometimes "Adjusted EBITDA". So one email carried
   * "revenue" as a heading directly beside "Adjusted EBITDA", and a revision
   * line began "adjusted diluted earnings per share for Q3 2026" - which reads
   * as a typo rather than as the company's own wording.
   *
   * ONLY THE FIRST CHARACTER. Title case would turn "non-GAAP" into "Non-Gaap"
   * and "EPS" into "Eps"; the company's own capitalisation inside the label is
   * the company's business.
   */
  return chosen.charAt(0).toUpperCase() + chosen.slice(1);
}

/**
 * A guide's label without the name of its part, when that part has since
 * become the company itself.
 *
 * In January 2024 General Electric guided "GE Aerospace: operating profit" of
 * $6.0bn to $6.5bn, GE Aerospace then being one of its businesses. From April
 * 2024 GE Aerospace WAS the company, and its releases raised "operating
 * profit" three times. The labels differed, so the January guide was never
 * seen as replaced, and it was scored against the year's result as the guide
 * in force.
 *
 * `laterNames` holds the headline names of the releases filed AFTER the
 * guide (lower case). Only an exact match counts: "GE Vernova", spun off and
 * never the name on a later GE release, stays a part.
 */
export function labelAsCompany(g, laterNames) {
  const label = String((g && g.metric_as_written) || "");
  const part = String((g && g.segment) || "").trim();
  if (!part || !laterNames || !laterNames.has(part.toLowerCase())) return label;
  const esc = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = label.replace(new RegExp("^\\s*" + esc + "\\s*:?\\s*", "i"), "").trim();
  return rest || label;
}

/** The headline names carried on a set of guides, lower case. */
export function namesSaidBy(guides, into) {
  const out = into || new Set();
  for (const g of guides || []) if (g && g.said_by) out.add(String(g.said_by).toLowerCase().trim());
  return out;
}
