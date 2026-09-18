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
 * job, and a tool that makes probabilistic claims gets judged on them.
 *
 * It does not editorialise about direction. "Above" and "below" are facts. A
 * higher tax rate needs no commentary from an email.
 *
 * IT PRINTS NO FIGURE THE COMPANY DID NOT PUBLISH. Every number here is read
 * off a filing, or is arithmetic on two figures from one filing. Where a
 * figure would have to be restated to be comparable - a pre-split guide at
 * today's share count - the comparison is dropped and said to be dropped.
 */

import { metricKey, displayLabel } from "./metrics.js";
import { formatFigure, formatValue, periodLabel, periodSortKey } from "./format.js";

const CREAM = "#faf7f0";
const INK = "#1a2b23";
const GREEN = "#1f4435";
const MUTED = "#5b6b62";
const RULE = "#dcd6c8";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

/* Ten rows, not eight. Rows that say "not guided" and "not reported" compete
 * for the same slots, and Walmart's Q2 2026 - the quarter management
 * explicitly declined to guide - was being pushed off the end by a scored
 * period below it. The gaps are not padding. */
const ROWS_PER_METRIC = 10;

/* Six measures, not four. */
const METRICS_SHOWN = 6;

/**
 * How far back a measure can have gone quiet and still be shown.
 *
 * United guided total operating revenue growth through 2023 and stopped. The
 * email carried a three-row table of it - Q2, Q3 and Q4 2023, nothing since -
 * under a heading about how their guidance has held up. Every figure in it was
 * true and the table as a whole was misleading: it reads as a measure this
 * management guides, and they have not guided it for two and a half years.
 *
 * Four quarters, measured against the newest period anywhere in the record, so
 * an annual guider is not caught by it - a measure guided once a year is two
 * quarters behind the latest quarter at worst.
 */
const STALE_AFTER_QUARTERS = 4;

/* periodSortKey packs a year and a slot: 2026Q2 is 20262, 2026FY is 20264. */
function quartersApart(newer, older) {
  const y = Math.floor(newer / 10) - Math.floor(older / 10);
  return y * 4 + ((newer % 10) - (older % 10));
}

/**
 * Every period a measure should have a row for, between its oldest and newest.
 *
 * FROM THE CALENDAR, NOT FROM WHAT HAPPENED TO PAIR.
 *
 * The blanks used to be drawn from periods that some measure, somewhere, had
 * scored. So a gap was only visible if another measure happened to cover it.
 * Broadcom's revenue ran Q3 2026 back to Q4 2024 and then jumped straight to
 * Q4 2023 - four missing quarters, no rows, no explanation, just a sequence
 * that skipped. Nothing else in Broadcom's record covered them either, so
 * there was nothing to draw a blank from.
 *
 * ONLY THE SLOTS THE MEASURE ITSELF USES. A measure guided by the quarter gets
 * quarters; one guided by the year gets years. Delta guides no full year at
 * all, and "FY2025 not guided" appeared in all three of its tables - a row
 * asserting Delta stayed silent about a period it never guides in the first
 * place. Macy's is the mirror image: it guides only the year, and filling its
 * quarters would put three invented blanks between every row.
 *
 * Slot 4 is Q4 for a company that reports one and the full year for a company
 * that reports the year instead, which is why the slots come from the
 * measure's own rows rather than from a rule about calendars.
 */
function periodsInSpan(rows) {
  const keys = rows.map((p) => periodSortKey(p.period)).filter((k) => k > 0);
  if (!keys.length) return [];

  const slots = new Set(keys.map((k) => k % 10));
  const usesYear = rows.some((p) => /FY$/.test(String(p.period)));

  const out = [];
  for (let k = Math.min(...keys); k <= Math.max(...keys); k += 1) {
    const slot = k % 10;
    if (!slots.has(slot)) continue;
    const year = Math.floor(k / 10);
    out.push(slot === 4 && usesYear ? year + "FY" : year + "Q" + slot);
  }
  return out;
}

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
 * wrong number.
 */
function formatDelta(d, unit, signed) {
  const sign = signed ? (d > 0 ? "+" : d < 0 ? "-" : "") : "";
  const size = Math.abs(tidy(d));
  switch (unit) {
    case "percent": return sign + size + "pp";
    case "USD billions": return sign + "$" + size + "bn";
    case "USD millions": return sign + "$" + size + "m";
    // Two decimals, matching formatValue. "above by $0.1" beside a guide of
    // "$1.00 to $2.00" is the same number written two ways in one row.
    case "USD per share": return sign + "$" + size.toFixed(2);
    case "multiple": return sign + size + "x";
    default: return sign + size;
  }
}

/**
 * How far outside the range, and nothing more.
 *
 * ONE DISTANCE, MEASURED FROM THE END IT PASSED. Within the range, no number.
 * A delta column implies one reference point, a reader assumes the midpoint,
 * and the whole product rests on never using midpoints.
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
 * earnings guidance by two thirds - and it never happened.
 *
 * Only LEVEL measures; percentages are exempt for the same reason they are
 * exempt from the scope-change test in revisions.js.
 *
 * KNOWN HOLE: a 50% spin-off sits at almost exactly the same ratio as United's
 * real 42% EPS cut on fuel, so no single threshold separates them. Splits are
 * caught; separations of about half are not.
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
 * "3% to 4% → 4.8% to 5.1%" rather than "4.8% to 5.1%". Walmart opened fiscal
 * 2026 guiding 3% to 4% and closed it guiding 4.8% to 5.1%, then reported
 * 5.1%. Against the final range that is "within", and the range had moved to
 * meet the result. The company that held its guide all year and the company
 * that raised twice print the same word; this is the difference between them.
 *
 * FIRST AND LAST ONLY. The verdict still measures against the final guide -
 * what management was standing behind when the period closed.
 */
function guideCell(p) {
  const now = formatFigure(p.guide, p.unit);
  const path = Array.isArray(p.guidePath) ? p.guidePath
    : (p.first ? [p.first, p.guide] : null);
  if (!Array.isArray(path) || path.length < 2) return { text: now, noted: false };

  const first = path[0];
  const firstText = formatFigure(first, p.unit);
  if (firstText === now) return { text: now, noted: false };

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
    // label split one measure into four and dropped three of them.
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
    // alphabetical: "2026FY" sorted before "2026Q1" because F precedes Q.
    g.rows.sort((a, b) => periodSortKey(b.period) - periodSortKey(a.period));
    g.total = g.rows.length;
  }

  /* The newest period the company has answered anything for, on any measure.
     The yardstick for whether a measure has gone quiet. */
  const newestOverall = Math.max(0, ...Array.from(companyPeriods.values()));

  function stale(g) {
    if (!newestOverall) return false;
    const newest = Math.max(...g.rows.map((p) => periodSortKey(p.period)));
    return quartersApart(newestOverall, newest) > STALE_AFTER_QUARTERS;
  }

  const live = out.filter((g) => !stale(g));

  const earned = live.filter((g) => g.total >= 3);
  earned.sort((a, b) => b.total - a.total);

  // Guided, but not enough closed periods to show a record yet. Named rather
  // than dropped - and only while the company is still guiding it. A measure
  // abandoned in 2023 does not belong in a line about what they guide.
  const belowBar = live
    .filter((g) => g.total < 3)
    .sort((a, b) => b.total - a.total)
    .map((g) => ({ metric: g.metric, total: g.total, unit: g.unit, rows: g.rows.slice(0, 2) }));

  for (const g of earned) {
    g.allPeriods = g.rows.length;

    const key = metricKey(g.labels[0]);
    const have = new Set(g.rows.map((p) => p.period));

    const extra = [];
    for (const period of periodsInSpan(g.rows)) {
      if (have.has(period)) continue;

      const u = unansweredByKey.get(key + "|" + period);
      if (u) {
        extra.push({ period, unit: u.unit, guide: u.guide, guidePath: u.guidePath || null, unanswered: true });
      } else {
        // IT SAYS "NOT GUIDED", NEVER "NOT DISCLOSED". Whether the company
        // withheld it or the extraction missed it is not knowable from here,
        // and the second is not a claim to make about management.
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
const ANNUAL_HEADINGS = ["Measure", "Year", "Guided", "Reported", ""];

/**
 * The same table in plain text, columns padded to line up.
 *
 * Plain text is what a client that strips styling shows, and the version that
 * has to survive being forwarded.
 */
function textTable(headings, rows) {
  const all = [headings, ...rows];
  const widths = headings.map((_, i) =>
    Math.max(...all.map((r) => String(r[i] || "").length)));

  return all.map((r, ri) => {
    const line = r
      .map((cell, i) => String(cell || "").padEnd(widths[i]))
      .join("  ")
      .replace(/\s+$/, "");
    return ri === 0
      ? line + "\n   " + "-".repeat(Math.min(widths.reduce((a, b) => a + b, 0) + 8, 72))
      : line;
  });
}

/**
 * The annual measures.
 *
 * A measure guided once a year needs three closed years to earn a table above,
 * and the backfill reads about three and a half years of releases. So Walmart's
 * effective tax rate and capital expenditure sit at two pairs and one, and
 * would wait another year or two for a record that already exists - in the
 * company's own tagged XBRL, which carries every year at once.
 *
 * Its own table because it is its own thing. Different source, different
 * rules, and a reader should be able to see which figures came from a release
 * and which from a filing's tags without being told twice.
 *
 * TWO MARKS, both about honesty rather than decoration:
 *   †  the figure is arithmetic on two tagged numbers rather than one tagged
 *      number - capital expenditure over revenue, for a guide stated as a
 *      percentage of sales.
 *   ‡  the company guided an adjusted figure and the tag is GAAP. They are not
 *      the same number, and the row says so rather than quietly comparing them.
 */
function annualRows(annual) {
  const rows = [];
  let computed = false;
  let caveat = false;

  /* One label per measure, not one per row.
   *
   * United wrote "Adjusted capital expenditures", "adjusted capital
   * expenditures" and "Adjusted total capital expenditures" in three
   * consecutive years, and the table printed all three - the same measure
   * looking like three, stacked. displayLabel already picks one name from many
   * variants; it was just never being given the variants. */
  const labels = new Map();
  for (const a of annual || []) {
    const k = metricKey(a.metric);
    if (!labels.has(k)) labels.set(k, []);
    labels.get(k).push(a.metric);
  }

  for (const a of annual || []) {
    const label = displayLabel(labels.get(metricKey(a.metric)) || a.metric);

    if (!a.comparable) {
      // The reason arrives as a short code rather than being read back out of
      // the sentence. The first version tested the prose for the word "unit"
      // and missed "Guided in other, tagged in USD millions" - which is a unit
      // mismatch that never says "unit". Parsing your own error messages is a
      // rule that breaks the moment someone rewords one.
      // An open year is not a failure to find a figure, so it does not read
      // like one. The guide is the whole point of the row.
      const open = a.refusal === "year not ended";
      rows.push([label, periodLabel(a.period), formatFigure(a.guide, a.unit),
        open ? "year not ended" : (a.refusal || "not tagged"),
        open ? "" : "n/a"]);
      continue;
    }

    if (a.computed) computed = true;
    if (a.basisCaveat) caveat = true;

    const marks = (a.computed ? "†" : "") + (a.basisCaveat ? "‡" : "");
    const guide = guideCell({ guide: a.guide, first: a.first, unit: a.unit });

    rows.push([
      label,
      periodLabel(a.period),
      guide.text,
      (formatValue(a.actual, a.unit) || String(a.actual)) + marks,
      outcomeCell(a),
    ]);
  }

  const notes = [];
  if (caveat) {
    notes.push("‡ The company's own label calls this an adjusted figure. The tagged"
      + " result is the GAAP one, so the two are not the same measure and the gap is not"
      + " only performance. Nothing here is restated to bridge them.");
  }
  if (computed) {
    notes.push("† Capital expenditure over revenue, both as the company tagged them for"
      + " that year. The guide is stated as a percentage of sales, so the comparison has"
      + " to be one too.");
  }

  return { rows, notes };
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
 * WHAT THIS STILL CANNOT SHOW: a guide with no number. revisionsBetween
 * compares figures and skips anything qualitative.
 */
function movedInThisRelease(revisions, latest, limit) {
  const wanted = new Set(["raised", "cut", "unchanged", "new", "narrowed", "widened", "scope change"]);
  const accession = latest && latest.accession;
  const cap = limit || 20;

  const rows = (revisions || []).filter((r) => wanted.has(r.direction));
  const fromLatest = accession ? rows.filter((r) => r.release === accession) : rows;

  return { rows: fromLatest.slice(0, cap), more: Math.max(0, fromLatest.length - cap) };
}

/**
 * Measures guided, but with too little history to be a record.
 *
 * This was a sentence - "Also guided, too few closed periods to show a record
 * yet: Adjusted CASM-ex YOY (1)" - which named the measure and withheld
 * everything a reader wanted. United guides CASM-ex every quarter and the one
 * figure on record was sitting in the email as a parenthesis.
 *
 * So it is a table: what was guided, what came in. No block of its own,
 * because one period is not a pattern and a full block would claim it is - but
 * the figures are the point and there is no reason to keep them back.
 *
 * Measures that now have a table above are left out. The line was naming
 * effective tax rate and capital expenditures directly underneath three years
 * of both.
 */
function belowBarRows(belowBar, annual) {
  if (!belowBar || !belowBar.length) return [];

  const shown = new Set((annual || []).map((a) => metricKey(a.metric)));
  const out = [];

  for (const m of belowBar) {
    if (shown.has(metricKey(m.metric))) continue;
    for (const p of m.rows) {
      if (p.notGuided) continue;
      out.push([
        m.metric,
        periodLabel(p.period),
        guideCell(p).text,
        p.unanswered
          ? "not reported"
          : (formatValue(p.actual, p.unit) || String(p.actual)),
        p.unanswered ? "n/a" : outcomeCell(p),
      ]);
      if (out.length >= 6) return out;
    }
  }

  return out;
}

export function renderEmail(view, options) {
  const opts = options || {};
  const company = view.company || view.ticker;
  const { metrics, belowBar } = byMetric(view.pairs || [], view.unanswered || [], METRICS_SHOWN);
  const moved = movedInThisRelease(view.revisions, view.latestRelease, 20);
  const annual = annualRows(view.annual);
  const alsoRows = belowBarRows(belowBar, view.annual);
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
    for (const line of textTable(HEADINGS, g.rows.map(rowCells))) t.push("   " + line);
    t.push("");
  }

  if (anyNote) {
    t.push(SPLIT_NOTE);
    t.push("");
  }

  if (annual.rows.length) {
    t.push("GUIDED ONCE A YEAR");
    t.push("Results from the company's own tagged filings, not from the release.");
    for (const line of textTable(ANNUAL_HEADINGS, annual.rows)) t.push("   " + line);
    for (const n of annual.notes) t.push(n);
    t.push("");
  }

  if (alsoRows.length) {
    t.push("ALSO GUIDED, TOO FEW PERIODS TO SHOW A RECORD YET");
    for (const line of textTable(ANNUAL_HEADINGS, alsoRows)) t.push("   " + line);
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

  const th = (head) => '<th align="left" style="padding:0 8px 5px 0;border-bottom:1px solid '
    + RULE + ';font-weight:normal;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:'
    + MUTED + ';">' + esc(head) + '</th>';

  const td = (cell, colour) => '<td align="left" style="padding:5px 8px 5px 0;border-bottom:1px solid '
    + RULE + ';color:' + colour + ';white-space:nowrap;">' + esc(cell) + '</td>';

  for (const g of metrics) {
    h.push('<div style="margin-top:22px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:16px;color:' + GREEN + ';">' + esc(g.metric) + '</div>');
    h.push('<div style="font-size:14px;color:' + MUTED + ';margin-top:2px;">' + esc(countLine(g)) + '</div>');

    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + MONO
      + ';font-size:13px;">');
    h.push('<tr>' + HEADINGS.map(th).join("") + '</tr>');

    for (const p of g.rows) {
      const quiet = p.notGuided || p.unanswered;
      const cells = rowCells(p);
      h.push('<tr>' + cells.map((cell, i) =>
        // A row with no outcome is muted throughout: context, not a result.
        // Still no colour anywhere - a tax rate above guidance is bad for the
        // company and irrelevant to a short seller, and red would decide that
        // for the reader.
        td(cell, quiet ? MUTED : i === 0 ? MUTED : INK)).join("") + '</tr>');
    }

    h.push('</table></div>');
  }

  if (anyNote) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + MUTED + ';line-height:1.5;">'
      + esc(SPLIT_NOTE) + '</p>');
  }

  if (annual.rows.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">Guided once a year</div>');
    h.push('<div style="font-size:14px;color:' + MUTED + ';margin-top:2px;">'
      + 'Results from the company\'s own tagged filings, not from the release.</div>');

    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + MONO
      + ';font-size:13px;">');
    h.push('<tr>' + ANNUAL_HEADINGS.map(th).join("") + '</tr>');
    for (const r of annual.rows) {
      h.push('<tr>' + r.map((cell, i) => td(cell, i === 0 || i === 1 ? MUTED : INK)).join("") + '</tr>');
    }
    h.push('</table>');

    for (const n of annual.notes) {
      h.push('<p style="margin-top:10px;font-size:12px;color:' + MUTED + ';line-height:1.5;">'
        + esc(n) + '</p>');
    }
    h.push('</div>');
  }

  if (alsoRows.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';">');
    h.push('<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:' + MUTED + ';">Also guided</div>');
    h.push('<div style="font-size:14px;color:' + MUTED + ';margin-top:2px;">Too few closed periods to show a record yet.</div>');
    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + MONO
      + ';font-size:13px;">');
    h.push('<tr>' + ANNUAL_HEADINGS.map(th).join("") + '</tr>');
    for (const r of alsoRows) {
      h.push('<tr>' + r.map((cell, i) => td(cell, i === 0 || i === 1 ? MUTED : INK)).join("") + '</tr>');
    }
    h.push('</table></div>');
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

  h.push('<p style="margin-top:26px;padding-top:14px;border-top:1px solid ' + RULE + ';font-size:13px;color:' + MUTED + ';line-height:1.6;">'
    + 'Questions, or something that looks wrong: reply to this, or write to '
    + '<a href="mailto:hello@zahoorbhat.com" style="color:' + MUTED + ';">hello@zahoorbhat.com</a>. '
    + 'Every figure is read from the company\'s own filings on EDGAR. Guidance comes from the'
    + ' earnings release; results from the release that reported the period, or from the'
    + ' company\'s tagged annual filings where a measure is guided once a year. A guide is'
    + ' only scored against the same period, on the same basis. Nothing here is a forecast.</p>');

  if (opts.unsubscribeUrl) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + MUTED + ';">'
      + '<a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + MUTED + ';">Unsubscribe</a>'
      + (opts.postalAddress ? ' &middot; ' + esc(opts.postalAddress) : '') + '</p>');
  }

  h.push('</div></div>');

  return { subject, html: h.join("\n"), text: t.join("\n") };
}
