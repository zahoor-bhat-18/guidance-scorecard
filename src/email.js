/**
 * The email.
 *
 * Everything in this project exists to produce one of these, and it goes out
 * at the only moment it is worth anything: minutes after a company reports,
 * while the reader is still deciding what to do.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not predict. "They have beaten eight quarters running, so expect a
 * ninth" is the line that writes itself and the line this product never
 * writes. The reader is a portfolio manager; drawing that inference is his
 * job, and a tool that makes probabilistic claims gets judged on them - one
 * bad call and the whole thing is discredited.
 *
 * It does not editorialise about direction. "Above" and "below" are facts. A
 * higher tax rate needs no commentary from an email.
 *
 * It does not show a flagged pair. Those are held back upstream, and the count
 * of what was held back is printed, so the omission is visible.
 *
 * WHAT IT IS FOR
 *
 * The reader already has the release. He can see what was reported. What he
 * cannot see, and what no screen on his desk shows him, is whether this
 * management habitually lands where it said it would. That is the whole
 * product, and it fits in a short email.
 */

import { metricKey, displayLabel } from "./metrics.js";
import { formatFigure, formatValue, periodLabel } from "./format.js";
import { revisionSentence } from "./summary.js";

const CREAM = "#faf7f0";
const INK = "#1a2b23";
const GREEN = "#1f4435";
const MUTED = "#5b6b62";
const RULE = "#dcd6c8";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The record, by metric.
 *
 * Thirty-seven scored pairs is a spreadsheet, not an email. What a reader can
 * hold is: which measures this company guides, and how it has landed on each.
 * The individual outcomes are there underneath, most recent first, and capped.
 */
function byMetric(pairs, limit) {
  const groups = new Map();

  for (const p of pairs) {
    // Grouped on the shared metric identity, NOT on the label as the company
    // wrote it. Broadcom names the quarter inside its labels, so grouping by
    // label split one measure into four and dropped three of them for having
    // too few periods. The record said seven pairs; the email showed three.
    const key = metricKey(p.metric);
    if (!groups.has(key)) {
      groups.set(key, { labels: [], unit: p.unit, rows: [], above: 0, within: 0, below: 0, noVerdict: 0 });
    }
    const g = groups.get(key);
    g.labels.push(p.metric);
    g.rows.push(p);
    if (p.position === "above") g.above += 1;
    else if (p.position === "within") g.within += 1;
    else if (p.position === "below") g.below += 1;
    else g.noVerdict += 1;
  }

  const out = Array.from(groups.values());
  for (const g of out) {
    g.metric = displayLabel(g.labels);
    g.rows.sort((a, b) => (a.period < b.period ? 1 : -1));
    g.total = g.rows.length;
  }

  // Three matched pairs to earn a block. The rule the record already enforces,
  // applied here too - the email was showing Delta's gross leverage on the
  // strength of one period, which is not a record, it is an anecdote.
  const earned = out.filter((g) => g.total >= 3);
  earned.sort((a, b) => b.total - a.total);

  // Eight periods, not the whole history.
  //
  // The record reaches back to 2023 for some companies, and a run that long
  // takes in a different macro environment and sometimes a different business.
  // Two years is long enough to be a pattern and recent enough to be about the
  // management team running the company now. The full history stays in the
  // record for the page.
  for (const g of earned) {
    g.allPeriods = g.rows.length;
    g.rows = g.rows.slice(0, 8);
    g.above = g.rows.filter((p) => p.position === "above").length;
    g.within = g.rows.filter((p) => p.position === "within").length;
    g.below = g.rows.filter((p) => p.position === "below").length;
    g.noVerdict = g.rows.filter((p) => !p.position).length;
    g.total = g.rows.length;
  }

  return earned.slice(0, limit || 4);
}

/* "9 above, 2 within, 1 below" - counted, not characterised. */
function countLine(g) {
  const parts = [];
  if (g.above) parts.push(g.above + " above");
  if (g.within) parts.push(g.within + " within");
  if (g.below) parts.push(g.below + " below");
  if (g.noVerdict) parts.push(g.noVerdict + " against a single figure");
  return g.total + (g.total === 1 ? " period" : " periods") + ": " + parts.join(", ");
}

/**
 * One period's outcome.
 *
 * The figures carry their unit. They did not before, and the block printed
 * "guided 0.72 to 0.74" for dollars a share, "guided 4 to 5" for a growth
 * rate and "guided 68, reported 69" for a margin - three different things
 * written identically, in an email whose only claim is that it reads figures
 * off the filing accurately.
 */
function outcomeLine(p) {
  const guide = formatFigure(p.guide, p.unit);
  const actual = formatValue(p.actual, p.unit) || String(p.actual);
  const verdict = p.position === "above" ? "above"
    : p.position === "below" ? "below"
    : p.position === "within" ? "within"
    : "no range guided";
  return periodLabel(p.period) + " - guided " + guide + ", reported " + actual
    + " (" + verdict + ")";
}

/**
 * The revision line, built now rather than read off the record.
 *
 * The stored summary was written when the record was built, which meant a
 * wording fix changed nothing until the backfill was re-run - and re-running
 * it rewrites history a subscriber has already read. The parts of the sentence
 * are all in the record, so it is assembled here from those.
 *
 * The stored summary is the fallback, for a record built before summary.js
 * existed and missing something the sentence needs. Stale beats broken.
 */
function revisionLine(r) {
  return revisionSentence(r) || r.summary || "";
}

/**
 * What moved in THIS release, and nothing else.
 *
 * The first version took the first six revisions in the record and called them
 * "what moved in this release". The record holds fourteen releases of history,
 * newest first, so the section led with guides issued months earlier. A
 * section headed with today's date and filled with old news is the fastest way
 * to lose a reader who checks.
 *
 * A revision to a period that has since been reported is history too - it is
 * already answered in the record above.
 */
function movedInThisRelease(revisions, latest, limit) {
  const wanted = new Set(["raised", "cut", "unchanged", "new", "narrowed", "widened", "scope change"]);
  const accession = latest && latest.accession;

  const rows = (revisions || []).filter((r) => wanted.has(r.direction));
  if (!accession) return rows.slice(0, limit || 6);

  const fromLatest = rows.filter((r) => r.release === accession);
  return fromLatest.slice(0, limit || 6);
}

export function renderEmail(view, options) {
  const opts = options || {};
  const company = view.company || view.ticker;
  const metrics = byMetric(view.pairs || [], 4);
  const moved = movedInThisRelease(view.revisions, view.latestRelease, 6);

  const subject = company + " reported - how their guidance has held up";

  /* ---------------- plain text ---------------- */

  const t = [];
  t.push(company + " (" + view.ticker + ")");
  t.push("");
  t.push("THE RECORD");
  t.push(view.headline || "");
  t.push("");

  for (const g of metrics) {
    t.push(g.metric + " - " + countLine(g));
    // Every period the block earned, up to the eight it was capped at in
    // byMetric. An earlier version printed four while the heading said seven,
    // which reads as a page that cannot count.
    for (const p of g.rows) t.push("   " + outcomeLine(p));
    t.push("");
  }

  if (moved.length) {
    t.push("WHAT MOVED IN THIS RELEASE");
    for (const r of moved) t.push("- " + revisionLine(r));
    t.push("");
  }

  if (view.withheldForReview) {
    t.push(view.withheldForReview + " further "
      + (view.withheldForReview === 1 ? "comparison is" : "comparisons are")
      + " held back: the gap was too large to take at face value without checking"
      + " for a change in scope or a restatement.");
    t.push("");
  }

  t.push("Questions, or something that looks wrong: reply to this, or write to");
  t.push("hello@zahoorbhat.com.");
  t.push("");
  t.push("Every figure is read from the company's own filings on EDGAR.");
  t.push("Guidance comes from the earnings release; results from the release that");
  t.push("reported the period. A guide is only scored against the same period, on the");
  t.push("same basis. Nothing here is a forecast.");
  if (opts.unsubscribeUrl) {
    t.push("");
    t.push("Unsubscribe: " + opts.unsubscribeUrl);
  }

  /* ---------------- html ---------------- */

  const h = [];
  h.push('<div style="margin:0;padding:24px 0;background:' + CREAM + ';">');
  h.push('<div style="max-width:560px;margin:0 auto;padding:0 20px;font-family:Georgia,\'Times New Roman\',serif;color:' + INK + ';font-size:16px;line-height:1.5;">');

  h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">Guidance record</div>');
  h.push('<h1 style="margin:6px 0 2px;font-size:24px;font-weight:normal;color:' + GREEN + ';">' + esc(company) + '</h1>');
  h.push('<div style="font-size:14px;color:' + MUTED + ';">' + esc(view.ticker) + '</div>');

  h.push('<p style="margin:20px 0 0;font-size:17px;">' + esc(view.headline || "") + '</p>');

  for (const g of metrics) {
    h.push('<div style="margin-top:22px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:16px;color:' + GREEN + ';">' + esc(g.metric) + '</div>');
    h.push('<div style="font-size:14px;color:' + MUTED + ';margin-top:2px;">' + esc(countLine(g)) + '</div>');
    h.push('<div style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.7;">');
    for (const p of g.rows) {
      h.push('<div>' + esc(outcomeLine(p)) + '</div>');
    }
    h.push('</div></div>');
  }

  if (moved.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">What moved in this release</div>');
    for (const r of moved) {
      h.push('<p style="margin:10px 0 0;font-size:15px;">' + esc(revisionLine(r)) + '</p>');
    }
    h.push('</div>');
  }

  if (view.withheldForReview) {
    h.push('<p style="margin-top:22px;font-size:14px;color:' + MUTED + ';">'
      + view.withheldForReview + ' further '
      + (view.withheldForReview === 1 ? 'comparison is' : 'comparisons are')
      + ' held back: the gap was too large to take at face value without checking for a'
      + ' change in scope or a restatement.</p>');
  }

  h.push('<p style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';font-size:13px;color:' + MUTED + ';line-height:1.6;">'
    + 'Questions, or something that looks wrong: reply to this, or write to '
    + '<a href="mailto:hello@zahoorbhat.com" style="color:' + MUTED + ';">hello@zahoorbhat.com</a>. '
    + 'Every figure is read from the company\'s own filings on EDGAR. Guidance comes from the'
    + ' earnings release; results from the release that reported the period. A guide is only'
    + ' scored against the same period, on the same basis. Nothing here is a forecast.</p>');

  if (opts.unsubscribeUrl) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + MUTED + ';">'
      + '<a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + MUTED + ';">Unsubscribe</a>'
      + (opts.postalAddress ? ' &middot; ' + esc(opts.postalAddress) : '') + '</p>');
  }

  h.push('</div></div>');

  return { subject, html: h.join("\n"), text: t.join("\n") };
}
