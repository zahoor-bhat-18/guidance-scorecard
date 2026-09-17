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
import { formatFigure, formatValue, periodLabel, periodSortKey } from "./format.js";

const CREAM = "#faf7f0";
const INK = "#1a2b23";
const GREEN = "#1f4435";
const MUTED = "#5b6b62";
const RULE = "#dcd6c8";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

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
 */
function formatDelta(d, unit) {
  const sign = d > 0 ? "+" : d < 0 ? "-" : "";
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
 * The alternative was a single "delta" column, which is what a table of
 * guidance usually carries and which cannot be honest here. A delta implies
 * one reference point, a reader assumes the midpoint, and the whole product
 * rests on never using midpoints: a company that guides $22.3bn to $22.5bn and
 * delivers $22.4bn has landed where it said it would, and "delta -0.0bn"
 * invents a target it never set. For a row inside the range there is no
 * truthful single number, so this prints none.
 *
 * A point guide gets a signed distance and no verdict - already the rule, now
 * with the figure visible. "Above" would be meaningless against a single
 * number the company never framed as a floor or a ceiling.
 *
 * NOTE: computed here from the guide and the actual. If score.js already
 * carries these distances, this should use them rather than become a second
 * opinion on the same arithmetic.
 */
function outcomeCell(p) {
  const actual = num(p.actual);
  const low = num(p.guide && p.guide.low);
  const high = num(p.guide && p.guide.high);
  const value = num(p.guide && p.guide.value);

  if (actual === null) return "";

  if (p.position === "within") return "within";

  if (p.position === "above" && high !== null) {
    return "above by " + formatDelta(Math.abs(actual - high), p.unit);
  }
  if (p.position === "below" && low !== null) {
    return "below by " + formatDelta(Math.abs(actual - low), p.unit);
  }

  // No range was guided. The distance is a fact; the verdict is not available.
  if (value !== null) {
    return formatDelta(actual - value, p.unit) + " vs single figure";
  }

  return p.position || "";
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
    // Newest first, in TIME order. This compared the stored strings, which is
    // alphabetical: "2026FY" sorted before "2026Q1" because F precedes Q, and
    // Walmart's full year appeared three rows below the quarters it followed.
    g.rows.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
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
 * One row of the table: what was guided, what came in, how far apart.
 *
 * The figures carry their unit. They did not before, and the block printed
 * "guided 0.72 to 0.74" for dollars a share, "guided 4 to 5" for a growth
 * rate and "guided 68, reported 69" for a margin - three different things
 * written identically, in an email whose only claim is that it reads figures
 * off the filing accurately.
 */
function rowCells(p) {
  return [
    periodLabel(p.period),
    formatFigure(p.guide, p.unit),
    formatValue(p.actual, p.unit) || String(p.actual),
    outcomeCell(p),
  ];
}

const HEADINGS = ["Period", "Guided", "Reported", ""];

/**
 * The same table in plain text, columns padded to line up.
 *
 * Plain text is not a fallback nobody reads. It is what a client that strips
 * styling shows, and what a reader who has turned HTML off sees, and it is the
 * version that has to survive being forwarded.
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
    // A rule under the headings, as wide as the table actually is.
    return ri === 0
      ? line + "\n   " + "-".repeat(Math.min(widths.reduce((a, b) => a + b, 0) + 6, 68))
      : line;
  });
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
 *
 * The sentence itself is written in records.js, where the untrimmed revision
 * is still in hand. It was tried in this file first and could not work: the
 * view this renderer receives has already dropped the label, the unit and the
 * figures the sentence is made of.
 */
function movedInThisRelease(revisions, latest, limit) {
  const wanted = new Set(["raised", "cut", "unchanged", "new", "narrowed", "widened", "scope change"]);
  const accession = latest && latest.accession;

  const rows = (revisions || []).filter((r) => wanted.has(r.direction));
  if (!accession) return rows.slice(0, limit || 6);

  const fromLatest = rows.filter((r) => r.release === accession);
  return fromLatest.slice(0, limit || 6);
}

/**
 * Everything the company guided in this release.
 *
 * The tables above are the record: the measures with enough history to show a
 * pattern. This is the outlook - every measure the company put a number or a
 * sentence against this time, whether or not it has a record yet.
 *
 * It answers the question the tables cannot: what did they actually say today.
 * A reader who sees revenue and adjusted EBITDA scored, and knows the company
 * also guides free cash flow, has no way to tell from the tables alone whether
 * free cash flow was guided and left out, or never guided at all.
 *
 * QUALITATIVE GUIDES BELONG HERE AND NOWHERE ELSE.
 *
 * A guide with no number cannot be scored and cannot be revised - it is
 * skipped everywhere upstream for exactly that reason. But "we expect gross
 * margin to decline sequentially" is guidance, and a portfolio manager wants
 * it. It is printed as the company wrote it, in quotation marks, and nothing
 * is said about it. Summarising a qualitative guide would be interpreting one,
 * which is the line this product does not cross.
 *
 * Capped, with the remainder counted. A busy quarter at a company that guides
 * ten measures would otherwise put forty lines under an email whose value is
 * that it is short.
 */
function alsoGuided(currentGuidance, limit) {
  const seen = new Set();
  const rows = [];

  for (const g of currentGuidance || []) {
    if (!g) continue;

    const written = g.metric_as_written || g.metric;
    if (!written) continue;

    const label = displayLabel(written);
    const key = metricKey(written) + "|" + (g.period || "");
    if (seen.has(key)) continue;

    const hasNumber = num(g.low) !== null || num(g.high) !== null || num(g.value) !== null;
    const quote = String(g.quote || "").trim();

    // Nothing to print. A guide with neither a figure nor the sentence it came
    // from is a row in a JSON file, not a line in an email.
    if (!hasNumber && !quote) continue;

    seen.add(key);

    const when = g.period ? periodLabel(g.period) : null;
    const said = hasNumber
      ? formatFigure({ low: g.low, high: g.high, value: g.value }, g.unit)
      : '"' + quote + '"';

    rows.push({
      text: label + (when ? ", " + when : "") + ": " + said,
      sortKey: periodSortKey(g.period),
      qualitative: !hasNumber,
    });
  }

  // Figures first, then the qualitative lines. A reader scanning for a number
  // should not have to read past a paragraph to find one.
  //
  // Within each, nearest period first: these are all ahead, so the quarter
  // being guided matters before the year it sits inside.
  rows.sort((a, b) => {
    if (a.qualitative !== b.qualitative) return a.qualitative ? 1 : -1;
    return a.sortKey - b.sortKey;
  });

  const cap = limit || 12;
  return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap) };
}

export function renderEmail(view, options) {
  const opts = options || {};
  const company = view.company || view.ticker;
  const metrics = byMetric(view.pairs || [], 4);
  const moved = movedInThisRelease(view.revisions, view.latestRelease, 6);
  const guided = alsoGuided(view.currentGuidance, 12);

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
    for (const line of textTable(g.rows.map(rowCells))) t.push("   " + line);
    t.push("");
  }

  if (moved.length) {
    t.push("WHAT MOVED IN THIS RELEASE");
    for (const r of moved) t.push("- " + r.summary);
    t.push("");
  }

  if (guided.rows.length) {
    t.push("WHAT THEY GUIDED IN THIS RELEASE");
    for (const r of guided.rows) t.push("- " + r.text);
    if (guided.more) {
      t.push("- and " + guided.more + " further "
        + (guided.more === 1 ? "guide" : "guides") + ", on the site.");
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

    // A real table, not spaced text. role=presentation keeps a screen reader
    // from announcing it as data twice over; border-collapse and explicit
    // cell padding because Outlook ignores the shorthand.
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
      h.push('<tr>');
      cells.forEach((cell, i) => {
        // The outcome column is the one the eye goes to, so it is the only one
        // that is not muted. Still no colour: a tax rate above guidance is bad
        // for the company and irrelevant to a short seller, and red would
        // decide that for the reader.
        const colour = i === 3 ? INK : i === 0 ? MUTED : INK;
        h.push('<td align="left" style="padding:5px 8px 5px 0;border-bottom:1px solid '
          + RULE + ';color:' + colour + ';white-space:nowrap;">' + esc(cell) + '</td>');
      });
      h.push('</tr>');
    }

    h.push('</table>');
    h.push('</div>');
  }

  if (moved.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">What moved in this release</div>');
    for (const r of moved) {
      h.push('<p style="margin:10px 0 0;font-size:15px;">' + esc(r.summary) + '</p>');
    }
    h.push('</div>');
  }

  if (guided.rows.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">What they guided in this release</div>');
    for (const r of guided.rows) {
      h.push('<p style="margin:8px 0 0;font-size:15px;' + (r.qualitative ? 'color:' + MUTED + ';' : '') + '">'
        + esc(r.text) + '</p>');
    }
    if (guided.more) {
      h.push('<p style="margin:10px 0 0;font-size:14px;color:' + MUTED + ';">and '
        + guided.more + ' further ' + (guided.more === 1 ? 'guide' : 'guides')
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
