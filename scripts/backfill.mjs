/**
 * The historical engine.
 *
 * Builds the eight-quarter record for each company in the universe and writes
 * it to a file per company. The workflow uploads those to KV; nothing here
 * talks to Cloudflare, so it can be run and read locally without credentials
 * beyond the two it needs to read filings and call the model.
 *
 * WHY THIS RUNS IN ACTIONS AND NOT IN THE WORKER
 *
 * Eleven releases per company, each needing its guidance extracted, plus a
 * second call per consecutive pair to find the actuals. Twenty-odd model calls
 * and forty-odd EDGAR fetches for one company. A Cloudflare Worker has ten
 * milliseconds of CPU and a subrequest cap; it cannot do this and should not
 * try. The Worker keeps the live path - one release, three calls - which fits
 * comfortably.
 *
 * This is the same split that works on the other product: the Worker watches,
 * Actions does the heavy reading.
 *
 * WHAT IT COSTS, AND WHY THAT IS ACCEPTABLE
 *
 * The full backfill is a one-off. After it, each company gains one release a
 * quarter, and the incremental run reads one release rather than eleven.
 *
 * EVERY MODULE IN src/ IS SHARED WITH THE WORKER, UNCHANGED. Not copied. If
 * the backfill and the live path disagreed about how a period is labelled or
 * which exhibit to read, the stored record and the new email would be built on
 * different rules and the mismatch would be invisible.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolveCik, companyCalendar, factsFor } from "../src/xbrl.js";
import { annualRecord } from "../src/annual.js";
import { earningsReleases, guidanceFrom } from "../src/guidance.js";
import { requestsFrom, actualsFrom } from "../src/actuals.js";
import { samePeriod } from "../src/period.js";
import { scoreAll } from "../src/score.js";
import { pairUp } from "../src/pairing.js";
import { periodLabel } from "../src/format.js";
import { revisionsBetween } from "../src/revisions.js";
import { startAnswers } from "./answers.mjs";

/* How many releases to read.
   Eight scoreable quarters needs more than eight releases, because a guide for
   a period is issued in the release BEFORE it - so the oldest guide scored
   comes from a release older than the oldest quarter scored.

   It was eleven, and that quietly made one whole class of company impossible.
   A company that guides only the full year gets ONE matched pair a year, when
   the year closes. Three matched pairs therefore needs three completed fiscal
   years, which is thirteen or fourteen releases. At eleven, Macy's produced
   two pairs per metric and failed a rule it had never been given the chance to
   pass. Fourteen is the smallest number at which an annual-only guider can
   qualify at all. */
const RELEASES = 14;

/* SEC asks for no more than ten requests a second and means it. A pause
   between companies costs nothing on a job that runs once. */
const PAUSE_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The env object the src modules expect.
 *
 * They take it as a parameter rather than reading a global, which is exactly
 * what makes them runnable in both places. In the Worker it is the bindings;
 * here it is process.env.
 */
const env = {
  SEC_USER_AGENT: process.env.SEC_USER_AGENT,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};

/**
 * One measure, however the company labelled it that year.
 *
 * The key coverage is counted on, and it has been wrong twice.
 *
 * Broadcom bakes the period into its labels - "First quarter Adjusted EBITDA
 * guidance", "Fourth quarter Adjusted EBITDA guidance" - so one measure with
 * nine matched pairs was counted as five metrics with one or two each, and a
 * company with a strong record looked like one with none.
 *
 * Walmart writes "Net sales (cc)" in some years and "Consolidated net sales
 * (cc)" in others. United writes 'Adjusted diluted earnings per share' and
 * then 'Adjusted diluted earnings per share ("EPS")'. Macy's renamed one line
 * "Core Adjusted EBITDA...". Every one of those split a count.
 *
 * So everything that is scaffolding comes off: the period, the words that mark
 * a forecast, parenthetical asides, footnote markers, and the prefixes that
 * only say "the whole company".
 */
function metricKey(guide) {
  return String(guide.metric_as_written || "")
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
    .replace(/\b(consolidated|total|company)\b/g, " ")
    // Delta writes "Earnings Per Share" in its outlook table and "adjusted EPS"
    // in the narrative. One measure, five matched pairs, counted as four and
    // one.
    .replace(/\beps\b/g, "earnings per share")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* pairUp lives in src/pairing.js and is imported. This file carried its own
   copy, matching a guide to an actual by name alone, and every pairing fix
   made in the shared file stopped at the boundary. One definition. */

/**
 * Coverage, measured rather than assumed.
 *
 * The rules were set before any of this was built and they are applied here
 * rather than at display time, so a record that does not qualify is a fact
 * about the company recorded once, not a decision remade on every page load:
 *
 *   a metric needs three matched pairs to earn a block
 *   a company needs two qualifying metrics to be published
 *
 * A company that fails is still stored, with its numbers, because "how many
 * companies actually clear this bar" is the open question the universe
 * depends on and throwing away the failures would destroy the answer.
 */
function coverageOf(scoredPairs) {
  const byMetric = {};

  for (const p of scoredPairs) {
    if (!p.comparable) continue;

    // Grouped on the NORMALISED metric, not the label as written.
    //
    // Macy's renamed one line between years - "Adjusted EBITDA as a percent of
    // total revenue" became "Core Adjusted EBITDA as a percent of total
    // revenue" - and the coverage count read 1 and 1 instead of 2. Its
    // earnings-per-share label drifted the same way. A company that keeps
    // clarifying its own wording was being punished for it, and the number the
    // publication rule depends on was wrong.
    const key = metricKey(p);
    if (!byMetric[key]) {
      byMetric[key] = { labels: new Set(), periods: [] };
    }
    byMetric[key].labels.add(p.metric_as_written);
    // One period counts once. United answered 2023Q4 from two different
    // releases and the coverage list read "2023Q4, 2023Q4", inflating a count
    // the publication rule depends on.
    if (!byMetric[key].periods.includes(p.guide_period)) {
      byMetric[key].periods.push(p.guide_period);
    }
  }

  // The name shown is the cleanest of the variants, not whichever arrived
  // first. Broadcom's group was headed "Second quarter fiscal year 2026
  // Adjusted EBITDA guidance" - a label carrying a period that has nothing to
  // do with the five other quarters in the same group. Honeywell's carried
  // footnote markers: "Organic 1 Growth", "Adjusted earnings per share 2,3".
  const metrics = Object.values(byMetric).map((m) => {
    const cleaned = Array.from(m.labels)
      .map((l) => String(l)
        .replace(/([a-zA-Z)])\s+\d{1,2}(?:\s*,\s*\d{1,2})*(?=\s|$)/g, "$1")
        // Broadcom's group was still headed "First quarter Adjusted EBITDA
        // guidance" - a label naming one quarter for a group spanning six.
        .replace(/\b(first|second|third|fourth)\s+quarter\b/gi, " ")
        .replace(/\bof\s+fiscal\s+year\s*\d{2,4}\b/gi, " ")
        .replace(/\bfiscal\s+year\s*\d{2,4}\b/gi, " ")
        .replace(/\b(guidance|outlook)\b/gi, " ")
        .replace(/\s+/g, " ").trim())
      .filter((l) => l.length >= 3)
      .sort((a, b) => a.length - b.length);
    const label = cleaned[0];
    return {
    metric: label,
    alsoCalled: cleaned.filter((l) => l !== label),
    matchedPairs: m.periods.length,
    periods: m.periods,
    qualifies: m.periods.length >= 3,
  };
  }).sort((a, b) => b.matchedPairs - a.matchedPairs);

  const qualifying = metrics.filter((m) => m.qualifies);

  return {
    metrics,
    qualifyingMetrics: qualifying.length,
    publishable: qualifying.length >= 2,
    reason: qualifying.length >= 2
      ? null
      : "Fewer than two metrics have three matched pairs, so there is not enough here to publish.",
  };
}

/** One company, end to end. */
const SITE = process.env.SITE_URL || "https://guidance.zahoorbhat.com";

/* --rebuild discards the stored record and scores everything again. The
   default merges, so an ordinary run can only ADD. */
/* Arguments, split on spaces and commas whatever way they arrive. A workflow
   input box hands "DAL --rebuild" over as ONE argument, which read as a ticker
   called "DAL --REBUILD" and a rebuild flag that was never seen. */
const ARGS = process.argv.slice(2).join(" ").split(/[\s,]+/).filter(Boolean)
  // A phone turns "--" into a long dash. Read "—rebuild" as "--rebuild".
  .map((a) => a.replace(/^[\u2012\u2013\u2014\u2015]+(?=[a-z])/i, "--"));

const REBUILD = ARGS.includes("--rebuild");

/* --fresh asks the model again instead of reusing saved answers. See
   scripts/answers.mjs. The workflow downloads the saved answers to
   ANSWERS_IN before the run and uploads ANSWERS_OUT after it. */
const FRESH = ARGS.includes("--fresh");
const ANSWERS_IN = "answers/answers.json";
const ANSWERS_OUT = "out/answers/answers.json";

/**
 * The record as it stands, over the public API.
 *
 * Actions has no KV binding and the upload happens in a later step, so the
 * live record is read the same way a reader reads it. A miss is not an error:
 * a company being built for the first time has nothing to merge with.
 */
async function storedRecord(ticker) {
  try {
    const r = await fetch(SITE + "/api/record?ticker=" + encodeURIComponent(ticker) + "&full=1", {
      headers: { "User-Agent": env.SEC_USER_AGENT || "guidance-scorecard" },
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json && Array.isArray(json.pairs) ? json : null;
  } catch {
    return null;
  }
}

async function buildOne(ticker) {
  const { cik, name } = await resolveCik(env, ticker);
  const startingCalendar = await companyCalendar(env, cik);
  const releases = await earningsReleases(env, cik, RELEASES);

  if (releases.length < 2) throw new Error("Fewer than two earnings releases found.");

  // Guidance is extracted ONCE per release and used twice - for the pairing
  // against the next release's actuals, and for the revision path. Reading the
  // same document twice would double the bill for nothing.
  const guidanceByRelease = [];
  let calendar = startingCalendar;

  for (const release of releases) {
    const g = await guidanceFrom(env, cik, release, calendar);
    // The first release to settle the fiscal convention settles it for all of
    // them. Both sides of every pair must label periods the same way.
    if (g.calendar) calendar = g.calendar;
    guidanceByRelease.push(g);
    await sleep(300);
  }

  /**
   * The FIRST guide for each period, and the whole path of guides to it.
   *
   * A company can land inside its final full-year guide two very different
   * ways: by holding that guide all year, or by cutting twice to reach it.
   * Walmart opened fiscal 2026 guiding net sales growth of 3% to 4% and closed
   * it guiding 4.8% to 5.1%. Reporting only the final range against the result
   * says "within" and hides the fact that the range moved to meet the result.
   *
   * score.js has computed this since it was written - originalDelta, keyed on
   * metric and period - and nothing ever passed it the map. Wired up here.
   *
   * Oldest release first, so the first guide seen for a period is the earliest
   * one on record. Releases arrive newest first, hence the reverse loop.
   */
  const originals = {};
  const guidePaths = {};

  for (let i = guidanceByRelease.length - 1; i >= 0; i--) {
    const g = guidanceByRelease[i];
    for (const guide of g.guides || []) {
      if (!guide.period) continue;
      const hasNumber = typeof guide.low === "number"
        || typeof guide.high === "number" || typeof guide.value === "number";
      if (!hasNumber) continue;

      const key = (guide.metric_as_written || "") + "|" + guide.period;
      const figure = {
        low: guide.low ?? null,
        high: guide.high ?? null,
        value: guide.value ?? null,
      };

      if (!(key in originals)) originals[key] = figure;

      // One entry per DISTINCT figure. A guide reaffirmed unchanged across
      // four releases is one point on the path, not four.
      const path = guidePaths[key] || (guidePaths[key] = []);
      const last = path[path.length - 1];
      const same = last && last.low === figure.low
        && last.high === figure.high && last.value === figure.value;
      if (!same) path.push({ ...figure, filed: g.release.filed });
    }
  }

  // Newest first, so releases[i + 1] is the one before releases[i].
  const allPairs = [];
  const allRevisions = [];

  for (let i = 0; i < releases.length - 1; i++) {
    const current = releases[i];
    const priorGuidance = guidanceByRelease[i + 1];
    const currentGuidance = guidanceByRelease[i];

    const requests = requestsFrom(priorGuidance.guides, calendar);

    let actuals = [];
    if (requests.length) {
      const result = await actualsFrom(env, cik, current, requests, calendar);
      actuals = result.actuals;
    }

    const scored = scoreAll(pairUp(priorGuidance.guides, actuals), originals);
    for (const p of scored.pairs) {
      allPairs.push({
        ...p,
        fromRelease: priorGuidance.release.accession,
        answeredBy: current.accession,
        answeredByFiled: current.filed,
        guidePath: guidePaths[(p.metric_as_written || "") + "|" + (p.guide_period || "")] || null,
      });
    }

    const moved = revisionsBetween(priorGuidance.guides, currentGuidance.guides, {
      reportedPeriods: actuals.map((a) => a.period).filter(Boolean),
    });
    for (const r of moved.revisions) {
      allRevisions.push({ ...r, release: current.accession, filed: current.filed });
    }

    await sleep(300);
  }

  // A guide that vanishes from one release and comes back in the next was
  // never withdrawn - the extraction simply missed it once. Delta produced
  // "was guided at $6.5 to $7.5 ... does not appear in this one" immediately
  // followed by "is guided for the first time at $6.5 to $7.5". Only a guide
  // that never reappears anywhere in the history is worth reporting as absent.
  // "Guided for the first time" said twice about the same metric and period is
  // the same extraction variance as the vanishing guides above, seen from the
  // other side: the guide was missed in one release, so its reappearance looks
  // like a debut. Only the earliest is a debut.
  const debuted = new Set();
  for (let i = allRevisions.length - 1; i >= 0; i--) {
    const r = allRevisions[i];
    if (r.direction !== "new") continue;
    const k = r.metric_as_written + "|" + r.period;
    if (debuted.has(k)) r.direction = "repeat debut";
    else debuted.add(k);
  }

  const everGuided = new Set();
  for (const r of allRevisions) {
    if (r.direction !== "not repeated") everGuided.add(r.metric_as_written + "|" + r.period);
  }
  const revisions = allRevisions.filter((r) => {
    // A debut demoted above says "for the first time" and is no longer true of
    // itself. Dropped rather than rewritten: the real debut is still listed.
    if (r.direction === "repeat debut") return false;
    if (r.direction === "not repeated") {
      return !everGuided.has(r.metric_as_written + "|" + r.period);
    }
    return true;
  });

  /**
   * ONE PAIR PER MEASURE PER PERIOD.
   *
   * The loop above pairs each release's guides against the next release's
   * actuals, so a period guided in four releases produced four pairs for the
   * same measure and the same period. Walmart's fiscal 2026 net sales appeared
   * twice in one email - "guided 4.8% to 5.1%, reported 5.1%" directly above
   * "guided 3% to 4%, reported 4.25%" - two contradictory answers to the same
   * question, because one release had mislabelled a figure as the full year.
   *
   * Kept: the pair answered by the LATEST release. The period is reported once,
   * by the release that closes it, and that release is the last one to carry a
   * figure for it. An earlier release claiming the same period has misread
   * something.
   *
   * A comparable pair always beats a refused one. Otherwise a late mislabel
   * that got refused would bury a good pair from the release before it.
   */
  const bestByPeriod = new Map();
  for (const p of allPairs) {
    const key = metricKey(p) + "|" + (p.guide_period || "");
    const held = bestByPeriod.get(key);

    if (!held) { bestByPeriod.set(key, p); continue; }
    if (Boolean(p.comparable) !== Boolean(held.comparable)) {
      if (p.comparable) bestByPeriod.set(key, p);
      continue;
    }
    if (String(p.answeredByFiled || "") > String(held.answeredByFiled || "")) {
      bestByPeriod.set(key, p);
    }
  }
  const collapsed = Array.from(bestByPeriod.values());

  /**
   * A BACKFILL MAY ONLY ADD.
   *
   * The model does not return the same thing twice on the same filings. One
   * Walmart run scored 35 pairs, the next 33 - the three Q1 2027 pairs simply
   * did not come back, from releases that had produced them an hour earlier.
   * Every re-run was a gamble on the model having a good day, and a bad day
   * silently deleted months of record a subscriber had already read.
   *
   * So a stored pair for a measure and period is kept, and a new run only
   * fills periods the record does not have. Records converge instead of
   * oscillating, and re-running becomes safe - which it has to be, because
   * filling the gaps a bad run left is the only way to get them back.
   *
   * --rebuild opts out, for when a stored pair is genuinely wrong. Deliberate,
   * named, and not the default.
   */
  let merged = collapsed;
  let kept = 0;

  if (!REBUILD) {
    const previous = await storedRecord(ticker);
    if (previous) {
      const byKey = new Map();
      for (const p of collapsed) {
        byKey.set(metricKey(p) + "|" + (p.guide_period || ""), p);
      }
      for (const p of previous.pairs || []) {
        const key = metricKey(p) + "|" + (p.guide_period || "");
        const fresh = byKey.get(key);

        /**
         * A SCORED PERIOD IS FINAL. Only --rebuild changes one.
         *
         * The first version of this rule protected a stored scored pair from a
         * refusal, and left two scored pairs to fight it out last-wins. So the
         * churn continued in a quieter form: Delta's Q4 2023 revenue read
         * "11%, within" after one run and "6%, below by 3pp" after the next -
         * the same guide, the same filing, a different answer, and the second
         * one silently replacing a figure a subscriber had already read.
         *
         * A subscriber cannot tell a corrected figure from a re-rolled one.
         * Neither can we, from inside a run: the model is not more right the
         * second time, only different. So the first scored answer stands, and
         * changing it is a decision someone takes with --rebuild rather than a
         * side effect of running the backfill again.
         *
         * What a re-run is still for: filling periods that have no scored pair
         * yet. That is how Delta went from four scored revenue periods to
         * eight. Gaps fill; answers do not move.
         */
        if (p.comparable) {
          if (fresh && fresh.comparable) kept += 1;
          byKey.set(key, p);
          continue;
        }

        // A COMPARABLE STORED PAIR BEATS A REFUSED NEW ONE.
        //
        // Keeping a stored pair only where this run produced nothing was not
        // enough. A run that comes back empty-handed does not produce nothing
        // for that key - it produces a refusal, which took the slot and left
        // the good stored pair out. Walmart's Q1 2027 came back three
        // different ways in one email: scored on EPS, "not reported" on
        // operating income, "not guided" on net sales. All three had been
        // scored an hour earlier, and the company had guided and reported all
        // three.
        //
        // "Not guided" is a statement about management. A run having a bad
        // minute is not grounds for making it.
        if (fresh && (fresh.comparable || !p.comparable)) continue;

        byKey.set(key, p);
        kept += 1;
      }
      merged = Array.from(byKey.values());
    }
  }

  /**
   * The annual measures, from tagged facts rather than from a release.
   *
   * One extra HTTP fetch per company and no model calls. Kept entirely apart
   * from the pairs above - different source, different rules, its own table -
   * so nothing that works today can be disturbed by it.
   *
   * A failure here is not a failure of the record. Companyfacts is occasionally
   * unavailable and these measures are an addition, not the product.
   */
  let annual = [];
  try {
    const tagged = await factsFor(env, cik, calendar);
    annual = annualRecord(guidanceByRelease, tagged.facts, scoreAll);
  } catch (e) {
    console.error("  " + ticker + ": annual measures unavailable - " + e.message);
  }

  const coverage = coverageOf(merged);
  const comparable = merged.filter((p) => p.comparable);

  return {
    ticker,
    company: name,
    cik,
    builtAt: new Date().toISOString(),
    calendar: calendar.meta,
    releasesRead: releases.map((r) => ({ accession: r.accession, filed: r.filed })),
    coverage,
    landed: {
      above: comparable.filter((p) => p.score && p.score.position === "above").length,
      within: comparable.filter((p) => p.score && p.score.position === "within").length,
      below: comparable.filter((p) => p.score && p.score.position === "below").length,
      noVerdict: comparable.filter((p) => p.score && p.score.position === null).length,
      flagged: comparable.filter((p) => p.score && p.score.flags && p.score.flags.length).length,
    },
    pairs: merged,
    carriedOver: kept,
    annual,
    revisions,
    currentGuidance: guidanceByRelease[0].guides,
  };
}

/**
 * The run, written so it can be read on a phone.
 *
 * Downloading a zip, unzipping it and opening 60KB of JSON is not a way to
 * check whether a run worked. This goes straight onto the Actions run page:
 * the table answers "did it work", and the per-company detail answers "why
 * not" without opening anything.
 *
 * The full records stay in the artifact for when the detail is actually
 * needed.
 */
function markdownFor(records, failures) {
  const lines = [];
  lines.push("## Backfill");
  lines.push("");
  lines.push("| | company | pairs | metrics 3+ | publishable | above | within | below | no verdict | flagged | revisions |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");

  for (const r of records) {
    if (r.error) {
      lines.push("| " + r.ticker + " | - | - | - | FAILED | | | | | | |");
      continue;
    }
    lines.push("| " + r.ticker + " | " + r.company + " | " + r.comparablePairs + " | "
      + r.qualifyingMetrics + " | " + (r.publishable ? "**yes**" : "no") + " | "
      + r.landed.above + " | " + r.landed.within + " | " + r.landed.below + " | "
      + (r.landed.noVerdict || 0) + " | " + (r.landed.flagged || 0) + " | "
      + r.revisions + " |");
  }

  for (const r of records) {
    lines.push("");
    lines.push("### " + r.ticker + (r.company ? " — " + r.company : ""));

    if (r.error) {
      lines.push("");
      lines.push("Failed: " + r.error);
      continue;
    }

    lines.push("");
    lines.push(r.fiscal || "");
    lines.push("");

    if (r.metrics && r.metrics.length) {
      lines.push("**Matched pairs by metric**");
      lines.push("");
      for (const m of r.metrics) {
        lines.push("- " + m.matchedPairs + " — " + m.metric
          + (m.qualifies ? "" : " (below the three needed)")
          + (m.alsoCalled && m.alsoCalled.length
            ? "  \n  also called: " + m.alsoCalled.join("; ")
            : "")
          + "  \n  " + m.periods.join(", "));
      }
    } else {
      lines.push("No metric produced a single matched pair.");
    }

    if (r.reason) {
      lines.push("");
      lines.push("Not published: " + r.reason);
    }

    if (r.rejections && Object.keys(r.rejections).length) {
      lines.push("");
      lines.push("**Why pairs were refused**");
      lines.push("");
      for (const [why, n] of Object.entries(r.rejections)) {
        lines.push("- " + n + " — " + why);
      }
    }

    if (r.sampleScores && r.sampleScores.length) {
      lines.push("");
      lines.push("**Scored**");
      lines.push("");
      for (const s of r.sampleScores) lines.push("- " + s);
    }

    if (r.unreadablePeriods && r.unreadablePeriods.length) {
      lines.push("");
      lines.push("**Period wording that could not be resolved**");
      lines.push("");
      for (const t of r.unreadablePeriods) lines.push("- `" + t + "`");
    }

    if (r.periodMismatches && r.periodMismatches.length) {
      lines.push("");
      lines.push("**Periods that did not match**");
      lines.push("");
      for (const t of r.periodMismatches) lines.push("- " + t);
    }

    if (r.sampleRevisions && r.sampleRevisions.length) {
      lines.push("");
      lines.push("**Revisions, most recent first**");
      lines.push("");
      for (const s of r.sampleRevisions) lines.push("- " + s);
    }
  }

  if (failures) {
    lines.push("");
    lines.push("**" + failures + " company/companies failed. See the log.**");
  }

  /* The same thing again, fenced, so GitHub puts a copy button on it. Reading
     a rendered table is easier; getting it OUT of one on a phone means
     selecting text by hand. Both, rather than choosing. */
  const plain = lines.join("\n");
  lines.push("");
  lines.push("<details><summary>Copy the whole summary</summary>");
  lines.push("");
  lines.push("FENCE");
  lines.push(plain.split("FENCE").join("'''"));
  lines.push("```");
  lines.push("");
  lines.push("</details>");

  return lines.join("\n") + "\n";
}

async function main() {
  if (!env.SEC_USER_AGENT) throw new Error("SEC_USER_AGENT is not set.");
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set.");

  const fromArg = ARGS.filter((a) => !a.startsWith("--")).join(",").trim();
  const universe = JSON.parse(await readFile("config/universe.json", "utf8"));
  const tickers = fromArg
    ? fromArg.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : universe.tickers;

  await mkdir("out", { recursive: true });

  // Before any model call, so every one goes through the store.
  const answers = await startAnswers({ from: ANSWERS_IN, fresh: FRESH });
  console.log(answers.stats.loaded + " saved model answers on file." + (FRESH ? " --fresh: none will be reused." : ""));

  const summary = [];
  let failures = 0;

  for (const ticker of tickers) {
    try {
      console.log("Building " + ticker + "...");
      const record = await buildOne(ticker);
      await writeFile("out/" + ticker + ".json", JSON.stringify(record, null, 2));

      const comparable = record.pairs.filter((p) => p.comparable);
      const rejections = {};
      for (const p of record.pairs) {
        if (p.comparable) continue;
        // NOT "<period>". GitHub renders the job summary as markdown and ate
        // the angle brackets as an HTML tag, so every rejection line read
        // "the guide is for and the figure reported is for ".
        const why = String(p.why || "unknown").replace(/\b20\d\d(FY|Q[1-4])\b/g, "that period");
        rejections[why] = (rejections[why] || 0) + 1;
      }

      summary.push({
        ticker,
        company: record.company,
        fiscal: "Year end " + record.calendar.fiscalYearEnd + ". "
          + record.calendar.labelConvention + ", from " + record.calendar.conventionFrom + ".",
        comparablePairs: comparable.length,
        carriedOver: record.carriedOver || 0,
        qualifyingMetrics: record.coverage.qualifyingMetrics,
        publishable: record.coverage.publishable,
        reason: record.coverage.reason,
        metrics: record.coverage.metrics,
        rejections,
        landed: record.landed,
        revisions: record.revisions.length,
        sampleScores: comparable.slice(0, 12).map((p) => p.score ? p.score.summary : ""),
        sampleRevisions: record.revisions.slice(0, 12).map((r) => r.summary),
        // Still unexplained: some pairs are refused because the period text
        // the model returned could not be resolved. Showing the actual wording
        // is the only way to find out what it looked like.
        unreadablePeriods: Array.from(new Set(
          record.pairs
            .filter((p) => !p.comparable && String(p.why || "").includes("period could not be read"))
            .map((p) => String(p.actual_period_text || "(none returned)"))
        )).slice(0, 8),
        // "Different periods" is grouped above with the periods blanked out,
        // so GE's nine and Coca-Cola's sixteen could not be read. Each one is
        // listed here: the measure, the period guided, the period the figure
        // was reported for, and the model's own wording for that period -
        // which is what tells a real mismatch from a mislabelled one.
        periodMismatches: Array.from(new Set(
          record.pairs
            .filter((p) => !p.comparable && String(p.why || "").startsWith("Different periods"))
            .map((p) => String(p.metric_as_written || "?")
              + ": guided for " + periodLabel(p.guide_period)
              + ", reported for " + periodLabel(p.actual_period)
              + (p.actual_period_text ? ' (release wording: "' + p.actual_period_text + '")' : ""))
        )).slice(0, 20),
      });

      console.log("  " + ticker + ": " + comparable.length
        + " comparable pairs, " + record.coverage.qualifyingMetrics + " qualifying metrics, "
        + (record.coverage.publishable ? "publishable" : "not publishable"));
    } catch (e) {
      failures += 1;
      console.error("  " + ticker + " FAILED: " + e.message);
      summary.push({ ticker, error: e.message });
    }

    // After every company, not once at the end: a run that dies on the sixth
    // company has already paid for the first five.
    await answers.save(ANSWERS_OUT);

    await sleep(PAUSE_MS);
  }

  await writeFile("out/summary.json", JSON.stringify({ builtAt: new Date().toISOString(), summary }, null, 2));
  await answers.save(ANSWERS_OUT);
  console.log(answers.line());
  // WHAT THIS RUN ACTUALLY DID, first. Three runs in a row were meant to
  // rebuild and merged instead, and the summary looked the same either way.
  const keptTotal = summary.reduce((n, s) => n + (s.carriedOver || 0), 0);
  const mode = (REBUILD
    ? "REBUILT: stored records ignored, every pair scored again."
    : "MERGED, not rebuilt: " + keptTotal + " stored pairs kept as they were.")
    + " Arguments received: " + (ARGS.join(" ") || "(none)") + "."
    // Which code ran, to match against the latest commit on GitHub, and when.
    + " Code: " + String(process.env.GITHUB_SHA || "local").slice(0, 7) + "."
    + " Run at " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC.";
  console.log(mode);
  await writeFile("out/summary.md", mode + "\n\n" + answers.line() + "\n\n" + markdownFor(summary, failures));

  // The silent-miss guard, carried over from the other product. A run where
  // everything failed must not look like a run where everything worked, or a
  // broken key sits there for a week producing empty records.
  if (failures === tickers.length) {
    throw new Error("Every company failed. Not writing this run off as a success.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
