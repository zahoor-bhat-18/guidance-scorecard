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
 * IT PRINTS NO FIGURE THE COMPANY DID NOT PUBLISH. Every number here is read
 * off a filing. Where a figure would have to be computed to be comparable - a
 * pre-split guide restated at today's share count - the comparison is dropped
 * and said to be dropped, rather than the number being manufactured and
 * footnoted. A single derived figure on a page of quoted ones is the thing a
 * sceptical reader finds, and finding it discredits the rest.
 */

import { metricKey, displayLabel } from "./metrics.js";
import { formatFigure, formatValue, periodLabel, periodSortKey } from "./format.js";

const CREAM = "#faf7f0";
const INK = "#1a2b23";
const GREEN = "#1f4435";
const MUTED = "#5b6b62";
const RULE = "#dcd6c8";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

/* Ten rows, not eight.
 *
 * Eight was two years of quarters, which was the right number when every row
 * was a scored period. Rows that say "not guided" and "not reported" now
 * compete for the same slots, and Walmart's Q2 2026 - the quarter management
 * explicitly declined to guide, which is one of the more interesting rows in
 * the email - was being pushed off the end by a scored period below it.
 *
 * The gaps are not padding. Losing one to fit one more result is the wrong
 * trade. */
const ROWS_PER_METRIC = 10;

/* Six measures, not four. Walmart guides sales, operating income, EPS, tax
 * rate, interest and capex; four blocks could never show them all, and the
 * ones that fell off the end were the ones a reader could not find elsewhere. */
const METRICS_SHOWN = 6;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/* Floating point subtraction produces 1.2000000000000002, and a table of
   guidance is not the place for it. */
function tidy(n) {
  return Number(n.toFixed(4));
}

/**
 * A gap, in the unit it was measured in.
 *
 * PERCENTAGE GUIDES GET POINTS, NOT PERCENT. Walmart guided sales growth of
 * 3.5% to 4.5% and grew 5.7%. The gap is 1.2 percentage points; calling it
 * 1.2% says the growth rate itself was 1.2% higher, which is a different and
 * wrong number. Anyone who reads these for a living would notice, and noticing
 * that would be the last thing they read.
 *
 * `signed` is off where the direction is already in the words. "above by
 * +1.2pp" said it twice.
 */
function formatDelta(d, unit, signed) {
  const sign = signed ? (d > 0 ? "+" : d < 0 ? "-" : "") : "";
  const size = Math.abs(tidy(d));
  switch (unit) {
    case "percent": return sign + size + "pp";
    case "USD billions": return sign + "$" + size + "bn";
    case "USD millions": return sign + "$" + size + "m";
    case "USD per share": return sign + "$" + size;
    default: return sign + size;
  }
}

/**
 * How far outside the range, and nothing more.
 *
 * ONE DISTANCE, MEASURED FROM THE END IT PASSED. Above the range, the gap
 * beyond the high end; below it, the gap below the low end. Within the range,
 * no number at all.
 *
 * A delta column implies one reference point, a reader assumes the midpoint,
 * and the whole product rests on never using midpoints: a company that guides
 * $22.3bn to $22.5bn and delivers $22.4bn has landed where it said it would,
 * and "delta -0.0bn" invents a target it never set.
 *
 * A point guide gets a signed distance and no verdict. "Above" would be
 * meaningless against a single number the company never framed as a floor or
 * a ceiling.
 */
function outcomeCell(p) {
  const actual = num(p.actual);
  const low = num(p.guide && p.guide.low);
  const high = num(p.guide && p.guide.high);
  const value = num(p.guide && p.guide.value);

  if (actual === null) return "";
  if (p.position === "within") return "within";

  if (p.position === "above" && high !== null) {
    return "above by " + formatDelta(actual - high, p.unit, false);
  }
  if (p.position === "below" && low !== null) {
    return "below by " + formatDelta(actual - low, p.unit, false);
  }
  if (value !== null) {
    return formatDelta(actual - value, p.unit, true) + " vs single figure";
  }
  return p.position || "";
}

/* One figure standing for a guide, for comparing two guides in scale. */
function levelOf(g) {
  if (!g) return null;
  return num(g.low) !== null ? num(g.low) : num(g.value) !== null ? num(g.value) : num(g.high);
}

/**
 * Did the units of the thing being guided change under the guide?
 *
 * Walmart split its shares three for one in February 2024. Its fiscal 2025 EPS
 * guide therefore reads $6.70 to $7.12 in the early releases and $2.42 to
 * $2.47 in the later ones. Drawn as a path, that is management cutting its own
 * earnings guidance by two thirds, which is the single most damaging sentence
 * this product could put in front of a portfolio manager - and it never
 * happened.
 *
 * Only LEVEL measures. A growth rate guided at 2% and revised to 6% has
 * tripled and is an ordinary revision; percentages are exempt for the same
 * reason they are exempt from the scope-change test in revisions.js.
 *
 * Halving or doubling is the threshold. No management team revises a level
 * guide that far between releases; splits, spin-offs and restatements do it
 * routinely. This is deliberately blunter than looksLikeScopeChange - it is
 * deciding whether to draw an arrow, not what to call a revision, and the cost
 * of suppressing a real revision is one missing arrow.
 *
 * EARNINGS ARE NOT EXEMPT HERE, unlike in revisions.js. That exemption exists
 * because United really did cut EPS 42% on fuel - a real and brutal revision
 * within one guide. A split is a different animal and lands well outside it.
 */
function scaleChanged(first, last, unit) {
  if (unit === "percent" || !unit || unit === "other") return false;

  const a = levelOf(first);
  const b = levelOf(last);
  if (a === null || b === null || a === 0) return false;

  const ratio = b / a;
  return ratio < 0.5 || ratio > 2;
}

/**
 * What was guided - and where the guide STARTED, if it moved.
 *
 * "3% to 4% → 4.8% to 5.1%" rather than "4.8% to 5.1%".
 *
 * Walmart opened fiscal 2026 guiding net sales growth of 3% to 4% and closed
 * it guiding 4.8% to 5.1%, then reported 5.1%. Against the final range that is
 * "within", and a reader would take it as a year that went to plan. The range
 * moved to meet the result. Both companies that land inside a final full-year
 * guide - the one that held it and the one that raised twice to reach it -
 * print the same word, and this is the difference between them.
 *
 * FIRST AND LAST ONLY, not every step. A guide revised four times would be
 * four arrows in a table cell on a phone.
 *
 * The verdict still measures against the final guide. That is what management
 * was standing behind when the period closed.
 *
 * Returns the note flag as well, so the row can be marked and the reason
 * printed once under the table rather than in every cell.
 */
function guideCell(p) {
  const now = formatFigure(p.guide, p.unit);
  const path = p.guidePath;
  if (!Array.isArray(path) || path.length < 2) return { text: now, noted: false };

  const first = path[0];
  const firstText = formatFigure(first, p.unit);
  if (firstText === now) return { text: now, noted: false };

  // The guide did move, but the measure moved under it. Show where it ended
  // and say why there is no path, rather than drawing a cut that never
  // happened or restating a figure the company never printed.
  if (scaleChanged(first, p.guide, p.unit)) return { text: now, noted: true };

  return { text: firstText + " → " + now, noted: false };
}

/**
 * The record, by metric.
 *
 * THREE KINDS OF ROW, because there are three different things that can be
 * true of a period and they were being told as one:
 *
 *   answered      - guided, and the release reported a comparable figure
 *   not reported  - guided, the period closed, no comparable figure exists
 *   not guided    - the company said nothing about this measure
 */
function byMetric(pairs, unanswered, limit) {
  const groups = new Map();
  const companyPeriods = new Map();

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

    if (p.period && !companyPeriods.has(p.period)) {
      companyPeriods.set(p.period, periodSortKey(p.period));
    }
  }

  const unansweredByKey = new Map();
  for (const u of unanswered || []) {
    if (!u.metric || !u.period) continue;
    unansweredByKey.set(metricKey(u.metric) + "|" + u.period, u);
  }

  const out = Array.from(groups.values());
  for (const g of out) {
    g.metric = displayLabel(g.labels);
    // Newest first, in TIME order. This compared the stored strings, which is
    // alphabetical: "2026FY" sorted before "2026Q1" because F precedes Q, and
    // Walmart's full year appeared three rows below the quarters it followed.
    g.rows.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
    g.total = g.rows.length;
  }

  // Three matched pairs to earn a block, counted on answered pairs only.
  // Neither a blank nor a "not reported" is evidence of a record.
  const earned = out.filter((g) => g.total >= 3);
  earned.sort((a, b) => b.total - a.total);

  // Guided, but not enough closed periods to show a record yet. Named rather
  // than dropped: a reader who knows the company guides capital expenditures
  // should not have to wonder whether this email missed it.
  const belowBar = out
    .filter((g) => g.total < 3)
    .sort((a, b) => b.total - a.total)
    .map((g) => ({ metric: g.metric, total: g.total }));

  for (const g of earned) {
    g.allPeriods = g.rows.length;

    const key = metricKey(g.labels[0]);
    const have = new Set(g.rows.map((p) => p.period));
    const keys = g.rows.map((p) => periodSortKey(p.period));
    const newest = Math.max(...keys);
    const oldest = Math.min(...keys);

    /**
     * Periods inside this metric's own span that it has no answer for, each
     * labelled with what is actually true of it.
     *
     * Only inside the span. A metric first guided in 2025 gets no rows for
     * 2023 - the company was not silent then, this measure simply was not
     * being tracked, and a row saying otherwise would be invented.
     */
    const extra = [];
    for (const [period, sortKey] of companyPeriods.entries()) {
      if (have.has(period)) continue;
      if (sortKey > newest || sortKey < oldest) continue;

      const u = unansweredByKey.get(key + "|" + period);
      if (u) {
        extra.push({ period, unit: u.unit, guide: u.guide, guidePath: u.guidePath || null, unanswered: true });
      } else {
        // IT SAYS "NOT GUIDED", NEVER "NOT DISCLOSED". What the record knows is
        // that no guide is stored. Whether the company withheld it or the
        // extraction missed it is not knowable from here, and the second is not
        // a claim to make about management on the strength of a gap.
        extra.push({ period, notGuided: true });
      }
    }

    g.rows = [...g.rows, ...extra]
      .sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period))
      .slice(0, ROWS_PER_METRIC);

    const real = g.rows.filter((p) => !p.notGuided && !p.unanswered);
    g.above = real.filter((p) => p.position === "above").length;
    g.within = real.filter((p) => p.position === "within").length;
    g.below = real.filter((p) => p.position === "below").length;
    g.noVerdict = real.filter((p) => !p.position).length;
    g.total = real.length;
    g.notGuided = g.rows.filter((p) => p.notGuided).length;
    g.notReported = g.rows.filter((p) => p.unanswered).length;
    g.hasNote = g.rows.some((p) => !p.notGuided && guideCell(p).noted);
  }

  return { metrics: earned.slice(0, limit || METRICS_SHOWN), belowBar };
}

/* "9 above, 2 within, 1 below" - counted, not characterised. */
function countLine(g) {
  const parts = [];
  if (g.above) parts.push(g.above + " above");
  if (g.within) parts.push(g.within + " within");
  if (g.below) parts.push(g.below + " below");
  if (g.noVerdict) parts.push(g.noVerdict + " against a single figure");

  let line = g.total + (g.total === 1 ? " period" : " periods") + ": " + parts.join(", ");

  const tail = [];
  if (g.notReported) tail.push(g.notReported + " not reported");
  if (g.notGuided) tail.push(g.notGuided + " not guided");
  if (tail.length) line += "; " + tail.join(", ");

  return line;
}

const SPLIT_NOTE = "* An earlier guide for this period was stated before a share split or"
  + " another change to what is being counted, so it is not comparable and no path is"
  + " shown. Nothing here is restated.";

/**
 * One row of the table.
 *
 * "n/a" rather than a blank in the outcome column for an unanswered guide,
 * because a blank reads as a value that failed to render. n/a says a verdict
 * was not available, which is the fact.
 */
function rowCells(p) {
  if (p.notGuided) {
    return [periodLabel(p.period), "not guided", "", ""];
  }

  const guide = guideCell(p);
  const period = periodLabel(p.period) + (guide.noted ? "*" : "");

  if (p.unanswered) {
    return [period, guide.text, "not reported", "n/a"];
  }
  return [
    period,
    guide.text,
    formatValue(p.actual, p.unit) || String(p.actual),
    outcomeCell(p),
  ];
}

const HEADINGS = ["Period", "Guided", "Reported", ""];

/**
 * The same table in plain text, columns padded to line up.
 *
 * Plain text is what a client that strips styling shows, what a reader who has
 * turned HTML off sees, and the version that has to survive being forwarded.
 */
function textTable(rows) {
  const all = [HEADINGS, ...rows];
  const widths = HEADINGS.map((_, i) =>
    Math.max(...all.map((r) => String(r[i] || "").length)));

  return all.map((r, ri) => {
    const line = r
      .map((cell, i) => String(cell || "").padEnd(widths[i]))
      .join("  ")
      .replace(/\s+$/, "");
    return ri === 0
      ? line + "\n   " + "-".repeat(Math.min(widths.reduce((a, b) => a + b, 0) + 6, 68))
      : line;
  });
}

/**
 * What moved in this release. ALL OF IT.
 *
 * There were two sections under the tables and they said the same thing twice.
 * Six of Walmart's nine lines were duplicates, and the three that were not -
 * interest, effective tax rate, capital expenditures - were the ones a reader
 * could not find anywhere else. They were missing because the section stopped
 * at six lines, not because it could not carry them.
 *
 * This is also where a measure with too few closed periods to earn a table
 * still gets said. Interest has no record yet and appears here every quarter
 * it is guided.
 *
 * WHAT THIS STILL CANNOT SHOW: a guide with no number. revisionsBetween
 * compares figures and skips anything qualitative, so "we expect gross margin
 * to decline sequentially" reaches the record as guidance and appears nowhere.
 * That needs a change in revisions.js, not here.
 */
function movedInThisRelease(revisions, latest, limit) {
  const wanted = new Set(["raised", "cut", "unchanged", "new", "narrowed", "widened", "scope change"]);
  const accession = latest && latest.accession;
  const cap = limit || 20;

  const rows = (revisions || []).filter((r) => wanted.has(r.direction));
  const fromLatest = accession ? rows.filter((r) => r.release === accession) : rows;

  return { rows: fromLatest.slice(0, cap), more: Math.max(0, fromLatest.length - cap) };
}

function belowBarLine(belowBar) {
  if (!belowBar || !belowBar.length) return "";
  const named = belowBar
    .slice(0, 6)
    .map((m) => m.metric + " (" + m.total + ")")
    .join(", ");
  return "Also guided, too few closed periods to show a record yet: " + named + ".";
}

export function renderEmail(view, options) {
  const opts = options || {};
  const company = view.company || view.ticker;
  const { metrics, belowBar } = byMetric(view.pairs || [], view.unanswered || [], METRICS_SHOWN);
  const moved = movedInThisRelease(view.revisions, view.latestRelease, 20);
  const alsoLine = belowBarLine(belowBar);
  const anyNote = metrics.some((g) => g.hasNote);

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
    for (const line of textTable(g.rows.map(rowCells))) t.push("   " + line);
    t.push("");
  }

  if (anyNote) {
    t.push(SPLIT_NOTE);
    t.push("");
  }

  if (alsoLine) {
    t.push(alsoLine);
    t.push("");
  }

  if (moved.rows.length) {
    t.push("WHAT MOVED IN THIS RELEASE");
    for (const r of moved.rows) t.push("- " + r.summary);
    if (moved.more) {
      t.push("- and " + moved.more + " further "
        + (moved.more === 1 ? "guide" : "guides") + ", on the site.");
    }
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

    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + MONO
      + ';font-size:13px;">');

    h.push('<tr>');
    for (const head of HEADINGS) {
      h.push('<th align="left" style="padding:0 8px 5px 0;border-bottom:1px solid ' + RULE
        + ';font-weight:normal;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:'
        + MUTED + ';">' + esc(head) + '</th>');
    }
    h.push('</tr>');

    for (const p of g.rows) {
      const cells = rowCells(p);
      const quiet = p.notGuided || p.unanswered;
      h.push('<tr>');
      cells.forEach((cell, i) => {
        // A row with no outcome is muted throughout: it is context for the
        // rows around it, not a result. Still no colour anywhere - a tax rate
        // above guidance is bad for the company and irrelevant to a short
        // seller, and red would decide that for the reader.
        const colour = quiet ? MUTED : i === 0 ? MUTED : INK;
        h.push('<td align="left" style="padding:5px 8px 5px 0;border-bottom:1px solid '
          + RULE + ';color:' + colour + ';white-space:nowrap;">' + esc(cell) + '</td>');
      });
      h.push('</tr>');
    }

    h.push('</table>');
    h.push('</div>');
  }

  if (anyNote) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + MUTED + ';line-height:1.5;">'
      + esc(SPLIT_NOTE) + '</p>');
  }

  if (alsoLine) {
    h.push('<p style="margin-top:14px;font-size:14px;color:' + MUTED + ';">' + esc(alsoLine) + '</p>');
  }

  if (moved.rows.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">What moved in this release</div>');
    for (const r of moved.rows) {
      h.push('<p style="margin:10px 0 0;font-size:15px;">' + esc(r.summary) + '</p>');
    }
    if (moved.more) {
      h.push('<p style="margin:10px 0 0;font-size:14px;color:' + MUTED + ';">and '
        + moved.more + ' further ' + (moved.more === 1 ? 'guide' : 'guides')
        + ', on the site.</p>');
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
