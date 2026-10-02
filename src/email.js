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

import { metricKey as exactKey, displayLabel } from "./metrics.js";

/**
 * The measure's identity FOR READING, a little looser than the one pairing
 * uses.
 *
 * Conagra wrote the same guide three ways in three years - "organic net
 * sales", "organic net sales growth", "organic net sales change" - and the
 * email printed three one-row tables, one of them repeating FY2026 twice.
 * "Growth", "change", "diluted", "common" and the "U.S." of "U.S. GAAP" do not
 * change which measure is meant. Only the email's grouping uses this; pairing
 * a guide with a result still uses the exact key (metrics.js).
 */
function metricKey(x) {
  return exactKey(x)
    .replace(/\bu s\b/g, " ")
    .replace(/\b(growth|change|diluted|common)\b/g, " ")
    .replace(/\bper share(\s+per share)+\b/g, "per share")
    .replace(/\s+/g, " ")
    .trim();
}
import { formatFigure, formatValue, formatGap, periodLabel, periodSortKey, displayName } from "./format.js";

const CREAM = "#faf7f0";
const INK = "#1a2b23";
const GREEN = "#1f4435";
const MUTED = "#5b6b62";
const RULE = "#dcd6c8";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

/* The range strip, as on the site: a pale track, the guided range in green,
   the reported figure as a dark mark. The green is the GUIDE, never a verdict
   - the same green whether the figure landed inside, above or below. */
const TRACK = "#e7e2d5";
const BAND = "#a8d8bf";
const MARK = INK;

/* Ten rows, not eight. Rows that say "not guided" and "not reported" compete
 * for the same slots, and Walmart's Q2 2026 - the quarter management
 * explicitly declined to guide - was being pushed off the end by a scored
 * period below it. The gaps are not padding. */
const ROWS_PER_METRIC = 10;

/* Six measures, not four. */
const METRICS_SHOWN = 10;

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
  // One definition with the rest of the product (format.js), so a gap of
  // 1,182 ($m) prints as $1.182bn exactly as the figure beside it does.
  return formatGap(d, unit, signed);
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
    // "$0bn vs single figure" read like a typo. Exactly on it says so.
    if (tidy(actual - value) === 0) return "on the guide";
    const d = tidy(actual - value);
    return formatDelta(Math.abs(d), p.unit, false) + (d > 0 ? " above" : " below");
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
/* A floor or a ceiling, in words: "under $6.5bn", "at least $7.35". */
function boundText(p) {
  if (!p || !p.bound || !p.guide) return null;
  const x = p.bound === "ceiling" ? p.guide.high : p.guide.low;
  if (typeof x !== "number") return null;
  return (p.bound === "ceiling" ? "under " : "at least ") + formatValue(x, p.unit);
}

/* A guide path in the pair's own unit: money rescaled ($m <-> $bn), anything
   in a different kind of unit dropped. An entry with no unit (records built
   before units were kept) is left as it is. */
function pathInUnit(path, unit) {
  if (!Array.isArray(path)) return path;
  const want = unitClass(unit);
  const out = [];
  for (const e of path) {
    if (!e || !e.unit) { out.push(e); continue; }
    if (unitClass(e.unit) !== want) continue;
    const k = want === "money" ? unitScale(e.unit) / unitScale(unit) : 1;
    const f = (x) => (typeof x === "number" ? tidy(x * k) : x);
    out.push({ ...e, low: f(e.low), high: f(e.high), value: f(e.value), unit });
  }
  return out;
}

function guideCell(p) {
  const now = boundText(p) || formatFigure(p.guide, p.unit);
  const path = Array.isArray(p.guidePath) ? pathInUnit(p.guidePath, p.unit)
    : (p.first ? [p.first, p.guide] : null);
  if (!Array.isArray(path) || path.length < 2) return { text: now, noted: false };

  const first = path[0];
  const firstText = formatFigure(first, p.unit);
  if (firstText === now) return { text: now, noted: false };

  // Per-share guides: the record says whether a real split lies between the
  // first guide and the last. Delta cut its first-quarter 2025 EPS guide from
  // $0.70-$1.00 to $0.30-$0.50 mid-quarter - more than half - and the ratio
  // test hid that path behind a footnote about splits, when there was none.
  // The ratio test is kept only where the record does not know (older records)
  // and for level measures, where a spin-off is the thing it catches.
  const crossed = p.pathAcrossSplit === true || p.pathAcrossSplit === false
    ? p.pathAcrossSplit
    : scaleChanged(first, p.guide, p.unit);
  if (crossed) return { text: now, noted: true };

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

  const group = (key, unit) => {
    if (!groups.has(key)) {
      groups.set(key, { labels: [], unit, rows: [], above: 0, within: 0, below: 0, noVerdict: 0 });
    }
    return groups.get(key);
  };

  for (const p of pairs) {
    // Grouped on the shared metric identity, NOT on the label as the company
    // wrote it. Broadcom names the quarter inside its labels, so grouping by
    // label split one measure into four and dropped three of them.
    // Measure AND kind of unit: Carnival's "adjusted net income" is guided
    // both in dollars and as a growth rate, and one table held $1.86bn and
    // "at least 60%" in adjacent rows. Each kind gets its own table.
    const key = metricKey(p.metric) + "|" + unitClass(p.unit);
    const g = group(key, p.unit);
    g.key = key;
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

  /**
   * A measure with NO comparable pair at all still gets a table.
   *
   * General Electric guides revenue growth and operating profit every year.
   * The release prints revenue in dollars, not as a rate, so every pair was
   * refused - and with the groups built only from scored pairs, the measures
   * had no table to be refused in. Two of the three things GE actually guides
   * were absent from an email about GE's guidance.
   *
   * So an unanswered guide can open a table of its own. Every row in it will
   * read "not reported", which is the truth and is worth more than silence.
   */
  /* The newest period anything has been answered for. A guide for a period
     after it is a guide for a period that has not happened, and "not
     reported" against it is false - Delta's FY2026 and Q3 2026 were both
     printing it, the second directly above a line saying Delta had just
     guided Q3 2026. Those guides belong in What Moved, which is where they
     already are. */
  const newestScored = Math.max(0, ...Array.from(companyPeriods.values()));

  const unansweredByKey = new Map();
  for (const u of unanswered || []) {
    if (!u.metric || !u.period) continue;
    if (newestScored && periodSortKey(u.period) > newestScored) continue;

    const key = metricKey(u.metric) + "|" + unitClass(u.unit);
    unansweredByKey.set(key + "|" + u.period, u);

    /* NO ROW FOR A GUIDE WE COULD NOT MATCH.
     *
     * These rows read "not reported" - and Delta DID report its FY2024 EPS
     * ($6.16) and its revenue in every quarter shown. The extraction missed
     * them. A reader who knows Delta sees a false statement about the company,
     * which costs more than the row is worth. So the guide is counted, and the
     * count line says how many were left out and why. */
    const g = group(key, u.unit);
    g.labels.push(u.metric);
    if (!g.rows.some((p) => p.period === u.period)) {
      if (u.split) g.acrossSplit = (g.acrossSplit || 0) + 1;
      else g.unmatched = (g.unmatched || 0) + 1;
    }
  }

  /* Every period each measure was guided for, IN ANY UNIT.
   *
   * Carnival guided its fiscal 2025 adjusted net income as a growth rate
   * ("up nearly 55 percent"), and the dollar table for the same measure
   * printed "FY2025 not guided" - false: it was guided, in the other table.
   * A blank row is only made up for a period the company said nothing about
   * this measure in any unit. */
  const guidedAnyUnit = new Set();
  for (const p of pairs) if (p.period) guidedAnyUnit.add(metricKey(p.metric) + "|" + p.period);
  for (const u of unanswered || []) if (u.metric && u.period) guidedAnyUnit.add(metricKey(u.metric) + "|" + u.period);

  const out = Array.from(groups.values());

  /* One row per period. With labels merged above, two answers for the same
     guide under two names - Conagra's FY2026 as both "organic net sales
     change" and "organic net sales growth" - would print the same period
     twice. The first is kept and the duplicate's count taken back. */
  for (const g of out) {
    const seen = new Set();
    g.rows = g.rows.filter((p) => {
      const k = String(p.period) + "|" + JSON.stringify(p.guide || null) + "|" + String(p.actual);
      if (seen.has(k)) {
        if (p.position === "above") g.above -= 1;
        else if (p.position === "within") g.within -= 1;
        else if (p.position === "below") g.below -= 1;
        else g.noVerdict -= 1;
        return false;
      }
      seen.add(k);
      return true;
    });
  }

  const baseCount = new Map();
  for (const [key] of groups) {
    const base = key.split("|")[0];
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }
  for (const [key, g] of groups) {
    g.key = key;
    g.metric = displayLabel(g.labels);
    // Two tables for one measure: say which is the rate.
    if (baseCount.get(key.split("|")[0]) > 1 && unitClass(g.unit) === "rate" && !/%|growth|margin|yield|rate/i.test(g.metric)) {
      g.metric += " (%)";
    }
  }
  for (const g of out) {
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

  // A measure with nothing scored has nothing to show.
  const live = out.filter((g) => g.rows.length && !stale(g));

  /**
   * THE THREE-PAIR BAR IS GONE.
   *
   * It existed because Delta's gross leverage was appearing on the strength of
   * one period, which is an anecdote rather than a record. That reasoning
   * still holds for how much a single row proves - and the count line above
   * every table says how many periods it rests on, so a reader can see it is
   * one.
   *
   * What the bar cost was worse: a measure the company guides every quarter
   * could be absent from an email about that company's guidance, and the
   * reader had no way to tell whether it had been dropped, missed, or never
   * guided. The point of the product is the guidance; the record is how much
   * of it can be answered yet.
   */
  const earned = live.slice().sort((a, b) => b.total - a.total || b.rows.length - a.rows.length);

  // Nothing sits below a bar any more; every measure has a table of its own.
  const belowBar = [];

  for (const g of earned) {
    g.allPeriods = g.rows.length;

    const key = g.key || (metricKey(g.labels[0]) + "|" + unitClass(g.unit));
    const have = new Set(g.rows.map((p) => p.period));

    /* Slots already taken, by position rather than by name. FY2025 and Q4
       2025 share slot 4: a measure with a full-year row there must not also
       get an invented "Q4 2025 not guided" underneath it. Genuine rows for
       both still show - Delta really does guide Q4 and the year separately -
       this only stops a BLANK being made up for a slot a real row fills. */
    const slotsTaken = new Set(g.rows.map((p) => periodSortKey(p.period)));

    /* The calendar comes from the rows that were actually scored. An
       unanswered guide appears as itself; it does not get to decide which
       slots the measure has. Otherwise one stray full-year guide on a
       quarterly measure turned every year into a "not guided" row, and
       Delta's operating margin table - a measure Delta has never guided
       annually - carried two of them. */
    const scoredRows = g.rows.filter((p) => !p.unanswered);
    /* Gaps are only filled for a kind of period the company guides this
       measure in regularly. General Electric guides the full year; one early
       quarterly EPS guide (Q1 2024) was enough to open a quarterly slot, and
       the table printed "Q1 2025 not guided" between two full years - true,
       and noise. Two guides of a kind make it a habit worth showing gaps in. */
    const kindCount = { Q: 0, FY: 0 };
    for (const p of g.rows) {
      if (p.notGuided || p.unanswered || !p.period) continue;
      kindCount[/FY$/.test(p.period) ? "FY" : "Q"] += 1;
    }
    const extra = [];
    for (const period of periodsInSpan(scoredRows.length ? scoredRows : g.rows)) {
      if (have.has(period)) continue;
      if (!scoredRows.length) continue;
      if (kindCount[/FY$/.test(period) ? "FY" : "Q"] < 2) continue;
      if (slotsTaken.has(periodSortKey(period))) continue;
      if (guidedAnyUnit.has(key.split("|")[0] + "|" + period)) continue;

      const u = unansweredByKey.get(key + "|" + period);
      if (u) {
        // Guided, not matched: counted in the line above the table, not drawn.
        continue;
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
    g.hasFlag = g.rows.some((p) => p.flagged);
  }

  return { metrics: earned.slice(0, limit || METRICS_SHOWN), belowBar };
}


/* ------------------------------------------------------------------ *
 * The range strip
 * ------------------------------------------------------------------ */

/**
 * One row's strip: where the reported figure sits against the guided range.
 *
 * BUILT FROM TABLE CELLS. The site positions a dot with CSS; mail clients
 * strip that, Outlook above all. A single row of cells with set widths and
 * background colours is the one layout every client draws the same way.
 *
 * THE SCALE IS THE SITE'S. The range sits in the middle with 1.4 range-widths
 * of room either side, so rows compare with each other: a figure far outside
 * its range is drawn at the edge, and the numbers beside it say how far.
 * A single-figure guide is a narrow green tick, with room enough on the scale
 * for the reported mark to sit clear of it.
 */
export function stripCells(p) {
  const g = p.guide || {};
  const actual = num(p.actual);
  let lo = num(g.low) !== null ? num(g.low) : num(g.value);
  let hi = num(g.high) !== null ? num(g.high) : num(g.value);
  if (actual === null) return null;
  // A ceiling or floor: the band runs from the bound off the edge of the strip
  // on its open side, scaled so the reported mark sits clear of the bound.
  if (p.bound === "ceiling" && hi !== null) {
    const span = Math.max(Math.abs(actual - hi), Math.abs(hi) * 0.05, 0.01);
    lo = hi - span * 6;
  } else if (p.bound === "floor" && lo !== null) {
    const span = Math.max(Math.abs(actual - lo), Math.abs(lo) * 0.05, 0.01);
    hi = lo + span * 6;
  }
  if (lo === null || hi === null) return null;

  const point = lo === hi;
  const width = point
    ? Math.max(Math.abs(actual - lo), Math.abs(lo) * 0.02, 0.01)
    : (hi - lo);
  const pad = width * 1.4;
  const min = lo - pad, max = hi + pad;
  const at = (x) => Math.max(0, Math.min(100, ((x - min) / (max - min)) * 100));

  // Whole-percent segments. Every boundary is rounded once, here, so the
  // cells always add to exactly 100.
  let bandFrom = Math.round(at(lo));
  let bandTo = Math.round(at(hi));
  if (point || bandTo - bandFrom < 3) {
    const c = Math.round((bandFrom + bandTo) / 2);
    bandFrom = Math.max(0, c - 1);
    bandTo = Math.min(100, bandFrom + 3);
  }
  let markFrom = Math.round(at(actual)) - 1;
  markFrom = Math.max(0, Math.min(97, markFrom));
  const markTo = markFrom + 3;

  // Cut the 0-100 line at every boundary and colour each piece.
  const cuts = Array.from(new Set([0, bandFrom, bandTo, markFrom, markTo, 100])).sort((a, b) => a - b);
  const cells = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b <= a) continue;
    const mid = (a + b) / 2;
    const colour = mid >= markFrom && mid < markTo ? MARK
      : mid >= bandFrom && mid < bandTo ? BAND
        : TRACK;
    cells.push({ width: b - a, colour });
  }
  return cells;
}

function stripHtml(p) {
  const cells = stripCells(p);
  if (!cells) return "";
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"'
    + ' style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>'
    + cells.map((c) => '<td width="' + c.width + '%" bgcolor="' + c.colour + '" style="width:'
      + c.width + '%;height:8px;line-height:8px;font-size:0;background-color:' + c.colour
      + ';">&nbsp;</td>').join("")
    + '</tr></table>';
}

/* ------------------------------------------------------------------ *
 * Reading the record: sentences at the foot of the email
 * ------------------------------------------------------------------ */

/**
 * Where one figure landed, against the low and the high. Never the midpoint.
 *
 * Within the range, both distances - "$0.46 above the low, $0.04 below the
 * high" - because "within" alone hides whether it scraped in or cleared it.
 * Outside, the distance from the end it passed. A single figure gets a
 * distance and no verdict, as everywhere else in the product.
 */
export function landedText(p) {
  const g = p.guide || {};
  const actual = num(p.actual);
  const low = num(g.low), high = num(g.high), value = num(g.value);
  if (actual === null) return null;

  const range = low !== null && high !== null ? formatFigure(g, p.unit) + " range" : null;
  const d = (x) => formatDelta(x, p.unit, false);

  const b = boundText(p);
  if (b) {
    const x = p.bound === "ceiling" ? high : low;
    const gap = tidy(Math.abs(actual - x));
    if (p.position === "within") {
      return gap === 0 ? "exactly at the guided " + (p.bound === "ceiling" ? "ceiling" : "floor") + " (" + b + ")"
        : "within the guide of " + b + ", " + d(gap) + (p.bound === "ceiling" ? " under it" : " over it");
    }
    return (p.position === "above" ? "above" : "below") + " the guide of " + b + " by " + d(gap);
  }

  if (p.position === "within" && range) {
    const fromLow = tidy(actual - low), toHigh = tidy(high - actual);
    const lowPart = fromLow === 0 ? "at the low" : d(fromLow) + " above the low";
    const highPart = toHigh === 0 ? "at the high" : d(toHigh) + " below the high";
    return "within the " + range + ", " + lowPart + ", " + highPart;
  }
  if (p.position === "above" && range) return "above the " + range + ", " + d(actual - high) + " above the high";
  if (p.position === "below" && range) return "below the " + range + ", " + d(low - actual) + " below the low";
  if (value !== null) {
    const gap = tidy(actual - value);
    if (gap === 0) return "at the single figure guided, " + formatValue(value, p.unit);
    return d(gap) + (gap > 0 ? " above" : " below") + " the single figure guided, "
      + formatValue(value, p.unit);
  }
  return null;
}

/** Where the guide for a period started, when it moved before the result. */
function startedAt(p) {
  const c = guideCell(p);
  if (c.noted || c.text.indexOf(" → ") === -1) return null;
  return c.text.split(" → ")[0];
}

/* A gap, printed exactly. A median of two per-share gaps can fall between
   cents - $0.01 and $0.02 give $0.015 - and formatDelta's two decimals would
   print that as $0.01 or $0.02, neither of which is the median. */
function gapText(x, unit) {
  const v = tidy(x);
  /* Whole cents compared with a tolerance. 0.28 * 100 is 28.000000000000004
     in floating point, so FactSet's $0.28 gap printed as "$0.280". */
  const cents = v * 100;
  if (unit === "USD per share" && Math.abs(cents - Math.round(cents)) > 1e-6) return "$" + v.toFixed(3);
  // A median of gaps some in $m and some in $bn lands between the two:
  // "$0.1505bn" is $150.5m, and is written that way.
  if (unit === "USD billions" && Math.abs(v) < 1 && Math.abs(cents - Math.round(cents)) > 1e-6) {
    return formatDelta(tidy(v * 1000), "USD millions", false);
  }
  return formatDelta(v, unit, false);
}

/* Dollars per unit of a money unit, so gaps in $m and $bn can be compared.
   Anything else (%, per share) is already one unit and scales by 1. */
function unitScale(unit) {
  const u = String(unit || "").toLowerCase();
  if (/billion/.test(u)) return 1e9;
  if (/million/.test(u)) return 1e6;
  if (/thousand/.test(u)) return 1e3;
  return 1;
}

function median(xs) {
  const v = xs.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The closing section: how the company reported against its guidance, and
 * what it guided next - set side by side, with nothing drawn from them.
 *
 * WHAT IT IS FOR. A portfolio manager reading the tables wants two things
 * put next to each other: how this management's figures have landed against
 * its ranges, and what it has just guided. The juxtaposition is the point.
 * The inference - is the new range conservative? - is his, and the email
 * never writes it (see the note at the top of this file).
 *
 * THREE PARTS, all counted or read off the record:
 *   1. every figure this release reported, against its low and high;
 *   2. per measure, the count of periods above, within and below, and the
 *      typical distance past the end when outside - a median of the gaps,
 *      which is a statistic of results, not a midpoint of any guide;
 *   3. per measure, what this release guided for it.
 */
export function readingOf(view, metrics) {
  const latest = view.latestRelease && view.latestRelease.accession;
  const moved = (view.revisions || []).filter((r) => latest && r.release === latest
    && ["raised", "cut", "unchanged", "new", "narrowed", "widened", "share split"].includes(r.direction));

  const reported = [];
  const measures = [];

  for (const g of metrics) {
    const key = metricKey(g.labels[0]);
    const real = g.rows.filter((p) => !p.notGuided && !p.unanswered);

    for (const p of real) {
      if (!latest || p.answeredBy !== latest) continue;
      const where = landedText(p);
      if (!where) continue;
      const start = startedAt(p);
      reported.push(g.metric + ", " + periodLabel(p.period) + ": "
        + (formatValue(p.actual, p.unit) || String(p.actual)) + ", " + where + "."
        + (start ? " The guide for this period started at " + start + "." : ""));
    }

    const parts = [];
    const ranged = g.above + g.within + g.below;
    if (ranged) {
      const bits = [];
      if (g.above) bits.push("above the range in " + g.above);
      if (g.within) bits.push("within it in " + g.within);
      if (g.below) bits.push("below it in " + g.below);
      parts.push(bits.join(", ") + " of " + ranged + (ranged === 1 ? " period" : " periods"));

      // Gaps in the measure's own unit. Micron guided operating expenses in
      // $m some quarters and $bn others; the median of 0.039 ($bn) and 23 ($m)
      // printed as "$11.5195bn". Every gap is converted before it is compared.
      const inUnit = (x, p) => x * unitScale(p.unit) / unitScale(g.unit);
      const aboveBy = real.filter((p) => p.position === "above")
        .map((p) => inUnit(num(p.actual) - num(p.guide.high), p)).filter((x) => Number.isFinite(x));
      const belowBy = real.filter((p) => p.position === "below")
        .map((p) => inUnit(num(p.guide.low) - num(p.actual), p)).filter((x) => Number.isFinite(x));
      if (aboveBy.length >= 2) parts.push("when above, a median " + gapText(median(aboveBy), g.unit) + " over the high");
      else if (aboveBy.length === 1) parts.push("when above, " + gapText(aboveBy[0], g.unit) + " over the high");
      if (belowBy.length >= 2) parts.push("when below, a median " + gapText(median(belowBy), g.unit) + " under the low");
      else if (belowBy.length === 1) parts.push("when below, " + gapText(belowBy[0], g.unit) + " under the low");
    }
    if (g.noVerdict) {
      parts.push(g.noVerdict + (g.noVerdict === 1 ? " period" : " periods") + " against a single figure");
    }
    if (!parts.length) continue;

    const next = moved.filter((r) => metricKey(r.label || r.metric) === key).map((r) => r.summary);
    measures.push({
      line: g.metric + ": " + parts.join("; ") + ".",
      next: next.length ? "Guided in this release: " + next.join(" ") : "Nothing new guided for it in this release.",
    });
  }

  return { reported, measures };
}


/* ------------------------------------------------------------------ *
 * The brief: what a PM reads first
 * ------------------------------------------------------------------ */

/* Kinds of unit, for keeping each table to one kind. */
function unitClass(unit) {
  const u = String(unit || "").toLowerCase();
  if (u === "percent" || /percent|%|points/.test(u)) return "rate";
  if (/per share/.test(u)) return "per-share";
  if (/usd|eur|gbp|jpy|\$|dollar/.test(u)) return "money";
  return "other";
}

/**
 * Which measures a portfolio manager reads first.
 *
 * Carnival's email ran to ten phone screens because every guided line got a
 * table - share counts, depreciation, fuel per metric ton - with the same
 * weight as EPS. The email now shows the measures that decide a quarter, in
 * this order, and puts the rest on the site: earnings per share; revenue and
 * its stand-ins (sales, net yields, comparable sales, organic growth);
 * profit - operating income or margin, EBITDA, net income, gross margin; free
 * cash flow. At most five. A company that guides none of these still gets its
 * three best-recorded measures, so no email is empty.
 */
const KEY_ORDER = [
  // "per common share" too: FactSet writes "Adjusted diluted earnings per
  // common share", and its FY2027 EPS guide was left out of the outlook.
  /\beps\b|earnings per (\w+ )?share/i,
  /revenue|sales|net yield|comparable|organic/i,
  /operating (income|profit|margin)|ebitda|\bebit\b|net income|gross margin|segment margin/i,
  /free cash flow|\bfcf\b/i,
];
const KEY_LIMIT = 5;
/* Measures in the outlook: the key measures plus any renamed or new one of
   the same kinds, so a little more room than the tables. */
const OUTLOOK_LIMIT = 6;
const BRIDGE = /\b(improvement|impact|headwinds?|tailwinds?|benefit|compared (to|with) (january|february|march|april|may|june|july|august|september|october|november|december|prior|previous|the prior|the previous|our prior|our previous|last)\b)/i;

function keyRank(g) {
  const label = (g.labels || []).join(" ") + " " + (g.metric || "");
  for (let i = 0; i < KEY_ORDER.length; i++) if (KEY_ORDER[i].test(label)) return i;
  return 99;
}

export function keyMeasures(metrics) {
  const scored = metrics.filter((g) => g.rows.some((p) => !p.notGuided && !p.unanswered));
  const ranked = scored
    .map((g) => ({ g, rank: keyRank(g) }))
    .sort((a, b) => a.rank - b.rank || b.g.total - a.g.total);
  // One table per measure among the key ones: where a measure is guided both
  // as an amount and as a growth rate, the amount leads and the rate goes to
  // the site with the rest.
  const seenBase = new Set();
  const single = ranked.filter((x) => {
    const base = String(x.g.key || "").split("|")[0];
    if (seenBase.has(base)) return false;
    seenBase.add(base);
    return true;
  });
  let keys = single.filter((x) => x.rank < 99).slice(0, KEY_LIMIT).map((x) => x.g);
  if (keys.length < 2) keys = single.slice(0, 3).map((x) => x.g);
  const others = metrics.filter((g) => !keys.includes(g));
  return { keys, others };
}

/* Where a result landed against its guide, as one word and a distance.
   A single figure gets "above" or "below" it - a direction, counted, never
   called a beat or a miss. */
function landing(p) {
  const g = p.guide || {};
  const a = num(p.actual);
  if (a === null) return null;
  if (p.position) {
    const edge = p.position === "above" ? num(g.high) : p.position === "below" ? num(g.low) : null;
    return { word: p.position, gap: edge === null ? null : Math.abs(a - edge) };
  }
  const v = num(g.value);
  if (v === null) return null;
  const d = tidy(a - v);
  return { word: d > 0 ? "above" : d < 0 ? "below" : "at", gap: Math.abs(d) };
}

function guideWords(p) {
  return boundText(p) || formatFigure(p.guide, p.unit);
}

/**
 * The three short blocks at the top of the email.
 *
 *   reported - what this release reported against the guide in force, for
 *              the key measures only;
 *   record   - per key measure, how often results have landed above, within
 *              or below the guide, and by how much;
 *   guiding  - what this release guided for the key measures.
 *
 * Rows marked with the caution (†) are left out of all three and counted as
 * left out: a wrong row must not become the headline or move a median.
 */
export function briefOf(view, keys) {
  const latest = view.latestRelease && view.latestRelease.accession;
  const reported = [];
  const record = [];
  const guiding = [];
  const keySet = new Set(keys.map((g) => g.key.split("|")[0]));

  for (const g of keys) {
    const real = g.rows.filter((p) => !p.notGuided && !p.unanswered);
    const clean = real.filter((p) => !p.flagged);

    for (const p of clean) {
      if (!latest || p.answeredBy !== latest) continue;
      const l = landing(p);
      if (!l) continue;
      reported.push(g.metric + ", " + periodLabel(p.period) + ": " + formatValue(p.actual, p.unit)
        + " vs " + guideWords(p) + " guided - " + l.word
        + (l.gap ? ", " + gapText(l.gap, p.unit) : "") + ".");
    }

    const counts = { above: 0, within: 0, below: 0, at: 0 };
    const aboveBy = [], belowBy = [];
    for (const p of clean) {
      const l = landing(p);
      if (!l) continue;
      counts[l.word] = (counts[l.word] || 0) + 1;
      const inUnit = (x) => x * unitScale(p.unit) / unitScale(g.unit);
      if (l.word === "above" && l.gap) aboveBy.push(inUnit(l.gap));
      if (l.word === "below" && l.gap) belowBy.push(inUnit(l.gap));
    }
    const n = counts.above + counts.within + counts.below + counts.at;
    if (n) {
      const bits = [];
      if (counts.above) bits.push("above in " + counts.above);
      if (counts.within) bits.push("within in " + counts.within);
      if (counts.at) bits.push("exactly on it in " + counts.at);
      if (counts.below) bits.push("below in " + counts.below);
      let line = g.metric + ": " + bits.join(", ") + " of " + n + (n === 1 ? " period" : " periods");
      if (aboveBy.length) line += "; median " + gapText(median(aboveBy), g.unit) + " above";
      if (belowBy.length) line += "; median " + gapText(median(belowBy), g.unit) + " below";
      const left = real.length - clean.length;
      if (left) line += " (" + left + " flagged " + (left === 1 ? "row" : "rows") + " left out)";
      record.push(line + ".");
    }
  }

  const moved = (view.revisions || []).filter((r) => latest && r.release === latest
    && ["raised", "cut", "unchanged", "new", "narrowed", "widened", "share split", "scope change"].includes(r.direction));
  let otherMoves = 0;
  const perKey = new Map();
  for (const r of moved) {
    const k = metricKey(r.label || r.metric);
    if (!keySet.has(k)) { otherMoves++; continue; }
    const list = perKey.get(k) || [];
    if (list.length < 3) list.push(r.summary);
    else otherMoves++;
    perKey.set(k, list);
  }
  /* One line per key measure: "EPS: Q4 2026 $0.20; FY2026 raised to $2.24
     (was $2.22)". Constant-currency twins of a figure already listed for the
     same period are dropped - one number per period is enough to read. */
  const phrase = (r) => {
    const when = periodLabel(r.period);
    const now = r.after ? formatFigure(r.after, r.unit) : "";
    const was = r.before ? formatFigure(r.before, r.unit) : "";
    if (r.direction === "raised" || r.direction === "cut") return when + " " + r.direction + " to " + now + " (was " + was + ")";
    if (r.direction === "unchanged") return when + " held at " + now;
    if (r.direction === "narrowed" || r.direction === "widened") return when + " " + r.direction + " to " + now;
    if (r.direction === "new") return when + " " + now;
    return when + ": " + r.direction;
  };
  for (const g of keys) {
    const base = g.key.split("|")[0];
    const rs = moved.filter((r) => metricKey(r.label || r.metric) === base);
    const plainPeriods = new Set(rs.filter((r) => !/constant currency/i.test(r.label || "")).map((r) => r.period));
    const kept = rs.filter((r) => !(/constant currency/i.test(r.label || "") && plainPeriods.has(r.period)));
    // The next quarter first, then the year.
    kept.sort((a, b) => (/FY/.test(a.period) - /FY/.test(b.period)) || (periodSortKey(a.period) - periodSortKey(b.period)));
    if (kept.length) guiding.push(g.metric + ": " + kept.map(phrase).join("; ") + ".");
  }

  return { reported, record, guiding, otherMoves };
}

/* "9 above, 2 within, 1 below" - counted, not characterised. */
function countLine(g) {
  const parts = [];
  if (g.above) parts.push(g.above + " above");
  if (g.within) parts.push(g.within + " within");
  if (g.below) parts.push(g.below + " below");
  if (g.noVerdict) parts.push(g.noVerdict + " against a single figure");

  const tail = [];
  if (g.unmatched) {
    tail.push(g.unmatched + (g.unmatched === 1 ? " guided period" : " guided periods")
      + " left out, no matching reported figure found");
  }
  if (g.acrossSplit) {
    tail.push(g.acrossSplit + (g.acrossSplit === 1 ? " guided period" : " guided periods")
      + " left out, guided before a share split and reported after it");
  }
  if (g.notGuided) tail.push(g.notGuided + " not guided");

  /* Nothing scored yet: say what there is, not "0 periods: ;". */
  if (!g.total) return tail.join(", ") || "guided, not yet reported";

  let line = g.total + (g.total === 1 ? " period" : " periods") + ": " + parts.join(", ");
  if (tail.length) line += "; " + tail.join(", ");
  return line;
}

const SPLIT_NOTE = "* An earlier guide for this period was stated before a share split or"
  + " another change to what is being counted, so it is not comparable and no path is"
  + " shown. Nothing here is restated.";

const FLAG_NOTE = "\u2020 The gap is large enough that it may not be a beat or a miss at"
  + " all - a restatement, a disposal or the wrong row will produce one the same size."
  + " The figure is the company's; the caution is ours.";

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
    (formatValue(p.actual, p.unit) || String(p.actual)) + (p.flagged ? "\u2020" : ""),
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
/* Names for the broad classes, for a row whose own label names nothing. */
const FAMILY_NAMES = {
  revenue: "Revenue",
  eps: "Earnings per share",
  operating_income: "Operating income",
  capex: "Capital expenditures",
  operating_cash_flow: "Operating cash flow",
  free_cash_flow: "Free cash flow",
  tax_rate: "Tax rate",
};

/**
 * The name to print for an annual row.
 *
 * Carnival's outlook table has a row labelled only "Total (a)" under its
 * capital expenditure lines, and the email printed a measure called "Total".
 * A label that is nothing but scaffolding - "Total", "Consolidated", a
 * footnote - leaves an empty measure key, and those rows take the name of
 * the class they were filed under instead. A class with no name of its own
 * ("other") keeps the company's label: better an odd word than an invented one.
 */
function annualName(a) {
  const written = String(a.metric || "");
  if (metricKey(written)) return written;
  return FAMILY_NAMES[a.family] || written;
}

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
    const k = metricKey(annualName(a));
    if (!labels.has(k)) labels.set(k, []);
    labels.get(k).push(annualName(a));
  }

  for (const a of annual || []) {
    const label = displayLabel(labels.get(metricKey(annualName(a))) || annualName(a));

    if (!a.comparable) {
      // The reason arrives as a short code rather than being read back out of
      // the sentence. The first version tested the prose for the word "unit"
      // and missed "Guided in other, tagged in USD millions" - which is a unit
      // mismatch that never says "unit". Parsing your own error messages is a
      // rule that breaks the moment someone rewords one.
      // An open year is not a failure to find a figure, so it does not read
      // like one. The guide is the whole point of the row.
      // Rows with no result to show are left out of the email: "not tagged,
      // n/a" told a reader nothing and took a line each. The site keeps them.
      continue;
    }

    if (a.computed) computed = true;
    if (a.basisCaveat) caveat = true;

    const marks = (a.computed ? "\u00a7" : "") + (a.basisCaveat ? "\u2021" : "");
    const guide = guideCell({ guide: a.guide, first: a.first, unit: a.unit, bound: a.bound });

    rows.push([
      label,
      periodLabel(a.period),
      guide.text,
      (formatValue(a.actual, a.unit) || String(a.actual)) + marks,
      /* No verdict across bases. Conagra guides an ADJUSTED tax rate of about
         23%; the tagged GAAP rate swung from 43% to -42% with impairments,
         and the email printed "65.4pp below". That is not a result against
         the guide, it is two different measures subtracted. */
      a.basisCaveat ? "not comparable" : outcomeCell(a),
    ]);
  }

  const notes = [];
  if (caveat) {
    notes.push("‡ The company guided an adjusted figure; the only tagged result is the GAAP"
      + " one. The two are different measures, so no verdict is given - the GAAP figure is"
      + " shown for reference only.");
  }
  if (computed) {
    notes.push("\u00a7 Capital expenditure over revenue, both as the company tagged them for"
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
  const wanted = new Set(["raised", "cut", "unchanged", "new", "narrowed", "widened", "scope change", "share split"]);
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


/**
 * The headline, saying how far back it counts.
 *
 * "16 matched pairs: 5 above, 8 within, 1 below" counts every pair on record,
 * back to 2023, while the tables show the last ten periods of each measure.
 * United's email announced "1 below" with no below row anywhere in sight.
 * "Since Q2 2023" makes the headline and the tables agree about what they
 * cover.
 */
/* "59 against a single figure" says nothing. Which side of it they landed
   on does - counted, excluding rows marked with the caution. */
/* "71 guided figures since Q3 2023: 53 above the guide, 5 within, 10 below."
   Ranges and single figures counted together - above is above - with rows
   marked with the caution left out of the count. */
function plainHeadline(pairs) {
  const c = { above: 0, within: 0, below: 0, at: 0 };
  let first = null;
  for (const p of pairs || []) {
    if (p.flagged) continue;
    const l = landing(p);
    if (!l) continue;
    c[l.word] = (c[l.word] || 0) + 1;
    if (p.period && (!first || periodSortKey(p.period) < periodSortKey(first))) first = p.period;
  }
  const n = c.above + c.within + c.below + c.at;
  if (!n) return null;
  const bits = [c.above + " above the guide"];
  if (c.within) bits.push(c.within + " within the range");
  if (c.at) bits.push(c.at + " on it");
  bits.push(c.below + " below");
  return n + " guided " + (n === 1 ? "figure" : "figures") + (first ? " since " + periodLabel(first) : "")
    + ": " + bits.join(", ") + ".";
}

function singlesLine(headline, pairs) {
  let above = 0, below = 0;
  for (const p of pairs || []) {
    if (p.position || p.flagged) continue;
    const l = landing(p);
    if (!l) continue;
    if (l.word === "above") above++;
    else if (l.word === "below") below++;
  }
  if (!above && !below) return headline;
  return String(headline).replace(/against a single figure rather than a range/,
    "against a single figure (" + above + " above it, " + below + " below)");
}

function headlineSince(headline, pairs) {
  const h = String(headline || "");
  const periods = (pairs || []).map((p) => p.period).filter(Boolean);
  if (!periods.length || !/ matched pairs?:/.test(h)) return h;
  const first = periods.reduce((a, b) => (periodSortKey(a) <= periodSortKey(b) ? a : b));
  return h.replace(/ matched (pairs?):/, " matched $1 since " + periodLabel(first) + ":");
}

/* ------------------------------------------------------------------ *
 * The three sections at the top (stage two, 30 Sep 2026)
 * ------------------------------------------------------------------ */

/* The symbols. One colour, the house green, whatever the direction: above is
   not good and below is not bad - a cost measure above its guide is the
   opposite of a beat, and colour would decide that for the reader. The
   variation selector keeps phones from drawing them as coloured emoji. */
const SYM = { above: "\u25B2\uFE0E", within: "\u25CF\uFE0E", at: "\u25CF\uFE0E", below: "\u25BC\uFE0E" };
const SHADE = "#f0ebdf";

/* "▲ +$0.08", "● within", "▼ −$0.05": where it landed and by how much, from
   the end of the range it passed or from the single figure guided. */
function resultCell(p) {
  const l = landing(p);
  if (!l) return "";
  if (l.word === "within") return SYM.within + " within";
  if (l.word === "at") return SYM.at + " on it";
  const gap = l.gap ? formatGap(l.word === "above" ? l.gap : -l.gap, p.unit, true) : "";
  return SYM[l.word] + (gap ? " " + gap : " " + l.word);
}

/* "raised from $2.22", "held", "new": what happened to the guide for this
   period in this release. */
function changeWords(r) {
  const was = r.before ? formatFigure(r.before, r.unit) : "";
  switch (r.direction) {
    case "raised": return "raised from " + was;
    case "cut": return "cut from " + was;
    case "unchanged": return "held";
    case "narrowed": return "narrowed from " + was;
    case "widened": return "widened from " + was;
    case "new": return "new";
    default: return r.direction;
  }
}

/**
 * Everything the three sections print, worked out once for both the HTML and
 * the plain text.
 *
 *   quarter - the key measures this release reported, against the guide in
 *             force, and a one-line count of how they landed;
 *   outlook - what this release guided for the key measures, and how each
 *             guide moved;
 *   record  - per key measure, the last ten results as symbols (oldest
 *             first), the count, and the typical gap.
 *
 * Rows carrying the caution (†) stay out of all three and are counted as left
 * out, as before: a doubtful row must not become the headline or move a median.
 */
export function sectionsOf(view, keys) {
  const latest = view.latestRelease && view.latestRelease.accession;

  const quarter = [];
  let quarterFlagged = 0;
  for (const g of keys) {
    for (const p of g.rows) {
      if (p.notGuided || p.unanswered) continue;
      if (!latest || p.answeredBy !== latest) continue;
      if (!landing(p)) continue;
      /* A flagged figure is SHOWN, marked, and left out of the count. Micron's
         June 2026 quarter came in far above every guide it gave, all three
         key figures carried the caution, and leaving them out made the box
         say nothing had been guided - which was false. */
      if (p.flagged) quarterFlagged++;
      quarter.push({
        p,
        flagged: Boolean(p.flagged),
        measure: g.metric,
        period: periodLabel(p.period),
        sort: periodSortKey(p.period),
        guided: guideWords(p),
        reported: (formatValue(p.actual, p.unit) || String(p.actual)) + (p.flagged ? "\u2020" : ""),
        result: resultCell(p),
        word: landing(p).word,
      });
    }
  }

  let quarterLine = null;
  const counted = quarter.filter((q) => !q.flagged);
  if (quarter.length) {
    const c = { above: 0, within: 0, at: 0, below: 0 };
    for (const q of counted) c[q.word] += 1;
    const measures = new Set(quarter.map((q) => q.measure)).size;
    const noun = (n) => "key " + (measures === quarter.length
      ? (n === 1 ? "measure" : "measures")
      : (n === 1 ? "figure" : "figures"));
    const n = counted.length;
    const only = Object.keys(c).filter((k) => c[k]);
    if (!n) {
      quarterLine = quarter.length === 1
        ? "The one key figure carries the \u2020 caution, so it is not counted."
        : "All " + quarter.length + " key figures carry the \u2020 caution, so none is counted.";
    } else if (only.length === 1) {
      const w = only[0];
      const phrase = w === "above" ? "above the company's own guide"
        : w === "below" ? "below the company's own guide"
        : w === "within" ? "within the company's own range"
        : "exactly on the company's own guide";
      const who = n === 1 ? "The one " + noun(1) : n === 2 ? "Both " + noun(2) : "All " + n + " " + noun(n);
      quarterLine = who + " came in " + phrase + ".";
    } else {
      const bits = [];
      if (c.above) bits.push(c.above + " above the company's own guide");
      if (c.within) bits.push(c.within + " within the range");
      if (c.at) bits.push(c.at + " exactly on it");
      if (c.below) bits.push(c.below + " below");
      quarterLine = "Of " + n + " " + noun(n) + ": " + bits.join(", ") + ".";
    }
    if (quarterFlagged && n) {
      quarterLine += " " + quarterFlagged + " more marked \u2020 and not counted.";
    }
  }

  // The outlook: the same revisions the brief used, one row per guide.
  const moved = (view.revisions || []).filter((r) => latest && r.release === latest
    && ["raised", "cut", "unchanged", "new", "narrowed", "widened", "share split", "scope change"].includes(r.direction));
  /* WHICH GUIDES GO IN THE OUTLOOK: the key measures, judged on the new
   * guide's OWN label as well as on the tables above.
   *
   * FactSet's September 2026 release guided FY2027 revenue and both EPS
   * figures, and the outlook showed only operating margin: the new guides
   * were labelled "Revenues" and "Diluted earnings per share per common
   * share", the record's tables "GAAP revenues" and "GAAP diluted EPS", and a
   * guide that did not match a table's name was not shown. A company renaming
   * a line is not a reason to hide what it just guided. */
  const keyBases = new Set(keys.map((g) => String(g.key).split("|")[0]));
  const nameOf = new Map(keys.map((g) => [String(g.key).split("|")[0], g.metric]));
  const byBase = new Map();
  for (const r of moved) {
    const base = metricKey(r.label || r.metric);
    // Ordered by kind (EPS, revenue, profit, cash flow) like the tables,
    // then by the tables' own order within a kind.
    const table = keys.findIndex((g) => String(g.key).split("|")[0] === base);
    /* A bridge, not a measure. Carnival guided "operational improvement in
       adjusted net income compared to June" - a $150m step within its net
       income guide - and it reached the outlook as though it were a sixth
       key measure. A line describing a change in something, or an effect on
       it, is left to the site; the measures themselves are listed. Organic
       growth and "net sales change" are measures and are not caught: the test
       is for improvement, impact, headwind, tailwind, benefit, or a
       comparison with an earlier guide. */
    if (table < 0 && BRIDGE.test(String(r.label || r.metric || ""))) continue;
    const kind = table >= 0 ? keyRank(keys[table]) : keyRank({ labels: [r.label || r.metric || ""] });
    const rank = kind === 99 && table < 0 ? 99 : kind * 100 + (table >= 0 ? table : 50);
    if (!byBase.has(base)) byBase.set(base, { base, rank, rows: [] });
    byBase.get(base).rows.push(r);
  }
  const groupsOut = Array.from(byBase.values()).filter((x) => x.rank !== 99).sort((a, b) => a.rank - b.rank);
  const shownGroups = groupsOut.slice(0, OUTLOOK_LIMIT);
  let otherMoves = moved.length - shownGroups.reduce((n, x) => n + x.rows.length, 0);

  const outlook = [];
  for (const x of shownGroups) {
    const rs = x.rows;
    const measure = nameOf.get(x.base) || displayLabel(rs.map((r) => r.label || r.metric));
    // Constant-currency twins of a figure already listed for the same period
    // are dropped - one number per period is enough to read.
    const plainPeriods = new Set(rs.filter((r) => !/constant currency/i.test(r.label || "")).map((r) => r.period));
    const kept = rs.filter((r) => !(/constant currency/i.test(r.label || "") && plainPeriods.has(r.period)));
    // The next quarter first, then the year.
    kept.sort((a, b) => (/FY/.test(a.period) - /FY/.test(b.period)) || (periodSortKey(a.period) - periodSortKey(b.period)));
    kept.slice(0, 3).forEach((r, i) => {
      outlook.push({
        r,
        measure,
        first: i === 0,
        period: periodLabel(r.period),
        guide: r.after ? formatFigure(r.after, r.unit) : "",
        change: changeWords(r),
      });
    });
    otherMoves += Math.max(0, kept.length - 3);
  }

  // The record, per key measure.
  const record = [];
  for (const g of keys) {
    const real = g.rows.filter((p) => !p.notGuided && !p.unanswered);
    const clean = real.filter((p) => !p.flagged && landing(p));
    if (!clean.length) continue;
    const ordered = clean.slice().sort((a, b) => periodSortKey(a.period) - periodSortKey(b.period)).slice(-10);

    const counts = { above: 0, within: 0, at: 0, below: 0 };
    const aboveBy = [], belowBy = [];
    for (const p of ordered) {
      const l = landing(p);
      counts[l.word] += 1;
      const inUnit = (x) => x * unitScale(p.unit) / unitScale(g.unit);
      if (l.word === "above" && l.gap) aboveBy.push(inUnit(l.gap));
      if (l.word === "below" && l.gap) belowBy.push(inUnit(l.gap));
    }
    const n = ordered.length;
    /* "6/7 above (typically $0.17)": the count, and beside it the typical
       distance - a median, so "typically" only when there is more than one
       gap to take it from. */
    const gapOf = (xs) => !xs.length ? ""
      : " (" + (xs.length > 1 ? "typically " : "") + gapText(xs.length > 1 ? median(xs) : xs[0], g.unit) + ")";
    const bits = [];
    if (counts.above) bits.push(counts.above + "/" + n + " above" + gapOf(aboveBy));
    if (counts.within) bits.push(counts.within + "/" + n + " within");
    if (counts.at) bits.push(counts.at + "/" + n + " on it");
    if (counts.below) bits.push(counts.below + "/" + n + " below" + gapOf(belowBy));
    const left = real.length - clean.length;

    record.push({
      measure: g.metric,
      symbols: ordered.map((p) => SYM[landing(p).word]).join(" "),
      span: ordered.length > 1
        ? periodLabel(ordered[0].period) + " \u2192 " + periodLabel(ordered[ordered.length - 1].period)
        : periodLabel(ordered[0].period),
      line: bits.join(", ")
        + (left ? " \u00b7 " + left + " flagged " + (left === 1 ? "row" : "rows") + " left out" : ""),
    });
  }

  return { quarter, quarterLine, outlook, record, otherMoves };
}

/* The plain-text version has no emoji problem to guard against, and the
   invisible selector would throw the column padding off by one. */
function bare(x) {
  return String(x || "").replace(/\uFE0E/g, "");
}


/* ------------------------------------------------------------------ *
 * The redesign (1 Oct 2026): hero, result cards, outlook, beat strips
 * ------------------------------------------------------------------ */

/* The hero's colour states the outcome, decided here from the key measures
   alone. Key measures are EPS, revenue, profit, cash flow and margins - for
   all of them, above the guide is the better side. Costs are never key
   measures, so the colour can never praise a cost overrun. */
const HERO = {
  beat: { bg: "#1f4435", fg: "#ffffff", sub: "#cfe0d6" },
  mixed: { bg: "#3b4a57", fg: "#ffffff", sub: "#cdd5dc" },
  miss: { bg: "#7a3b22", fg: "#ffffff", sub: "#efd2c4" },
  none: { bg: "#e6eaee", fg: "#17202a", sub: "#5f6b76" },
};
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF_HEAD = "Georgia,'Times New Roman',serif";
const RANGE_BAND = "#cfe0d6";
const LIGHT = "#a9c6b6";
const PAGE = "#eef1f3";
const LINE = "#e3e7ea";
const SOFT = "#5f6b76";

/* The figures of a guide, as numbers: its ends, or the single figure twice. */
function guideEnds(p) {
  const g = p.guide || {};
  const lo = num(g.low) !== null ? num(g.low) : num(g.value);
  const hi = num(g.high) !== null ? num(g.high) : num(g.value);
  if (lo === null && hi === null) return null;
  return { lo: lo === null ? hi : lo, hi: hi === null ? lo : hi };
}

function isPoints(unit) {
  return unit === "percent";
}

/* "+7.8% on the midpoint" for money and per-share; nothing for a percentage,
   whose gap is already in points. */
function vsMidpoint(p) {
  const e = guideEnds(p);
  const a = num(p.actual);
  if (!e || a === null || isPoints(p.unit)) return "";
  const mid = (e.lo + e.hi) / 2;
  if (!mid || mid < 0) return "";
  const pct = Math.round((a / mid - 1) * 1000) / 10;
  return (pct > 0 ? "+" : pct < 0 ? "\u2212" : "") + Math.abs(pct) + "% on the midpoint";
}

/* "$1.42 above the top", "within the range", "1.2 points below the bottom". */
function gapWords(p) {
  const l = landing(p);
  if (!l) return "";
  if (l.word === "within") return "within the range";
  if (l.word === "at") return "exactly on the guide";
  const ranged = num((p.guide || {}).low) !== null && num((p.guide || {}).high) !== null;
  const where = ranged ? (l.word === "above" ? " above the top" : " below the bottom") : " " + l.word;
  if (!l.gap) return l.word;
  if (isPoints(p.unit)) return Number(tidy(l.gap)).toString() + (l.gap === 1 ? " point" : " points") + where;
  return formatGap(l.gap, p.unit, false) + where;
}

/* The range bar: the guided band shaded, the result a dark mark. Built from
   table cells of set widths - the one way to draw this that Gmail, Apple
   Mail and Outlook all keep. */
function rangeBar(p) {
  const e = guideEnds(p);
  const a = num(p.actual);
  if (!e || a === null) return "";
  const lo = Math.min(e.lo, e.hi), hi = Math.max(e.lo, e.hi);
  const sLo = Math.min(lo, a), sHi = Math.max(hi, a);
  const pad = (sHi - sLo) * 0.3 || Math.max(Math.abs(hi) * 0.02, 0.5);
  const L = sLo - pad, W = (sHi + pad) - L;
  const pct = (x) => (x / W) * 100;
  let cells;
  if (a > hi) cells = [[pct(lo - L), null], [Math.max(pct(hi - lo), 1.2), RANGE_BAND], [Math.max(pct(a - hi) - 1.6, 0.5), null], [1.6, GREEN]];
  else if (a < lo) cells = [[pct(a - L), null], [1.6, GREEN], [Math.max(pct(lo - a) - 1.6, 0.5), null], [Math.max(pct(hi - lo), 1.2), RANGE_BAND]];
  else cells = [[pct(lo - L), null], [Math.max(pct(a - lo), 0.6), RANGE_BAND], [1.6, GREEN], [Math.max(pct(hi - a), 0.6), RANGE_BAND]];
  const tds = cells.map(([w, c]) => '<td width="' + w.toFixed(1) + '%" style="height:8px;font-size:0;line-height:0;'
    + (c ? 'background:' + c + ';' : '') + '">&nbsp;</td>').join("")
    + '<td style="font-size:0;line-height:0;">&nbsp;</td>';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"'
    + ' style="border-collapse:collapse;margin-top:10px;"><tr>' + tds + '</tr></table>';
}

/* The beat strip: one square per period, oldest left. */
function beatStrip(seq) {
  const st = {
    A: "background:" + GREEN + ";",
    W: "background:" + LIGHT + ";",
    B: "background:#ffffff;border:2px solid " + GREEN + ";",
    F: "background:#ffffff;border:2px dashed " + SOFT + ";",
  };
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + seq.map((k) => '<td style="padding:0 4px 0 0;"><div style="width:16px;height:16px;' + st[k]
      + 'border-radius:3px;font-size:0;line-height:0;">&nbsp;</div></td>').join("")
    + '</tr></table>';
}

/* "2026-09-30" as "30 Sep 2026". */
function longDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || "");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return Number(m[3]) + " " + months[Number(m[2]) - 1] + " " + m[1];
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many);
}

function periodWord(rows) {
  const fy = rows.filter((p) => /FY$/.test(String(p.period))).length;
  if (fy === rows.length) return ["year", "years"];
  if (fy === 0) return ["quarter", "quarters"];
  return ["period", "periods"];
}

/**
 * Everything the redesigned top of the email prints, worked out once.
 */
export function designOf(view, keys, sec) {
  const latest = view.latestRelease && view.latestRelease.accession;
  const counted = sec.quarter.filter((q) => !q.flagged);
  const c = { above: 0, within: 0, at: 0, below: 0 };
  for (const q of counted) c[q.word] += 1;

  let kind = "none";
  if (counted.length) {
    if (c.above && !c.below) kind = "beat";
    else if (c.below && !c.above) kind = "miss";
    else kind = "mixed";
  }

  // The record of each key measure: the last ten periods, oldest first.
  const record = [];
  for (const g of keys) {
    const real = g.rows.filter((p) => !p.notGuided && !p.unanswered && landing(p));
    if (!real.length) continue;
    const ordered = real.slice().sort((a, b) => periodSortKey(a.period) - periodSortKey(b.period)).slice(-10);
    const clean = ordered.filter((p) => !p.flagged);
    const n = { above: 0, within: 0, below: 0 };
    const over = [];
    for (const p of clean) {
      const w = landing(p).word;
      n[w === "at" ? "within" : w] += 1;
      const e = guideEnds(p);
      const a = num(p.actual);
      if (e && a !== null) {
        const mid = (e.lo + e.hi) / 2;
        if (isPoints(p.unit)) over.push(a - mid);
        else if (mid > 0) over.push((a / mid - 1) * 100);
      }
    }
    const [one, many] = periodWord(ordered);
    const total = clean.length;
    const parts = [];
    const lead = n.above >= n.below
      ? ["above", n.above] : ["below", n.below];
    const order = lead[0] === "above" ? ["above", "within", "below"] : ["below", "within", "above"];
    for (const w of order) {
      if (!n[w]) continue;
      parts.push(parts.length === 0
        ? (total === 1
          ? (w.charAt(0).toUpperCase() + w.slice(1)) + " the guide in the one " + one + " scored so far"
          : (w.charAt(0).toUpperCase() + w.slice(1)) + " in " + n[w] + " of the last " + plural(total, one, many))
        : w + " in " + n[w]);
    }
    if (!n.below && n.above) parts.push("never below");
    const left = ordered.length - clean.length;
    let typical = "";
    if (over.length >= 2) {
      const m = median(over);
      const size = Math.round(Math.abs(m) * 10) / 10;
      typical = size === 0 ? "Typically lands on the midpoint."
        : "Typically " + (isPoints(g.unit) ? size + (size === 1 ? " point " : " points ") : size + "% ")
          + (m > 0 ? "over" : "under") + " the midpoint.";
    }
    if (left) typical += (typical ? " " : "") + plural(left, "period", "periods") + " set aside.";
    record.push({
      measure: g.metric,
      seq: ordered.map((p) => p.flagged ? "F" : ({ above: "A", within: "W", at: "W", below: "B" })[landing(p).word]),
      span: ordered.length > 1 ? periodLabel(ordered[0].period) + " to " + periodLabel(ordered[ordered.length - 1].period) : periodLabel(ordered[0].period),
      line: parts.join(", ") + ".",
      typical,
      below: n.below,
      total,
      unitWord: [one, many],
    });
  }

  /* The outlook, with the new guide set beside what was just reported - only
     the SAME measure on the SAME basis. FactSet guides GAAP EPS ($17.00 to
     $17.50) and adjusted EPS ($19.25 to $19.65) for fiscal 2027; matched on
     the measure alone, the GAAP guide was named "Adjusted diluted EPS" and
     printed "down 4.2% on the $18.01 just reported" - an adjusted result. */
  const basisOfLabel = (label) => /\b(adjusted|non-?gaap|core|comparable|organic|underlying|excluding)\b/i.test(String(label || ""))
    ? "non_gaap" : "gaap";
  // The measure without its basis word; the basis is matched separately.
  const plainKey = (x) => metricKey(x).replace(/\bgaap\b/g, " ").replace(/\s+/g, " ").trim();
  const reportedNow = [];
  for (const q of sec.quarter) if (!q.flagged && q.p) reportedNow.push(q.p);
  const outlook = sec.outlook.map((o0) => {
    const r = o0.r;
    const rBasis = basisOfLabel(r && r.label);
    const group = keys.find((g) => g.metric === o0.measure);
    const groupBasis = basisOfLabel(group ? group.metric : o0.measure);
    const o = groupBasis === rBasis ? o0 : { ...o0, measure: displayLabel([String((r && r.label) || o0.measure)]) };
    // Like with like: a year's guide beside the year just reported, a
    // quarter's beside the quarter.
    const kindOf = (per) => /FY$/.test(String(per || "")) ? "FY" : "Q";
    let just = reportedNow.find((p) => kindOf(p.period) === kindOf(r && r.period)
      && plainKey(p.metric) === plainKey((r && r.label) || o.measure)
      && basisOfLabel(p.metric) === rBasis);
    /* A year's guide given mid-year has nothing "just reported" beside it.
       McCormick's October release guides fiscal 2026 EPS at $3.05 to $3.13;
       the year to compare it with, fiscal 2025 ($3.00), was reported in
       January. The last full year in the record is used, and named. */
    let sinceWhen = "just reported";
    // Levels and margins only: a growth rate set beside last year's growth
    // rate says nothing a reader can use.
    // A percentage is compared only when it is a margin or a rate of
    // something (Carnival's "net yields" and Nike's constant-currency
    // growth are changes, not levels). Never across a share split.
    const label0 = String((r && r.label) || o.measure);
    const isRate = r && r.unit === "percent" && !/margin|as a percent|percent of|tax rate/i.test(label0);
    const acrossSplit = r && /split/i.test(String(r.direction || ""));
    if (!just && r && !isRate && !acrossSplit && /^(\d{4})FY$/.test(String(r.period || ""))) {
      const prev = (Number(String(r.period).slice(0, 4)) - 1) + "FY";
      just = keys.flatMap((g) => g.rows).find((p) => !p.notGuided && !p.unanswered && p.period === prev
        && typeof p.actual === "number" && !p.flagged
        && plainKey(p.metric) === plainKey((r && r.label) || o.measure)
        && basisOfLabel(p.metric) === rBasis);
      // A year-on-year jump past half or double is more likely a different
      // measure than a guide (General Electric's $1.6bn-1.7bn "operating
      // profit" set beside its $9.05bn company total). Left without a
      // comparison rather than given a wrong one.
      if (just) {
        const lo = num(r.after && (r.after.low ?? r.after.value)), hi = num(r.after && (r.after.high ?? r.after.value));
        const ratio = lo !== null && hi !== null && just.actual ? ((lo + hi) / 2) * unitScale(r.unit) / unitScale(just.unit) / just.actual : null;
        if (ratio === null || ratio < 0.5 || ratio > 2) just = null;
        else sinceWhen = "reported for " + periodLabel(prev);
      }
    }
    let compare = "";
    if (r && r.after && just && unitClass(r.unit) === unitClass(just.unit)) {
      const lo = num(r.after.low) !== null ? num(r.after.low) : num(r.after.value);
      const hi = num(r.after.high) !== null ? num(r.after.high) : num(r.after.value);
      const a = num(just.actual);
      if (lo !== null && hi !== null && a !== null) {
        const mid = ((lo + hi) / 2) * unitScale(r.unit) / unitScale(just.unit);
        const midText = formatValue(Number(((lo + hi) / 2).toFixed(4)), r.unit);
        const reported = formatValue(a, just.unit);
        if (isPoints(r.unit)) {
          const d = Math.round((mid - a) * 100) / 100;
          compare = (lo !== hi ? "Midpoint " + midText + ", " : "")
            + (d === 0 ? "level with" : Math.abs(d) + (Math.abs(d) === 1 ? " point " : " points ") + (d > 0 ? "above" : "below"))
            + " the " + reported + " " + sinceWhen;
        } else if (a > 0) {
          const pct = Math.round((mid / a - 1) * 1000) / 10;
          compare = (lo !== hi ? "Midpoint " + midText + ", " : "")
            + (pct === 0 ? "level with" : (pct > 0 ? "up " : "down ") + Math.abs(pct) + "% on")
            + " the " + reported + " " + sinceWhen;
        }
      }
    }
    const change = o.change === "new" ? "" : o.change.charAt(0).toUpperCase() + o.change.slice(1);
    return { ...o, line: [change, compare].filter(Boolean).join(". ") };
  });

  // The hero's one line - fixed templates, never free text.
  const names = (w) => counted.filter((q) => q.word === w).map((q) => q.measure);
  const join = (xs) => xs.length <= 1 ? (xs[0] || "") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
  const bits = [];
  if (kind === "beat" || kind === "miss") {
    // A streak: the latest periods in which no key measure was below.
    const byPeriod = new Map();
    for (const g of keys) for (const p of g.rows) {
      if (p.notGuided || p.unanswered || p.flagged || !landing(p)) continue;
      const k = periodSortKey(p.period);
      if (!byPeriod.has(k)) byPeriod.set(k, []);
      byPeriod.get(k).push(landing(p).word);
    }
    const ks = Array.from(byPeriod.keys()).sort((a, b) => b - a);
    let streak = 0;
    for (const k of ks) { if (byPeriod.get(k).includes("below")) break; streak++; }
    if (kind === "beat" && streak >= 3) {
      const allRows = keys.flatMap((g) => g.rows.filter((p) => !p.notGuided && !p.unanswered));
      const [one, many] = periodWord(allRows);
      bits.push("No miss on any key measure in " + plural(streak, one, many) + ".");
    }
    if (kind === "miss") bits.push(join(names("below")) + (names("below").length === 1 ? " came in" : " came in") + " below the guide.");
  } else if (kind === "mixed") {
    const up = names("above"), down = names("below");
    if (up.length) bits.push(join(up) + (up.length === 1 ? " beat." : " beat."));
    if (down.length) bits.push(join(down) + " missed.");
  }
  // A missed measure that misses often: say so.
  for (const r of record) {
    if (names("below").includes(r.measure) && r.below >= 2 && r.total >= 3) {
      bits.push(r.measure + " has come in below its guide in " + r.below + " of the last " + plural(r.total, r.unitWord[0], r.unitWord[1]) + ".");
      break;
    }
  }
  // The biggest new guide against what was just reported.
  // A full-year guide makes the better headline than the next quarter's:
  // quarters are seasonal, and "guided down 9%" for a seasonally smaller
  // first quarter reads as bad news when it is not.
  const moves = outlook.filter((o) => /(up|down) [\d.]+% on/.test(o.line));
  const firstMove = moves.find((o) => /^FY/.test(o.period)) || moves[0];
  if (firstMove && bits.length < 3) {
    const m = firstMove.line.match(/(up|down) ([\d.]+)%/);
    bits.push(firstMove.measure + " is guided " + m[1] + " " + m[2] + "% for " + firstMove.period + ".");
  }

  let big, side;
  if (kind === "none") {
    big = "0";
    side = "key measures to score<br>in this release";
  } else {
    big = c.above + "/" + counted.length;
    const rest = [];
    if (c.within + c.at) rest.push(c.within + c.at + " within");
    if (c.below) rest.push(c.below + " below");
    side = "key measures above the<br>company's own guide" + (rest.length ? "<br>" + rest.join(", ") : "");
  }
  if (kind === "none" && !bits.length) {
    bits.push(sec.outlook.length
      ? "Nothing this release reported had a guide in force. What it guides now is below."
      : "This release reported nothing against a guide, and guided no key measure.");
  }
  const flaggedNote = sec.quarter.length - counted.length;
  if (flaggedNote) bits.push(plural(flaggedNote, "figure", "figures") + " marked \u2020 not counted.");

  return { kind, big, side, line: bits.join(" "), record, outlook };
}

/* "Micron Technology Inc" as "Micron Technology": the legal suffix adds
   nothing to a subject line. */
function shortName(name) {
  let n = String(name || "").trim();
  // Repeatedly: "Carnival Corp Ltd", "United Airlines Holdings Inc".
  for (let i = 0; i < 3; i++) {
    n = n.replace(/,?\s+(&\s*co|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group)\.?$/i, "").trim();
  }
  return n || String(name || "");
}

/**
 * The subject line: the outcome first, in fixed words.
 *   beat  - "Micron Technology beat its own guide on 3 of 3 key measures"
 *   mixed - "FactSet Research Systems: 2 of 5 key measures above its own guide, 2 below"
 *   miss  - "X came in below its own guide on 2 of 3 key measures"
 *   none  - "X reported: new guidance, nothing to score yet" / "X reported: nothing to score"
 */
export function subjectOf(view, keys, sec, company) {
  const d = designOf(view, keys, sec);
  const name = shortName(company);
  const counted = sec.quarter.filter((q) => !q.flagged);
  const n = counted.length;
  const above = counted.filter((q) => q.word === "above").length;
  const below = counted.filter((q) => q.word === "below").length;
  const of = (k) => k + " of " + n + " key " + (n === 1 ? "measure" : "measures");
  if (d.kind === "beat") return name + " beat its own guide on " + of(above);
  if (d.kind === "miss") return name + " came in below its own guide on " + of(below);
  if (d.kind === "mixed") {
    if (!above && !below) return name + (n === 1 ? ": its one key measure came in within its own guided range"
      : ": all " + n + " key measures within its own guided range");
    return name + ": " + of(above) + " above its own guide, " + below + " below";
  }
  return name + (d.outlook.length ? " reported: new guidance, nothing to score yet" : " reported: nothing to score against guidance");
}

export function renderEmail(view, options) {
  const opts = options || {};
  const company = displayName(view.company || view.ticker);
  const lead = plainHeadline(view.pairs) || singlesLine(headlineSince(view.headline, view.pairs), view.pairs);
  const { metrics: allMetrics, belowBar } = byMetric(view.pairs || [], view.unanswered || [], 99);
  const { keys: metrics, others } = keyMeasures(allMetrics);
  const sec = sectionsOf(view, metrics);
  const annual = annualRows(view.annual);
  const alsoRows = belowBarRows(belowBar, view.annual);
  const anyNote = metrics.some((g) => g.hasNote);
  const anyFlag = metrics.some((g) => g.hasFlag);
  const site = opts.siteUrl || "https://guidance.zahoorbhat.com";
  const moreLine = others.length || sec.otherMoves
    ? (others.length ? others.length + " more guided " + (others.length === 1 ? "measure" : "measures") : "")
      + (others.length && sec.otherMoves ? " and " : "")
      + (sec.otherMoves ? sec.otherMoves + " more " + (sec.otherMoves === 1 ? "guide" : "guides") + " in this release" : "")
      + " - on the site: " + site
    : "";

  // The subject carries the verdict, from the same counts as the hero.
  const subject = subjectOf(view, metrics, sec, company);

  /* ---------------- plain text ---------------- */

  const t = [];
  const d = designOf(view, metrics, sec);
  const heroText = d.side.replace(/<br>/g, " ");
  t.push(company + " (" + view.ticker + ")");
  t.push("");
  t.push(d.big + " " + heroText);
  if (d.line) t.push(d.line);
  t.push("");
  if (sec.quarter.length) {
    t.push("THIS RELEASE AGAINST THE GUIDE");
    for (const q of sec.quarter) {
      t.push("- " + q.measure + ", " + q.period + ": " + q.reported + " (guided " + q.guided + ") - "
        + gapWords(q.p) + (vsMidpoint(q.p) ? ", " + vsMidpoint(q.p) : ""));
    }
    t.push("");
  }
  if (d.outlook.length) {
    t.push("WHAT THEY GUIDE NOW");
    for (const o of d.outlook) t.push("- " + o.measure + ", " + o.period + ": " + o.guide + (o.line ? " - " + o.line : ""));
    t.push("");
  }
  if (d.record.length) {
    t.push("HOW RELIABLE THEIR GUIDE HAS BEEN");
    t.push(lead);
    for (const r of d.record) {
      t.push("- " + r.measure + " (" + r.span + "): " + r.line + (r.typical ? " " + r.typical : ""));
    }
    t.push("");
  }
  t.push("Counted from the company's own releases. Nothing here is a forecast.");
  t.push("");
  t.push("FULL HISTORY");
  t.push("");

  for (const g of metrics) {
    t.push(g.metric);
    for (const line of textTable(HEADINGS, g.rows.map(rowCells))) t.push("   " + line);
    t.push("");
  }

  if (anyNote) {
    t.push(SPLIT_NOTE);
    t.push("");
  }

  if (anyFlag) {
    t.push(FLAG_NOTE);
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

  if (moreLine) {
    t.push(moreLine.charAt(0).toUpperCase() + moreLine.slice(1));
    t.push("");
  }

  t.push("Thanks,");
  t.push("Zahoor · Guidance Scorecard · hello@zahoorbhat.com");
  t.push("");
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
  const H = HERO[d.kind];
  const heading = (text) => '<div style="font-family:' + SERIF_HEAD + ';font-size:19px;color:' + INK + ';margin:26px 0 6px;">' + esc(text) + '</div>';
  const quietLine = (text) => '<div style="font-size:12px;line-height:1.45;color:' + SOFT + ';padding-top:6px;">' + esc(text) + '</div>';
  h.push('<div style="margin:0;padding:20px 0;background:' + PAGE + ';">');
  h.push('<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:' + SANS + ';color:' + INK + ';font-size:15px;line-height:1.45;">');

  // The hero: the outcome, in its colour.
  h.push('<div style="background:' + H.bg + ';color:' + H.fg + ';padding:24px 22px 22px;">');
  h.push('<div style="font-size:13px;color:' + H.sub + ';">' + esc(company + " (" + view.ticker + ")")
    + (view.latestRelease && view.latestRelease.filed ? " \u00b7 filed " + esc(longDate(view.latestRelease.filed)) : "") + '</div>');
  h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>'
    + '<td style="font-size:50px;font-weight:700;line-height:1;letter-spacing:-1px;padding-right:16px;white-space:nowrap;color:' + H.fg + ';">' + esc(d.big) + '</td>'
    + '<td style="font-size:15px;line-height:1.35;color:' + H.fg + ';">' + d.side + '</td></tr></table>');
  if (d.line) h.push('<div style="font-size:15px;line-height:1.45;margin-top:14px;color:' + H.fg + ';">' + esc(d.line) + '</div>');
  h.push('</div>');

  h.push('<div style="padding:0 22px;">');

  // This release against the guide: one row per figure, with its bar.
  if (sec.quarter.length) {
    h.push(heading("This release against the guide"));
    for (const q of sec.quarter) {
      const mid = vsMidpoint(q.p);
      h.push('<div style="padding:14px 0;border-top:1px solid ' + LINE + ';">'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        + '<td style="vertical-align:top;font-size:15px;">' + esc(q.measure)
        + '<div style="font-size:13px;color:' + SOFT + ';margin-top:3px;">' + esc(q.period + " \u00b7 guided " + q.guided) + '</div></td>'
        + '<td align="right" style="vertical-align:top;white-space:nowrap;padding-left:10px;">'
        + '<div style="font-size:23px;font-weight:600;letter-spacing:-0.3px;">' + esc(q.reported) + '</div>'
        + '<div style="font-size:13px;color:' + GREEN + ';margin-top:2px;">' + esc(gapWords(q.p)) + '</div></td></tr></table>'
        + rangeBar(q.p)
        + (mid ? '<div style="font-size:12px;color:' + SOFT + ';margin-top:6px;">' + esc(mid) + '</div>' : '')
        + '</div>');
    }
    h.push(quietLine("Shaded: the range guided. Dark mark: the result." + (sec.quarter.some((q) => q.flagged) ? " \u2020: see the note below." : "")));
  }

  // What they guide now.
  if (d.outlook.length) {
    h.push('<div style="margin-top:26px;padding:2px 0 2px 16px;border-left:3px solid ' + GREEN + ';">');
    h.push(heading("What they guide now").replace("margin:26px 0 6px", "margin:0 0 6px"));
    for (const o of d.outlook) {
      h.push('<div style="padding:8px 0;">'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        + '<td style="font-size:15px;vertical-align:top;">' + esc(o.measure) + '<div style="font-size:12px;color:' + SOFT + ';">' + esc(o.period) + '</div></td>'
        + '<td align="right" style="font-size:15px;font-weight:600;white-space:nowrap;vertical-align:top;padding-left:10px;">' + esc(o.guide) + '</td></tr></table>'
        + (o.line ? '<div style="font-size:13px;color:' + SOFT + ';margin-top:2px;">' + esc(o.line) + '</div>' : '')
        + '</div>');
    }
    h.push('</div>');
  }

  // How reliable the guide has been: one strip per key measure.
  if (d.record.length) {
    h.push(heading("How reliable their guide has been"));
    h.push('<div style="font-size:13px;color:' + SOFT + ';margin:-2px 0 8px;">' + esc(lead) + '</div>');
    for (const r of d.record) {
      h.push('<div style="padding:12px 0;border-top:1px solid ' + LINE + ';">'
        + '<div style="font-size:15px;margin-bottom:8px;">' + esc(r.measure) + '</div>'
        + beatStrip(r.seq)
        + '<div style="font-size:11px;color:' + SOFT + ';margin-top:5px;">' + esc(r.span + ", oldest first") + '</div>'
        + '<div style="font-size:14px;margin-top:8px;">' + esc(r.line) + '</div>'
        + (r.typical ? '<div style="font-size:13px;color:' + SOFT + ';margin-top:2px;">' + esc(r.typical) + '</div>' : '')
        + '</div>');
    }
    h.push(quietLine("Solid: above the guide. Light: within the range. Outlined: below. Dashed: set aside (\u2020), the gap is too large to be sure it is like for like."));
  }

  h.push('<div style="margin-top:30px;font-family:' + SERIF_HEAD + ';font-size:19px;">Full history</div>');
  h.push('<div style="font-size:13px;color:' + SOFT + ';margin-top:2px;">Every period, against the last guide in force.</div>');

  const th = (head) => '<th align="left" style="padding:0 8px 5px 0;border-bottom:1px solid '
    + LINE + ';font-weight:normal;font-size:12px;color:'
    + SOFT + ';">' + esc(head) + '</th>';

  /* The guided column may wrap at its spaces: a guide that moved during the
     period ("$10.4bn to $11bn → $11.1bn to $11.3bn") is wider than a phone
     leaves room for, and the table ran off the right edge with the result
     column cut away. Every other column stays on one line. */
  /* Five columns do not fit a phone. The measure is printed once, as a
     line of its own, and its years sit under it in four columns. */
  const stackedRows = (rows) => {
    const out = ['<tr>' + ["Year", "Guided", "Reported", ""].map((x) => th(x)).join("") + '</tr>'];
    let last = null;
    for (const r of rows) {
      if (r[0] !== last) {
        out.push('<tr><td colspan="4" style="padding:10px 0 2px;font-size:14px;font-weight:600;color:' + INK + ';">' + esc(r[0]) + '</td></tr>');
        last = r[0];
      }
      out.push('<tr>' + r.slice(1).map((cell, i) => td(cell, i === 0 ? SOFT : INK, false, i === 1)).join("") + '</tr>');
    }
    return out.join("");
  };
  const td = (cell, colour, open, wrap) => '<td align="left" style="padding:5px 8px ' + (open ? '3px' : '5px')
    + ' 0;' + (open ? '' : 'border-bottom:1px solid ' + LINE + ';') + 'color:' + colour
    + ';' + (wrap ? 'line-height:1.35;' : 'white-space:nowrap;') + 'vertical-align:top;">' + esc(cell) + '</td>';

  for (const g of metrics) {
    h.push('<div style="margin-top:22px;padding-top:14px;border-top:1px solid ' + LINE + ';">');
    h.push('<div style="font-size:16px;font-weight:600;color:' + INK + ';">' + esc(g.metric) + '</div>');


    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + SANS + ';font-variant-numeric:tabular-nums'
      + ';font-size:13px;">');
    h.push('<tr>' + HEADINGS.map(th).join("") + '</tr>');

    for (const p of g.rows) {
      const quiet = p.notGuided || p.unanswered;
      const cells = rowCells(p);
      // The strip sits on its own line under the figures, the full width of
      // the table: a fifth column would not fit beside them on a phone.
      const strip = quiet ? "" : stripHtml(p);
      h.push('<tr>' + cells.map((cell, i) =>
        // A row with no outcome is muted throughout: context, not a result.
        // Still no red or amber anywhere - a tax rate above guidance is bad
        // for the company and irrelevant to a short seller, and colour would
        // decide that for the reader. The strip's green marks the guide.
        td(cell, quiet ? SOFT : i === 0 ? SOFT : INK, Boolean(strip), i === 1)).join("") + '</tr>');
      if (strip) {
        h.push('<tr><td colspan="' + cells.length + '" style="padding:0 0 7px 0;border-bottom:1px solid '
          + LINE + ';">' + strip + '</td></tr>');
      }
    }

    h.push('</table></div>');
  }

  if (anyNote) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + SOFT + ';line-height:1.5;">'
      + esc(SPLIT_NOTE) + '</p>');
  }

  if (anyFlag) {
    h.push('<p style="margin-top:10px;font-size:12px;color:' + SOFT + ';line-height:1.5;">'
      + esc(FLAG_NOTE) + '</p>');
  }

  if (annual.rows.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + LINE + ';">');
    h.push('<div style="font-family:' + SERIF_HEAD + ';font-size:17px;color:' + INK + ';">Guided once a year</div>');
    h.push('<div style="font-size:14px;color:' + SOFT + ';margin-top:2px;">'
      + 'Results from the company\'s own tagged filings, not from the release.</div>');

    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + SANS + ';font-variant-numeric:tabular-nums'
      + ';font-size:13px;">');
    h.push(stackedRows(annual.rows));
    h.push('</table>');

    for (const n of annual.notes) {
      h.push('<p style="margin-top:10px;font-size:12px;color:' + SOFT + ';line-height:1.5;">'
        + esc(n) + '</p>');
    }
    h.push('</div>');
  }

  if (alsoRows.length) {
    h.push('<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' + LINE + ';">');
    h.push('<div style="font-family:' + SERIF_HEAD + ';font-size:17px;color:' + INK + ';">Also guided</div>');
    h.push('<div style="font-size:14px;color:' + SOFT + ';margin-top:2px;">Too few closed periods to show a record yet.</div>');
    h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
      + ' style="width:100%;margin-top:10px;border-collapse:collapse;font-family:' + SANS + ';font-variant-numeric:tabular-nums'
      + ';font-size:13px;">');
    h.push(stackedRows(alsoRows));
    h.push('</table></div>');
  }

  if (moreLine) {
    h.push('<p style="margin-top:22px;font-size:14px;color:' + SOFT + ';">'
      + esc(moreLine.charAt(0).toUpperCase() + moreLine.slice(1)) + '</p>');
  }

  h.push('<p style="margin-top:26px;font-size:15px;line-height:1.6;">Thanks,<br>Zahoor · Guidance Scorecard · hello@zahoorbhat.com</p>');
  h.push('<p style="margin-top:26px;padding-top:14px;border-top:1px solid ' + LINE + ';font-size:13px;color:' + SOFT + ';line-height:1.6;">'
    + 'Questions, or something that looks wrong: reply to this, or write to '
    + '<a href="mailto:hello@zahoorbhat.com" style="color:' + SOFT + ';">hello@zahoorbhat.com</a>. '
    + 'Every figure is read from the company\'s own filings on EDGAR. Guidance comes from the'
    + ' earnings release; results from the release that reported the period, or from the'
    + ' company\'s tagged annual filings where a measure is guided once a year. A guide is'
    + ' only scored against the same period, on the same basis. Nothing here is a forecast.</p>');

  if (opts.unsubscribeUrl) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + SOFT + ';">'
      + '<a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + SOFT + ';">Unsubscribe</a>'
      + (opts.postalAddress ? ' &middot; ' + esc(opts.postalAddress) : '') + '</p>');
  }

  h.push('</div></div></div>');

  return { subject, html: h.join("\n"), text: t.join("\n") };
}


/* ------------------------------------------------------------------ *
 * The honest short note: reported, but nothing to score
 * ------------------------------------------------------------------ */

/**
 * The email a follower gets when a company they follow reports and there is
 * nothing to score.
 *
 * Silence looked like the product had failed: CarMax filed its results and
 * its follower heard nothing, exactly as if the poller had missed it. So the
 * follower is told plainly, on the day, that the release came in, what (if
 * anything) it guided in numbers, and why there is no scorecard - with a link
 * to the release itself.
 *
 * input: { company, ticker, cik, filed, accession, guided: [sentences],
 *          matched: number, releasesRead: number }
 */
export function renderNothingToScore(input, options) {
  const o = options || {};
  const company = displayName(input.company || input.ticker);
  const guided = (input.guided || []).slice(0, 6);
  const moreGuided = Math.max(0, (input.guided || []).length - guided.length);
  const acc = String(input.accession || "");
  const link = input.cik && acc
    ? "https://www.sec.gov/Archives/edgar/data/" + Number(input.cik) + "/" + acc.replace(/-/g, "") + "/"
    : null;
  const when = input.filed ? " on " + longDate(input.filed) : "";

  const lines = [];
  lines.push(company + " (" + input.ticker + ") filed its earnings release" + when + ".");
  if (guided.length) {
    lines.push("It guided in numbers, but none of these has a result on record to compare yet:");
  } else {
    lines.push("The release carries no numeric guidance, so there is nothing to compare it with.");
  }
  const why = "Across its last " + (input.releasesRead || "few") + " releases we have matched "
    + (input.matched || 0) + " guided " + ((input.matched || 0) === 1 ? "figure" : "figures")
    + " to a reported result - fewer than the three a scorecard needs. You will get a note like"
    + " this each time it reports, and the full scorecard once there is something to score.";

  // The same words as the full email's subject for the same situation.
  const subject = shortName(company) + (guided.length
    ? " reported: new guidance, nothing to score yet"
    : " reported: no guidance in figures");

  const t = [];
  t.push(lines[0]);
  t.push("");
  t.push(lines[1]);
  for (const g of guided) t.push("- " + g);
  if (moreGuided) t.push("- and " + moreGuided + " more");
  t.push("");
  t.push(why);
  if (link) { t.push(""); t.push("The release on EDGAR: " + link); }
  t.push("");
  t.push("Thanks,");
  t.push("Zahoor · Guidance Scorecard · hello@zahoorbhat.com");
  if (o.unsubscribeUrl) { t.push(""); t.push("Unsubscribe: " + o.unsubscribeUrl); }

  /* The same look as the full email: the grey "nothing to score" hero, the
     guides under a left rule, then why and where to read the release. */
  const H = HERO.none;
  const h = [];
  h.push('<div style="margin:0;padding:20px 0;background:' + PAGE + ';">');
  h.push('<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:' + SANS + ';color:' + INK + ';font-size:15px;line-height:1.45;">');
  h.push('<div style="background:' + H.bg + ';color:' + H.fg + ';padding:24px 22px 22px;">');
  h.push('<div style="font-size:13px;color:' + H.sub + ';">' + esc(company + " (" + input.ticker + ")")
    + (input.filed ? " \u00b7 filed " + esc(longDate(input.filed)) : "") + '</div>');
  h.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>'
    + '<td style="font-size:50px;font-weight:700;line-height:1;letter-spacing:-1px;padding-right:16px;color:' + H.fg + ';">0</td>'
    + '<td style="font-size:15px;line-height:1.35;color:' + H.fg + ';">key measures to score<br>in this release</td></tr></table>');
  h.push('<div style="font-size:15px;line-height:1.45;margin-top:14px;color:' + H.fg + ';">' + esc(guided.length
    ? "It guided in figures, but nothing it has guided has a result on record to compare yet."
    : lines[1]) + '</div>');
  h.push('</div>');
  h.push('<div style="padding:0 22px 26px;">');
  if (guided.length) {
    h.push('<div style="margin-top:24px;padding:2px 0 2px 16px;border-left:3px solid ' + GREEN + ';">');
    h.push('<div style="font-family:' + SERIF_HEAD + ';font-size:19px;margin:0 0 6px;">What they guide now</div>');
    for (const g of guided) h.push('<div style="padding:6px 0;font-size:15px;">' + esc(g) + '</div>');
    if (moreGuided) h.push('<div style="font-size:13px;color:' + SOFT + ';">and ' + moreGuided + ' more</div>');
    h.push('</div>');
  }
  h.push('<p style="margin:22px 0 0;font-size:14px;color:' + SOFT + ';">' + esc(why) + '</p>');
  if (link) h.push('<p style="margin:14px 0 0;font-size:15px;"><a href="' + esc(link) + '" style="color:' + GREEN + ';font-weight:600;">Read the release on EDGAR</a></p>');
  h.push('<p style="margin-top:26px;font-size:15px;line-height:1.6;">Thanks,<br>Zahoor · Guidance Scorecard · hello@zahoorbhat.com</p>');
  if (o.unsubscribeUrl) {
    h.push('<p style="margin-top:14px;font-size:12px;color:' + SOFT + ';"><a href="' + esc(o.unsubscribeUrl)
      + '" style="color:' + SOFT + ';">Unsubscribe</a>' + (o.postalAddress ? ' · ' + esc(o.postalAddress) : '') + '</p>');
  }
  h.push('</div></div></div>');

  return { subject, text: t.join("\n"), html: h.join("") };
}
