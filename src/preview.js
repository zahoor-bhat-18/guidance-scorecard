/**
 * The preview: sent before a company reports.
 *
 * Zahoor's product, as agreed on 15 Oct 2026, is three emails a quarter for
 * each company followed: this one before the report, Release Watch minutes
 * after the 8-K, Filing Watch when the 10-Q lands. This one says, for the
 * quarter about to be reported:
 *
 *   - when the report is expected (estimated from the date the company
 *     reported the same quarter a year earlier, and said to be an estimate);
 *   - the guide in force for that quarter and for the year;
 *   - how results have landed against the company's own guide, measure by
 *     measure: how often above, within, below, and by how much from the
 *     guide's midpoint;
 *   - that record applied to today's guide - arithmetic on the company's own
 *     history, shown with its working, and only where there are at least four
 *     scored periods. It is labelled as arithmetic, never as a forecast.
 *
 * Everything here is read from the stored record (records.js). Nothing new is
 * fetched and no model is asked.
 */

import { metricKey, emailSide, displayLabel } from "./metrics.js";
import { formatFigure, formatValue, periodLabel, displayName } from "./format.js";

const MIN_FOR_ARITHMETIC = 4;
const HISTORY_SHOWN = 8;

/* The kinds of measure a reader looks for first, in this order. */
const KEY_ORDER = [
  /\beps\b|earnings per (\w+ )?share/i,
  /revenue|sales|net yield|comparable|organic|net interest income|\bnii\b/i,
  /operating (income|profit|margin)|ebitda|\bebit\b|net income|gross margin|segment margin/i,
  /free cash flow|\bfcf\b|cash flow/i,
];
function rank(label) {
  for (let i = 0; i < KEY_ORDER.length; i++) if (KEY_ORDER[i].test(label)) return i;
  return 9;
}

function unitKind(u) {
  const x = String(u || "").toLowerCase();
  if (/percent|%|basis points|bps|points/.test(x)) return "rate";
  if (/per share/.test(x)) return "per-share";
  if (/usd|\$|dollar/.test(x)) return "money";
  return "other";
}

/* One identity for a guide and the record's rows of the same measure: the
   measure's name, its kind of unit, and its GAAP or adjusted side. */
function keyOf(label, unit, basis, quote) {
  const side = emailSide({ metric_as_written: label, basis, quote });
  return metricKey({ metric_as_written: label, unit }) + "|" + unitKind(unit) + "|" + side;
}

const isQuarter = (p) => /Q[1-4]$/.test(String(p || ""));
const yearOf = (p) => Number(String(p || "").slice(0, 4));
const plusYear = (p) => (yearOf(p) + 1) + String(p).slice(4);

function addDays(iso, n) {
  const d = new Date(String(iso) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function longDate(iso) {
  const d = new Date(String(iso) + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/* The guide's middle: the midpoint of a range, a single figure, or the floor
   or ceiling the company named. */
function midOf(g) {
  if (!g) return null;
  if (typeof g.low === "number" && typeof g.high === "number") return (g.low + g.high) / 2;
  if (typeof g.value === "number") return g.value;
  if (typeof g.low === "number") return g.low;
  if (typeof g.high === "number") return g.high;
  return null;
}

/* How far a result landed from its guide's middle: per cent of the middle for
   amounts, points for rates. Null when the middle is too close to zero for a
   percentage to mean anything. */
function gapOf(actual, mid, unit) {
  if (typeof actual !== "number" || typeof mid !== "number") return null;
  if (unitKind(unit) === "rate") return actual - mid;
  if (Math.abs(mid) < 1e-9 || Math.abs(mid) < Math.abs(actual) * 0.05) return null;
  return (actual - mid) / Math.abs(mid) * 100;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const r1 = (x) => Math.round(x * 10) / 10;
function gapWords(g, unit) {
  if (g === null) return "";
  const v = r1(g);
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return sign + Math.abs(v) + (unitKind(unit) === "rate" ? "pp" : "%");
}
function applied(mid, gap, unit) {
  return unitKind(unit) === "rate" ? mid + gap : mid * (1 + gap / 100);
}
/* A figure computed from a guide is written to the guide's own precision, and
   never more precisely than a cent or a tenth. */
function computedFigure(x, unit, like) {
  const d = String(like).includes(".") ? Math.min(2, String(like).split(".")[1].length) : 0;
  const places = unitKind(unit) === "per-share" ? 2 : Math.max(d, 1);
  return formatValue(Number(x.toFixed(places)), unit);
}

/**
 * The next report: which period, and roughly when.
 *
 * The release four back is the same quarter a year earlier. What it reported
 * (its answered pairs) names the period, one year on; its date, one year on,
 * is the estimate. Where the record is too short, nothing is estimated.
 */
export function nextReport(record) {
  const rel = (record.releasesRead || []).slice().sort((a, b) => String(b.filed).localeCompare(String(a.filed)));
  if (rel.length < 4) return null;
  const sameLastYear = rel[3];
  const answered = (record.pairs || []).filter((p) => p.answeredBy === sameLastYear.accession && p.guide_period)
    .map((p) => p.guide_period);
  let period = null;
  const quarters = answered.filter(isQuarter).sort();
  const years = answered.filter((p) => /FY$/.test(p)).sort();
  if (quarters.length) period = plusYear(quarters[quarters.length - 1]);
  else if (years.length) period = plusYear(years[years.length - 1]);
  let interim = false;
  if (!period) {
    // No pair answered by that release: the earliest quarter now guided.
    const guided = (record.currentGuidance || []).map((g) => g.period).filter(isQuarter).sort();
    period = guided[0] || null;
  }
  if (!period) {
    /* A company that guides only the year (P&G, Elevance, Intuitive) has
       nothing scored at its interim reports, so the release a year earlier
       answered nothing. Its next report is a quarter inside the year now
       guided; the preview is about that year's guide. */
    const years = (record.currentGuidance || []).map((g) => g.period).filter((p) => /FY$/.test(String(p))).sort();
    period = years[0] || null;
    interim = Boolean(period);
  }
  const expected = addDays(sameLastYear.filed, 364);
  return { period, interim, expected, lastYear: sameLastYear.filed, latestFiled: rel[0].filed, latestAccession: rel[0].accession };
}

/**
 * The preview's content, or null when there is nothing worth sending: no
 * report estimated, or no guide in force for the period about to be reported
 * or its year.
 */
export function previewOf(record) {
  const next = nextReport(record);
  if (!next || !next.period) return null;
  const fy = yearOf(next.period) + "FY";
  const wanted = new Set([next.period, fy]);

  const guides = (record.currentGuidance || []).filter((g) => wanted.has(g.period)
    && [g.low, g.high, g.value].some((x) => typeof x === "number"));
  if (!guides.length) return null;

  // The record, by identity.
  const history = new Map();
  for (const p of record.pairs || []) {
    if (!p.comparable || !p.score || typeof p.actual !== "number") continue;
    const k = keyOf(p.metric_as_written, p.unit, p.basis, p.guide_quote) + "|" + (isQuarter(p.guide_period) ? "q" : "y");
    if (!history.has(k)) history.set(k, []);
    const actual = typeof p.score.actualAsGuided === "number" ? p.score.actualAsGuided : p.actual;
    // A single-figure guide has no range to be within: the result is above,
    // below, or on the figure (at the precision the company guided).
    let position = p.score.position;
    if (!position && p.guide && typeof p.guide.value === "number") {
      position = actual > p.guide.value ? "above" : actual < p.guide.value ? "below" : "at";
    }
    history.get(k).push({ period: p.guide_period, guide: p.guide, actual, position,
      flagged: Boolean(p.score.flags && p.score.flags.length), unit: p.unit });
  }

  const rows = [];
  const seen = new Set();
  for (const g of guides) {
    const label = displayLabel([String(g.metric_as_written || g.metric || "")]);
    const k = keyOf(g.metric_as_written, g.unit, g.basis, g.quote);
    if (seen.has(k + g.period)) continue;
    seen.add(k + g.period);
    const past = (history.get(k + "|" + (isQuarter(g.period) ? "q" : "y")) || [])
      .filter((h) => h.period < g.period && !h.flagged)
      .sort((a, b) => String(b.period).localeCompare(String(a.period)))
      .slice(0, HISTORY_SHOWN);
    const gaps = past.map((h) => gapOf(h.actual, midOf(h.guide), g.unit)).filter((x) => x !== null);
    const count = { above: 0, within: 0, below: 0, at: 0 };
    for (const h of past) if (count[h.position] !== undefined) count[h.position]++;
    const mid = midOf(g);
    const med = median(gaps);
    const arithmetic = gaps.length >= MIN_FOR_ARITHMETIC && typeof mid === "number"
      && !(g.bound === "floor" || g.bound === "ceiling")
      ? {
          n: gaps.length,
          median: med,
          low: Math.min(...gaps),
          high: Math.max(...gaps),
          atMedian: computedFigure(applied(mid, med, g.unit), g.unit, mid),
          atLow: computedFigure(applied(mid, Math.min(...gaps), g.unit), g.unit, mid),
          atHigh: computedFigure(applied(mid, Math.max(...gaps), g.unit), g.unit, mid),
          midText: computedFigure(mid, g.unit, mid),
        }
      : null;
    rows.push({
      measure: label,
      period: periodLabel(g.period),
      quarter: isQuarter(g.period),
      guide: formatFigure(g, g.unit) + (g.from_words ? "*" : ""),
      words: g.from_words || null,
      unit: g.unit,
      rank: rank(label),
      past,
      count,
      gaps,
      arithmetic,
    });
  }
  rows.sort((a, b) => (b.quarter - a.quarter) || (a.rank - b.rank));
  return { next, rows: rows.slice(0, 8) };
}

function recordLine(r) {
  const n = r.past.length;
  if (!n) return "No scored history for this measure yet.";
  const parts = [];
  if (r.count.above) parts.push("above in " + r.count.above);
  if (r.count.within) parts.push("within in " + r.count.within);
  if (r.count.at) parts.push("on the figure in " + r.count.at);
  if (r.count.below) parts.push("below in " + r.count.below);
  const unit = r.quarter ? (n === 1 ? "quarter" : "quarters") : (n === 1 ? "year" : "years");
  let line = (n === 1 ? "Of the one " + unit + " scored: " : "Of the last " + n + " " + unit + " scored: ") + parts.join(", ") + ".";
  if (r.gaps.length) {
    line += " Median " + gapWords(median(r.gaps), r.unit) + " against the guide's midpoint"
      + (r.gaps.length > 1 ? " (from " + gapWords(Math.min(...r.gaps), r.unit) + " to " + gapWords(Math.max(...r.gaps), r.unit) + ")" : "") + ".";
  }
  return line;
}

function arithmeticLine(r) {
  const a = r.arithmetic;
  if (!a) return "";
  return "Applied to this guide (midpoint " + a.midText + "): " + a.atMedian + " at the median; "
    + a.atLow + " to " + a.atHigh + " across the last " + a.n + ".";
}

/* HTML-escape. */
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const INK = "#1a2b23", GREEN = "#1f4435", SOFT = "#5f6b76", LINE = "#e3e7ea", PAGE = "#eef1f3";
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * The email itself: { subject, text, html }, or null.
 */
export function renderPreview(record, opts = {}) {
  const pv = previewOf(record);
  if (!pv || !pv.rows.length) return null;
  const company = displayName(record.company || record.ticker);
  const short = company.replace(/,?\s+(Inc|Corp|Corporation|Co|Company|Ltd|plc|Holdings?|Group)\.?$/i, "").replace(/,\s*$/, "");
  /* The report date: the stored earnings-calendar date when there is one
     (opts.reportDate, from scripts/dates.mjs), said as such; otherwise last
     year's date, said to be an estimate. */
  const dated = Boolean(opts.reportDate);
  const when = longDate(dated ? opts.reportDate : pv.next.expected);
  const slot = opts.reportTime === "pre-market" ? ", before the market opens" : opts.reportTime === "post-market" ? ", after the market closes" : "";
  const period = pv.next.interim ? "its next quarter" : periodLabel(pv.next.period);
  const subject = dated
    ? short + " reports " + period + (opts.tomorrow ? " tomorrow" : " on " + when.replace(/,? \d{4}$/, "")) + ": the guide and its record"
    : short + " reports " + period + " around " + when.replace(/,? \d{4}$/, "") + ": the guide and its record";
  const dateLine = dated
    ? "Date from the earnings calendars; the company can still move it."
    : "Estimated: it reported the same quarter last year on " + longDate(pv.next.lastYear) + ".";
  const lead = dated
    ? short + " reports " + period + " on " + when + slot + ". " + dateLine
    : short + " is expected to report " + period + " on or around " + when + ". " + dateLine;
  const anyWords = pv.rows.some((r) => r.words);
  const anyArith = pv.rows.some((r) => r.arithmetic);

  const t = [];
  t.push(company + " (" + record.ticker + ") · preview");
  t.push("");
  t.push(lead);
  t.push("");
  t.push("THE GUIDE IN FORCE");
  for (const r of pv.rows) t.push("- " + r.measure + ", " + r.period + ": " + r.guide);
  t.push("");
  t.push("HOW RESULTS HAVE LANDED AGAINST THE GUIDE");
  for (const r of pv.rows) {
    t.push(r.measure + " (" + (r.quarter ? "quarters" : "full years") + ")");
    t.push("   " + recordLine(r));
    if (r.arithmetic) t.push("   " + arithmeticLine(r));
  }
  t.push("");
  if (anyArith) t.push("\"Applied to this guide\" is arithmetic on the company's own record: today's guide moved by the gaps it has had before. It is not a forecast.");
  if (anyWords) t.push("* Given in words, read by a fixed rule (low single digits 1-3%, mid 4-6%, high 7-9%; figures written out as words taken as written).");
  t.push("Results marked as possibly misread are left out of the record above." + (dated ? "" : " Dates are estimates until the company announces them."));
  t.push("Minutes after the release, Release Watch says whether the results came in above, within or below this guide.");
  t.push("");
  t.push("Thanks,");
  t.push("Zahoor · Guidance Scorecard · hello@zahoorbhat.com");
  if (opts.unsubscribeUrl) { t.push(""); t.push("Unsubscribe: " + opts.unsubscribeUrl); }

  const h = [];
  const label = (x) => '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:' + SOFT + ';font-weight:700;">' + esc(x) + "</div>";
  h.push('<div style="margin:0;padding:20px 0;background:' + PAGE + ';">');
  h.push('<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:' + SANS + ";color:" + INK + ';font-size:15px;line-height:1.45;">');
  h.push('<div style="background:' + GREEN + ';color:#ffffff;padding:22px 22px 20px;">');
  h.push('<div style="font-size:13px;color:#cfe0d6;">' + esc(company + " (" + record.ticker + ") · preview") + "</div>");
  h.push('<div style="font-size:24px;font-weight:700;line-height:1.2;margin-top:10px;">' + esc("Reports " + period + (dated ? (opts.tomorrow ? " tomorrow, " : " on ") + when + slot : " around " + when)) + "</div>");
  h.push('<div style="font-size:14px;margin-top:8px;color:#e6efe9;">' + esc(dated ? dateLine : "Estimated from last year: it reported the same quarter on " + longDate(pv.next.lastYear) + ".") + "</div>");
  h.push("</div>");

  h.push('<div style="padding:18px 22px 6px;">' + label("The guide in force"));
  h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:8px;font-size:14px;">');
  for (const r of pv.rows) {
    h.push('<tr><td style="padding:8px 8px 8px 0;border-bottom:1px solid ' + LINE + ';">' + esc(r.measure)
      + '<div style="font-size:12px;color:' + SOFT + ';">' + esc(r.period) + "</div></td>"
      + '<td align="right" style="padding:8px 0;border-bottom:1px solid ' + LINE + ';white-space:nowrap;"><b>' + esc(r.guide) + "</b></td></tr>");
  }
  h.push("</table></div>");

  h.push('<div style="padding:16px 22px 6px;">' + label("How results have landed against the guide"));
  for (const r of pv.rows) {
    h.push('<div style="margin-top:14px;font-size:14px;"><b>' + esc(r.measure) + '</b> <span style="color:' + SOFT + ';font-size:12px;">' + esc(r.quarter ? "quarters" : "full years") + "</span>");
    h.push('<div style="color:' + INK + ';font-size:13px;margin-top:3px;">' + esc(recordLine(r)) + "</div>");
    if (r.arithmetic) h.push('<div style="color:' + GREEN + ';font-size:13px;margin-top:3px;">' + esc(arithmeticLine(r)) + "</div>");
    if (r.past.length) {
      h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px;font-size:12px;color:' + SOFT + ';font-variant-numeric:tabular-nums;">');
      for (const p of r.past.slice(0, 4)) {
        const gap = gapOf(p.actual, midOf(p.guide), r.unit);
        h.push('<tr><td style="padding:3px 8px 3px 0;border-bottom:1px solid ' + LINE + ';">' + esc(periodLabel(p.period)) + "</td>"
          + '<td style="padding:3px 8px;border-bottom:1px solid ' + LINE + ';">guided ' + esc(formatFigure(p.guide, r.unit)) + "</td>"
          + '<td align="right" style="padding:3px 0;border-bottom:1px solid ' + LINE + ';">reported ' + esc(formatValue(p.actual, r.unit)) + (gap === null ? "" : " (" + esc(gapWords(gap, r.unit)) + ")") + "</td></tr>");
      }
      h.push("</table>");
    }
    h.push("</div>");
  }
  h.push("</div>");

  const notes = [];
  if (anyArith) notes.push("“Applied to this guide” is arithmetic on the company’s own record: today’s guide moved by the gaps it has had before. It is not a forecast.");
  if (anyWords) notes.push("* Given in words, read by a fixed rule (low single digits 1-3%, mid 4-6%, high 7-9%; figures written out as words taken as written).");
  notes.push("Results marked as possibly misread are left out." + (dated ? "" : " Dates are estimates until the company announces them."));
  notes.push("Minutes after the release, Release Watch says whether the results came in above, within or below this guide.");
  h.push('<div style="padding:12px 22px 0;font-size:12px;color:' + SOFT + ';">' + notes.map(esc).join("<br>") + "</div>");
  h.push('<div style="padding:16px 22px 20px;font-size:12px;line-height:1.5;color:' + SOFT + ";border-top:1px solid " + LINE + ';margin-top:14px;">'
    + "Thanks,<br>Zahoor · Guidance Scorecard · hello@zahoorbhat.com<br><br>"
    + "Every figure is read from the company's own filings on EDGAR."
    + (opts.unsubscribeUrl ? '<br><br><a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + SOFT + ';">Unsubscribe</a>' : "")
    + (opts.postalAddress ? " · " + esc(opts.postalAddress) : "")
    + "</div></div></div>");

  return { subject, text: t.join("\n"), html: h.join("\n"), next: pv.next };
}


/**
 * The day before a company with no numeric guidance reports: said once, in
 * a short email, so the reader knows why there is no preview (the product
 * structure, 17 Oct 2026). Release Watch and Filing Watch follow as usual.
 */
export function renderNoGuidePreview(record, opts = {}) {
  const company = displayName(record.company || record.ticker);
  const short = company.replace(/,?\s+(Inc|Corp|Corporation|Co|Company|Ltd|plc|Holdings?|Group)\.?$/i, "").replace(/,\s*$/, "");
  const when = opts.reportDate ? longDate(opts.reportDate) : "";
  const slot = opts.reportTime === "pre-market" ? ", before the market opens" : opts.reportTime === "post-market" ? ", after the market closes" : "";
  const n = (record.releasesRead || []).length;
  const subject = short + " reports " + (opts.tomorrow ? "tomorrow" : "on " + when.replace(/,? \d{4}$/, "")) + ": no guidance in figures to set it against";
  const body = [
    short + " reports " + (when ? "on " + when + slot : "next") + ".",
    "It gives no numeric guidance in its filings - we read its last " + n + " earnings releases - so there is no guide to set the results against.",
    "Minutes after the release, Release Watch sends what changed. Filing Watch follows when the 10-Q reaches the SEC.",
  ];
  const t = [company + " (" + record.ticker + ") · preview", "", ...body, "", "Thanks,", "Zahoor · Guidance Scorecard · hello@zahoorbhat.com"];
  if (opts.unsubscribeUrl) { t.push(""); t.push("Unsubscribe: " + opts.unsubscribeUrl); }
  const h = '<div style="margin:0;padding:20px 0;background:' + PAGE + ';"><div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:' + SANS + ";color:" + INK + ';font-size:15px;line-height:1.5;padding:22px;">'
    + '<div style="font-size:13px;color:' + SOFT + ';">' + esc(company + " (" + record.ticker + ") · preview") + "</div>"
    + body.map((x) => "<p>" + esc(x) + "</p>").join("")
    + '<div style="font-size:12px;color:' + SOFT + ';border-top:1px solid ' + LINE + ';padding-top:12px;margin-top:14px;">Thanks,<br>Zahoor · Guidance Scorecard · hello@zahoorbhat.com'
    + (opts.unsubscribeUrl ? '<br><br><a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + SOFT + ';">Unsubscribe</a>' : "")
    + (opts.postalAddress ? " · " + esc(opts.postalAddress) : "") + "</div></div></div>";
  return { subject, text: t.join("\n"), html: h };
}
