/**
 * THE CHECK BEFORE ANY SUBSCRIBER IS EMAILED.
 *
 * Every mistake found in a live email so far was of one of five kinds, and
 * each kind can be seen from the record and the filing text before sending:
 *
 *   1. A guide the model read, whose figure the number guard then threw away
 *      (Wells Fargo, October 2026: "+/- $50 billion" read as $49.95-50.05bn).
 *   2. A guide-shaped line in the release that no guide accounts for, even
 *      after the second look.
 *   3. A result whose figure is not in its own quote, or whose quote is not
 *      in the filing.
 *   4. A guide called "not repeated" while its measure and figure still sit
 *      together in the release.
 *   5. A guide called "new" beside a "not repeated" guide of the same kind
 *      for the same period - usually one guide worded two ways (UnitedHealth,
 *      October 2026: a raise printed as new).
 *
 * The answer is a list of problems in plain words. Empty means the email may
 * go. Anything else holds the email for review: it goes to the owner only,
 * with the list at the top. A false alarm costs a delay; a wrong number in a
 * PM's inbox costs the product.
 */
import { missedGuideHits } from "./guidance.js";
import { numberInQuote } from "./actuals.js";
import { formatFigure, periodLabel } from "./format.js";

const flat = (s) => String(s || "").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\s+/g, " ").toLowerCase().trim();

/* Is the quote in the filing? Whitespace, case and thousands commas aside.
   A long quote is matched on its first 60 characters - the model sometimes
   joins a table row and its heading with " ... ". */
function quoteInText(quote, text) {
  const q = flat(quote).split(/\s*\.\.\.\s*|\s*…\s*/)[0];
  if (q.length < 8) return true;
  return flat(text).includes(q.slice(0, 60));
}

const short = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/* The words of a measure's name that carry meaning, for finding it in text. */
function coreWords(label) {
  return String(label || "").toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(adjusted|adj|gaap|non|reported|total|fy\d*|full|year|outlook|guidance|expected|expect|the|of|and|to|for|per|its|our)\b/g, " ")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/).filter((w) => w.length > 2);
}

/* Do the measure's words and one of its figures sit within a short stretch
   of the text? */
function stillStated(label, nums, text, unit) {
  const words = coreWords(label);
  if (!words.length || !nums.length) return false;
  const t = flat(text);
  const first = words[0];
  let at = t.indexOf(first);
  while (at >= 0) {
    const window = t.slice(Math.max(0, at - 80), at + 320);
    if (words.every((w) => window.includes(w)) && nums.some((n) => numberInQuote(n, window))) return true;
    at = t.indexOf(first, at + first.length);
  }
  return false;
}

/* Lines the second look has already been shown and that are not guides:
   results ("were $836 million compared to $776 million"), footnotes,
   effects inside a guide ("includes a benefit of approximately $0.30 to
   $0.45 from tariff refunds"), and executives' quotations. Holding an email
   for these would be a false alarm every quarter. */
export function notAGuideLine(line) {
  const l = String(line || "").trim();
  const future = /\b(expects?|expected|expecting|outlook|guidance|guides?|forecast|anticipates?|projects?|will be|now sees)\b/i.test(l);
  if (/^(\(\w{1,3}\)|\*+|\d{1,2}\)|\[\d+\])/.test(l)) return true;
  if (/^[“"]|[”"]\s*,?\s*said\b/i.test(l)) return true;
  if (/\b(benefit|headwind|tailwind|impact|charge)s?\s+(of|from)\b|\bincludes?\s+(an?\s+)?(approximate|estimated|after-tax|pre-tax)/i.test(l)) return true;
  if (!future && /\b(was|were|compared (to|with)|versus|vs\.?|last year|prior year|a year ago|year[- ]over[- ]year)\b/i.test(l)) return true;
  return false;
}

export function checkBeforeSend({ text, guides, seen, pairs, revisions }) {
  const problems = [];
  const body = String(text || "");

  // 1. Read, then thrown away.
  for (const g of guides || []) {
    const r = g.reported_numbers;
    if (g.numbers_verified === false && r && [r.low, r.high, r.value].some((x) => typeof x === "number")) {
      problems.push("A guide was read but its figure was not trusted and dropped: " + (g.metric_as_written || "?")
        + (g.period ? " " + periodLabel(g.period) : "") + " - \"" + short(g.quote, 160) + "\"");
    }
  }

  // 2. Guide-shaped lines nothing accounts for.
  if (body) {
    // Everything the reading saw counts as accounted for: the guides, and
    // what was set aside on purpose (an earlier column, a currency effect).
    const counted = [...(guides || []), ...(seen || [])].map((g) => g.reported_numbers ? { ...g, ...g.reported_numbers } : g);
    for (const h of missedGuideHits(body, counted).filter((h) => !notAGuideLine(h.line)).slice(0, 6)) {
      problems.push("A line in the release looks like guidance and was not read: \"" + short(h.line, 220) + "\"");
    }
  }

  // 3. Results that cannot be traced.
  for (const p of pairs || []) {
    if (!p.comparable || typeof p.actual !== "number") continue;
    const quote = p.quote || (p.answer && p.answer.quote) || "";
    const shown = p.score && typeof p.score.actualAsGuided === "number" ? p.score.actualAsGuided : p.actual;
    const computed = p.computed || (p.answer && p.answer.computed);
    if (!computed && quote && !numberInQuote(p.actual, quote) && !numberInQuote(shown, quote)) {
      problems.push("A result is not in its own quote: " + (p.metric_as_written || "?") + " " + periodLabel(p.guide_period || "")
        + " = " + p.actual + " - \"" + short(quote, 140) + "\"");
    } else if (body && quote && !quoteInText(quote, body)) {
      problems.push("A result's quote was not found in the filing: " + (p.metric_as_written || "?") + " " + periodLabel(p.guide_period || "")
        + " - \"" + short(quote, 140) + "\"");
    }
  }

  // 4. "Not repeated", but still there.
  const moved = revisions || [];
  for (const r of moved) {
    if (r.direction !== "not repeated" || !r.before) continue;
    const nums = [r.before.low, r.before.high, r.before.value].filter((x) => typeof x === "number");
    if (body && stillStated(r.metric_as_written, nums, body, r.unit)) {
      problems.push("Shown as no longer guided, but the release still states it: " + (r.metric_as_written || "?") + " "
        + periodLabel(r.period || "") + " (was " + formatFigure(r.before, r.unit) + ")");
    }
  }

  // 5. One guide worded two ways.
  for (const r of moved) {
    if (r.direction !== "new" || !r.metric || r.metric === "other") continue;
    const twin = moved.find((o) => o.direction === "not repeated" && o.metric === r.metric && o.period === r.period
      && o.unit === r.unit);
    if (twin) {
      problems.push("Shown as a new guide, but a guide of the same kind for the same period was dropped - possibly one guide worded two ways: \""
        + (r.metric_as_written || "?") + "\" (new, " + formatFigure(r.after, r.unit) + ") and \"" + (twin.metric_as_written || "?")
        + "\" (was " + formatFigure(twin.before, twin.unit) + "), " + periodLabel(r.period || ""));
    }
  }

  return [...new Set(problems)];
}
