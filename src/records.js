/**
 * Reading the record.
 *
 * Everything expensive happened in GitHub Actions: fourteen releases per
 * company, twenty-odd model calls, EDGAR fetched forty times. What reaches a
 * subscriber is a single KV read of a finished record.
 *
 * That was the point of the whole arrangement. The old version of this product
 * made people wait five minutes while it read filings, and they left. Nobody
 * waits here, because nothing is computed while they wait.
 *
 * Nothing in this file calls a model or fetches a filing. If it ever needs to,
 * something has gone wrong upstream.
 */

import { revisionSentence } from "./summary.js";

const PREFIX = "record:";

/* A metric earns a block at three matched pairs; a company is published at two
   qualifying metrics. Applied when the record is built, not here - this file
   reads what was decided, so the page and the email cannot disagree with the
   stored coverage. */

/**
 * Guides whose period closed and which the release could not answer.
 *
 * A third kind of row, and the one that was being told as a lie.
 *
 * Walmart guided Q3 FY2025 operating income to grow 3.0% to 4.5% in constant
 * currency. The Q3 release reports constant-currency growth of 9.8% - but as
 * reported, not adjusted - and reports ADJUSTED growth of 9.5% for the nine
 * months, not the quarter. Neither is adjusted, constant currency AND the
 * quarter, and no fourth figure is. That quarter carried business
 * reorganisation charges and an opioid settlement expense, so the two are
 * genuinely different numbers, and taking 9.8% would credit management with a
 * beat it never printed.
 *
 * The pair was refused, correctly. But the email had only comparable pairs to
 * work from, saw a gap where a period should be, and printed "not guided" -
 * which is false. The guide existed, in a table, in a range. What was missing
 * was a comparable answer, and those are different facts about a company.
 *
 * WHICH REFUSALS EARN A ROW. Only the ones that are facts about the RELEASE:
 * the figure was absent, or it was there on a basis that cannot be compared.
 * Not the ones that are facts about our own uncertainty:
 *
 *   A period mismatch is usually a guide for a year still open. Walmart's
 *   FY2027 guide collects one every quarter until the year ends, and a row
 *   reading "not reported" against an unfinished year would be four pieces of
 *   noise a year, forever.
 *
 *   An unreadable period is an extraction that failed. The company may well
 *   have reported the figure; saying otherwise blames it for our miss.
 *
 * Judged on the fields rather than on the refusal sentence, so rewording a
 * message cannot silently change which rows appear.
 */
function unansweredOf(record) {
  const out = [];
  const seen = new Set();

  for (const p of record.pairs || []) {
    if (p.comparable) continue;
    if (!p.guide_period) continue;

    // Nothing came back at all: the release does not report it.
    const notReported = p.actual == null && !p.actual_found_as;
    // A figure came back for the right period and was refused on basis or
    // unit. The release reported something; it is not comparable.
    const refusedOnBasis = p.actual != null && p.actual_period === p.guide_period;

    if (!notReported && !refusedOnBasis) continue;

    const key = String(p.metric_as_written) + "|" + p.guide_period;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      metric: p.metric_as_written,
      period: p.guide_period,
      unit: p.unit,
      guide: p.guide,
      unanswered: true,
    });
  }

  return out;
}

/**
 * What a subscriber is shown.
 *
 * FLAGGED PAIRS ARE LEFT OUT OF THE EMAIL, and this is the one place the page
 * and the email deliberately differ.
 *
 * A flag means the gap is too large to take at face value - Honeywell missing
 * sales by 8% because it sold half the company, a level reported where a rate
 * was guided. Those are real findings about the DATA, and they belong in the
 * record and on the page where someone can look into them. They do not belong
 * in an email a portfolio manager reads in the first ten minutes after a
 * release, because he cannot check them and will not try.
 *
 * The alternative was to print the caution alongside. Two sentences of
 * hedging next to a number reads as a disclaimer, and a disclaimer in an email
 * is a number nobody trusts and everybody remembers.
 *
 * The count of what was withheld is reported, so the omission is visible
 * rather than silent.
 */
export function forEmail(record) {
  const comparable = (record.pairs || []).filter((p) => p.comparable && p.score);
  const clean = comparable.filter((p) => !(p.score.flags && p.score.flags.length));
  const withheld = comparable.length - clean.length;

  return {
    ticker: record.ticker,
    company: record.company,
    builtAt: record.builtAt,
    coverage: record.coverage,
    landed: tallyOf(clean),
    withheldForReview: withheld,
    pairs: clean.map(trim),
    unanswered: unansweredOf(record),
    revisions: (record.revisions || []).map((r) => ({
      metric: r.metric,
      period: r.period,
      direction: r.direction,
      // The sentence is BUILT HERE, from the untrimmed revision, and not read
      // off the record.
      //
      // The stored summary was written when the record was built, so a change
      // to the wording changed nothing until the backfill was re-run - and
      // re-running a backfill rewrites history a subscriber has already read.
      //
      // It cannot be built any later than this line. The view below is
      // deliberately narrow, and the fields the sentence needs - the label as
      // written, the unit, the figures before and after - are exactly the ones
      // this mapper drops. Building it in the renderer meant handing the
      // sentence builder a row with its inputs already stripped, which is
      // precisely what happened: it returned null on every row and the email
      // fell back to the stale sentence, four deploys running.
      //
      // The stored summary stays as the fallback, for a record built before
      // summary.js existed and missing a field. Stale beats broken.
      summary: revisionSentence(r) || r.summary,
      // Carried through so the email can tell today's revisions from the
      // fourteen releases of history behind them.
      release: r.release,
      filed: r.filed,
    })),
    latestRelease: latestRelease(record),
    currentGuidance: record.currentGuidance || [],
  };
}

/* Which release is the newest? The record lists them newest first, but a
   record is not the place to depend on ordering that was never promised. */
function latestRelease(record) {
  let best = null;
  for (const r of record.releasesRead || []) {
    if (!best || String(r.filed) > String(best.filed)) best = r;
  }
  return best;
}

function trim(p) {
  return {
    metric: p.metric_as_written,
    period: p.guide_period,
    basis: p.basis,
    unit: p.unit,
    guide: p.guide,
    // The figure that was JUDGED, not the raw one.
    //
    // Delta guided $1.60 to $1.90 and reported $1.55, which is $1.6 at the
    // precision guided and therefore within the range. Printing "reported
    // 1.55 (within)" reads as an error to anyone who can subtract, and an
    // email that looks wrong is wrong.
    actual: typeof p.score.actualAsGuided === "number" ? p.score.actualAsGuided : p.actual,
    actualAsReported: p.actual,
    position: p.score.position,
    summary: p.score.summary,
    quote: p.quote,
  };
}

function tallyOf(pairs) {
  const t = { above: 0, within: 0, below: 0, noVerdict: 0, total: pairs.length };
  for (const p of pairs) {
    if (p.score.position === "above") t.above += 1;
    else if (p.score.position === "within") t.within += 1;
    else if (p.score.position === "below") t.below += 1;
    else t.noVerdict += 1;
  }
  return t;
}

/**
 * The record in a sentence.
 *
 * Deliberately flat. "Beaten or met guidance in 33 of 34 quarters" is the line
 * that writes itself, and it is the line this product does not write: it is an
 * inference, and the reader is a portfolio manager who is paid to draw his
 * own. What he is given is the count.
 *
 * The same discipline as the other product, which quotes a filing and stops.
 */
export function headline(tally) {
  if (!tally || !tally.total) return "No matched pairs on record.";

  const parts = [];
  if (tally.above) parts.push(tally.above + " above the guided range");
  if (tally.within) parts.push(tally.within + " within it");
  if (tally.below) parts.push(tally.below + " below it");
  if (tally.noVerdict) {
    parts.push(tally.noVerdict + " against a single figure rather than a range");
  }

  return tally.total + " matched " + (tally.total === 1 ? "pair" : "pairs")
    + ": " + parts.join(", ") + ".";
}

/** One company's stored record, or null if it has never been built. */
export async function readRecord(env, ticker) {
  if (!env.CACHE) throw new Error("The CACHE KV binding is not available to this Worker.");
  const raw = await env.CACHE.get(PREFIX + String(ticker || "").toUpperCase());
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // A record that will not parse is worse than one that is missing: the
    // missing one is obviously missing.
    throw new Error("The stored record for " + ticker + " is not readable JSON.");
  }
}

/**
 * Everything stored, and when it was built.
 *
 * The first thing to check after a backfill, and the answer to "did the upload
 * step actually work" - a question that has cost time on the other product
 * more than once, because a deploy that silently did nothing looks exactly
 * like a deploy that worked.
 */
export async function listRecords(env) {
  if (!env.CACHE) throw new Error("The CACHE KV binding is not available to this Worker.");

  const listed = await env.CACHE.list({ prefix: PREFIX });
  const out = [];

  for (const key of listed.keys) {
    const ticker = key.name.slice(PREFIX.length);
    let record = null;
    try {
      record = await readRecord(env, ticker);
    } catch (e) {
      out.push({ ticker, error: e.message });
      continue;
    }
    if (!record) continue;

    const comparable = (record.pairs || []).filter((p) => p.comparable && p.score);
    const clean = comparable.filter((p) => !(p.score.flags && p.score.flags.length));

    out.push({
      ticker,
      company: record.company,
      builtAt: record.builtAt,
      publishable: record.coverage ? record.coverage.publishable : false,
      qualifyingMetrics: record.coverage ? record.coverage.qualifyingMetrics : 0,
      matchedPairs: comparable.length,
      shownInEmail: clean.length,
      withheldForReview: comparable.length - clean.length,
      revisions: (record.revisions || []).length,
      headline: headline(tallyOf(clean)),
    });
  }

  return { stored: out.length, complete: listed.list_complete !== false, records: out };
}
