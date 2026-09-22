/**
 * Actuals, from the earnings release.
 *
 * The companion to guidance.js, and the part that had to be conceded.
 *
 * XBRL holds actuals exactly, but only GAAP ones, and only weeks later when
 * the 10-Q is filed. Six large caps produced four GAAP-scoreable guides
 * between them: management guides adjusted EPS, constant-currency sales and
 * segment margin, and none of those is tagged anywhere.
 *
 * Narrow on purpose. It is not asked what the company reported. It is asked,
 * for a specific list of metrics guided a quarter ago, what the figure turned
 * out to be.
 */

import { readFiling } from "./guidance.js";
import { resolvePeriod, periodReportedBy } from "./period.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

/* ------------------------------------------------------------------ *
 * Basis: which version of the measure
 * ------------------------------------------------------------------ */

/**
 * Which flavour of a measure is this label talking about?
 *
 * Written after a pair that looked right and was not. Walmart guided
 * "Operating income (cc) Increase 7.0% to 10.0%" and the release reports
 * operating income of $9,248m. Turning that into growth needs last year, and
 * the release gives two: $7,286m as originally reported, and $7,876m with
 * one-off charges stripped out. Same numerator, two bases, 26.9% or 17.4%.
 *
 * The guide meant 17.4% - the release says so in its own narrative for the
 * equivalent next-quarter guide, where it writes "adjusted operating income to
 * grow 2.0% to 4.0%". The guidance TABLE just says "Operating income (cc)".
 * The word adjusted is missing from the label and present in the sentence.
 *
 * So label matching alone is not enough, and the extractor took 26.9% while
 * matching the label exactly. The email would have reported a vast beat.
 *
 * Two dimensions, and both have to agree:
 *   adjustment - adjusted, core, underlying, excluding something, versus as
 *                reported
 *   currency   - constant currency versus reported
 *
 * Walmart's guide was adjusted AND constant currency. The figure taken was
 * constant currency but not adjusted. One of two matched, which is exactly why
 * it survived every other check.
 */
function markers(text) {
  const s = String(text || "");
  return {
    adjusted: /\badj(?:\.|usted)?\b|non-?gaap|\bcore\b|\bunderlying\b|excluding/i.test(s),
    cc: /\(cc\)|constant[-\s]currency/i.test(s),
    gaap: /\bgaap\b/i.test(s) && !/non-?gaap/i.test(s),
  };
}

/* Measures with no adjusted version to confuse. Revenue is revenue - there is
   no adjusted revenue, which is part of why it survives a GAAP-only scorecard
   when nothing else does. Asking these to carry an "adjusted" marker would
   reject every one of them. */
const NO_ADJUSTED_VERSION = new Set(["revenue", "capex", "operating_cash_flow"]);

function exemptFromAdjustment(metric, label) {
  if (NO_ADJUSTED_VERSION.has(metric)) return true;
  return /comparable sales|comp sales|net sales|\brevenue\b|capacity|capital expenditure/i
    .test(String(label || ""));
}

/**
 * What basis does this guide expect its actual to be on?
 *
 * The rule, and it follows how US companies actually guide: if the guide says
 * GAAP, it means GAAP. Otherwise it means adjusted, because adjusted is what
 * management guides and what the market judges them on. A bare "operating
 * income" in a guidance table is the adjusted one.
 *
 * Constant currency is simpler - it is only expected when the guide says so.
 */
function expectedBasis(guide) {
  const label = String(guide.metric_as_written || "");
  const mk = markers(label + " " + String(guide.quote || ""));
  const metric = guide.metric || "other";

  const exempt = exemptFromAdjustment(metric, label);
  const wantsAdjusted = !exempt && !mk.gaap;

  return {
    wantsAdjusted,
    wantsCC: mk.cc,
    exempt,
    describe: [
      wantsAdjusted ? "the ADJUSTED (non-GAAP) version" : mk.gaap ? "the GAAP version" : "the figure as reported",
      mk.cc ? "in CONSTANT CURRENCY" : null,
    ].filter(Boolean).join(", "),
  };
}

/**
 * The period the actual must be for, in words.
 *
 * The omission that wasted an entire backfill. Every one of Macy's 34 pairs
 * was rejected for a period mismatch, and the mismatch was this prompt's
 * fault: it asked for "the period that has just ENDED" and added that where a
 * table shows several columns the quarter is the one wanted.
 *
 * Macy's guides the full year. Its March release reports the fourth quarter
 * AND the full year, on the same page, in the same table. Asked for the
 * quarter, the model correctly returned the quarter - against a full-year
 * guide, which the pairing then refused. Three years of full-year outcomes
 * were sitting in those filings and none of them was ever looked for.
 *
 * So the period is named. Not as a label the release would never print, but
 * described the way the company writes it, and the model is told to return
 * nothing rather than substitute a different period.
 */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * The month a fiscal quarter ends in, from the company's own year end.
 *
 * Delta's year ends in December, so its second quarter ends in June. Walmart's
 * ends in January, so its second quarter ends in July. Broadcom's ends in
 * early November, so its second quarter ends in May.
 */
function quarterEndMonth(quarter, cal) {
  if (!cal || !cal.fye || typeof cal.fye.month !== "number") return null;
  const back = (4 - quarter) * 3;
  return MONTH_NAMES[((cal.fye.month - back - 1) % 12 + 12) % 12];
}

function describePeriod(period, cal) {
  const m = String(period || "").match(/^(\d{4})(FY|Q([1-4]))$/);
  if (!m) return null;

  const year = m[1];
  if (m[2] === "FY") {
    return "the FULL FISCAL YEAR that the company labels " + year
      + " - the twelve-month or 52-week figure, NOT the fourth quarter";
  }

  const quarter = parseInt(m[3], 10);
  const ordinal = { 1: "first", 2: "second", 3: "third", 4: "fourth" }[quarter];

  /**
   * NAMED THE WAY THE COMPANY NAMES IT, not only by its ordinal.
   *
   * Delta's July 2024 release reports revenue up 5.4% and adjusted earnings per
   * share of $2.36, in plain bullets, on the first page. The model was asked
   * for "the second quarter of the fiscal year the company labels 2024" and
   * returned nothing at all - five of six requests came back empty against a
   * document that had the answers.
   *
   * The release never says "second quarter". It says "June quarter 2024",
   * eleven times, including in its own headline. Told to find a period that
   * does not appear in the text, the model reported no period rather than
   * substituting one - which is the behaviour it was asked for.
   *
   * So the quarter is described both ways. The ordinal stays first, because it
   * is what most filers print; the month-ended form follows, computed from the
   * company's own year end rather than guessed.
   */
  const month = quarterEndMonth(quarter, cal);
  const alias = month
    ? ", which this company may call the " + month + " quarter or the quarter ended in "
      + month + ","
    : "";

  return "the " + ordinal + " quarter of the fiscal year the company labels " + year
    + alias + " - that quarter alone, not the year to date and not the full year";
}

/**
 * Is this guide a level, or a change?
 *
 * Walmart guided net sales to "increase 4.0% to 5.0%" and the answer came back
 * as 184,574 - a dollar figure, from a table row printing the quarter and the
 * year to date side by side. The model had been told the metric name and the
 * basis and nothing about what sort of answer the question had.
 *
 * The fix then assumed every change is a percentage, which was wrong the other
 * way: "Interest, net Increase approximately $200M to $300M" is a change
 * measured in dollars, and asking for a percentage produced -74.7%. So a
 * change keeps the unit the company guided it in.
 */
function expectedAnswer(shape, unit) {
  const isChange = shape === "growth_range" || shape === "growth_point";

  if (isChange && unit === "percent") {
    return {
      kind: "change", unit: "percent",
      describe: "a percentage CHANGE versus the prior year, not a dollar or share figure",
    };
  }
  if (isChange) {
    return {
      kind: "change", unit: unit || "other",
      describe: "the CHANGE versus the prior year, measured in " + (unit || "the unit the release uses")
        + " - the movement, not the level",
    };
  }
  if (unit === "percent") {
    return {
      kind: "ratio", unit: "percent",
      describe: "a percentage - a margin, rate or percentage of revenue, not an absolute figure",
    };
  }
  return {
    kind: "level", unit: unit || "other",
    describe: "an absolute figure reported in " + (unit || "the unit the release uses"),
  };
}

/**
 * The metric name, with the guidance stripped out of it.
 *
 * Broadcom returned zero actuals from three good guides, and the model was
 * right to return nothing: it had been asked to find "Third quarter revenue
 * guidance" in the third-quarter results - a metric whose name contains the
 * word guidance and a period now in the past.
 */
export function cleanMetricName(written) {
  const s = (" " + String(written || "") + " ")
    .replace(/\b(first|second|third|fourth)\s+quarter\b/gi, " ")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+quarter\b/gi, " ")
    .replace(/\bof\s+fiscal\s+year\s*\d{2,4}\b/gi, " ")
    .replace(/\bfiscal\s+(year\s+)?\d{2,4}\b/gi, " ")
    .replace(/\bfull[-\s]?year\b/gi, " ")
    .replace(/\b[1-4]Q\s?\d{0,4}\b/gi, " ")
    .replace(/\bQ[1-4]\b/gi, " ")
    .replace(/\bFY\s?\d{2,4}\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(guidance|outlook|forecast|expectations?|expected|projected)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .trim();

  return s.length >= 3 ? s : String(written || "").trim();
}

/**
 * What to look for, built from the guides in the previous release.
 *
 * A guide with no number is not a request. There is nothing to score it
 * against, so looking for its actual spends a lookup to learn nothing. The
 * test is the numbers themselves rather than the shape, which covers
 * reaffirmed, withdrawn, qualitative and anything empty in one rule.
 */
export function requestsFrom(guides, cal) {
  const seen = new Set();
  const out = [];

  for (const g of guides || []) {
    const hasNumber =
      typeof g.low === "number" ||
      typeof g.high === "number" ||
      typeof g.value === "number";
    if (!hasNumber) continue;

    const written = String(g.metric_as_written || "").trim();
    if (!written) continue;

    const query = cleanMetricName(written);
    const key = query.toLowerCase() + "|" + (g.basis || "") + "|" + (g.period || "");
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      metric: g.metric || "other",
      metric_as_written: written,
      query,
      basis: g.basis || "unclear",
      unit: g.unit || "other",
      shape: g.shape || "point",
      guidePeriod: g.period || null,
      periodWanted: describePeriod(g.period, cal),
      expect: expectedAnswer(g.shape, g.unit),
      expectBasis: expectedBasis(g),
    });
  }
  return out;
}

const SYSTEM = [
  "You read one company earnings press release and report ACTUAL REPORTED RESULTS.",
  "",
  "You are given a list of metrics. Each carries three binding fields:",
  "  PERIOD  - which period the figure must cover",
  "  BASIS   - which version of the measure",
  "  EXPECTS - what kind of number answers it",
  "",
  "A result is a figure for a completed period. A forecast, outlook, guidance or",
  "expectation is NOT a result. Never report one. If a metric appears only as a",
  "forecast, return it with value null.",
  "",
  "PERIOD is the field most easily got wrong. A release reporting a fourth quarter",
  "also reports the full year, in the same table, and they are different numbers.",
  "Find the period asked for. If the release does not report that period, return",
  "null - never substitute a different period, however adjacent.",
  "",
  "BASIS: a release often reports the same measure twice - as reported and",
  "adjusted, reported currency and constant currency. Take the one asked for. If",
  "it asks for adjusted and only an as-reported figure exists, return null.",
  "",
  "HEADINGS: many releases list results as short lines under a heading, and the",
  "HEADING states the period and the basis for every line beneath it. For example:",
  "  June Quarter 2024 GAAP Financial Results",
  "    Earnings per share of $2.01",
  "  June Quarter 2024 Adjusted Financial Results",
  "    Earnings per share of $2.36",
  "Both lines say only 'Earnings per share', but the second is the adjusted figure",
  "for the June quarter because its heading says so. Asked for adjusted EPS, the",
  "answer is 2.36. Use the heading to tell them apart; do not return null because",
  "the line itself repeats. Put that heading, verbatim, in section, and take",
  "period_text from it when the line does not state a period of its own. A release",
  "that also has a 'Full Year' heading reports the full year there - never answer",
  "a quarter with a figure from under a full-year heading.",
  "",
  "EXPECTS: if it asks for a change and the release reports only a level, return",
  "null - do NOT return the level. If it asks for a figure in one unit and only",
  "another unit is reported, return null. A number of the wrong kind is not the",
  "actual, however close its label sits.",
  "",
  "period_text is REQUIRED whenever value is not null. Say which period the figure",
  "you took actually belongs to, in the release's own words - it is checked against",
  "what was asked for. A figure with no period cannot be used and is discarded, so",
  "returning one without the other wastes the answer.",
  "",
  "Match on meaning, not on wording. 'Net sales' and 'total revenue' may be the same",
  "figure. 'Adjusted diluted EPS' and 'adjusted earnings per share' are the same.",
  "",
  "The document may contain several exhibits, separated by ===== markers. Read all.",
  "",
  "Return one row for EVERY metric you were given, in the same order, including the",
  "ones you could not find.",
  "",
  "Reply with JSON only. No prose, no markdown fences. Shape:",
  '{"actuals":[{',
  '  "id": the id of the request this answers, copied back unchanged,',
  '  "metric": "the metric you were asked for, copied back unchanged",',
  '  "found_as": "what this release calls it, verbatim, or null",',
  '  "section": "the heading the figure sits under, verbatim, or null",',
  '  "period_text": "the period the figure covers, in the release\'s words, or null",',
  '  "value": number or null,',
  '  "unit": "USD millions|USD billions|USD per share|percent|multiple|other",',
  '  "quote": "the sentence or table row it came from, verbatim, 40 words or fewer, or null"',
  "}]}",
  "",
  "Numbers exactly as written: $4.6 billion is value 4.6 with unit USD billions, not",
  "4600. A percentage is the number without the sign: 23.5.",
  "",
  "If a metric is genuinely absent, or the release reports only the wrong period,",
  "wrong basis or wrong kind of number, value null, found_as null, quote null.",
].join("\n");

/**
 * Which model reads the release for actuals.
 *
 * DeepSeek by default. Gemini when ACTUALS_MODEL is "gemini", or when the
 * diagnostic route is asked for it with ?model=gemini.
 *
 * Switchable rather than switched, because the evidence so far is one release.
 * Delta's March quarter 2026 release prints "Earnings per share of $0.64" under
 * "March Quarter 2026 Non-GAAP Financial Results", in the first fifty lines, and
 * DeepSeek returned nothing for it with the heading instruction in place and the
 * basis check able to read the heading. The prompt was not the problem and the
 * pipeline was not the problem. Whether a different model is the answer is a
 * question for the same release, run both ways, not for a changed default.
 */
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = (model, key) =>
  "https://generativelanguage.googleapis.com/v1beta/models/"
  + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);

function providerOf(env) {
  return String(env.ACTUALS_MODEL || "deepseek").toLowerCase() === "gemini" ? "gemini" : "deepseek";
}

async function askDeepSeek(env, user) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set.");

  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.DEEPSEEK_API_KEY,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });

  if (!r.ok) throw new Error("DeepSeek returned " + r.status + ": " + (await r.text()).slice(0, 300));
  const data = await r.json();
  return ((data.choices || [])[0] || {}).message?.content || "";
}

/* The same request shape the earlier scorecard used for Gemini, where it ran
   as a fallback: the system instruction goes separately from the
   conversation, and JSON is asked for by MIME type rather than by format. */
async function askGemini(env, user) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");

  const r = await fetch(GEMINI_ENDPOINT(env.GEMINI_MODEL || GEMINI_MODEL, env.GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  const body = await r.text();
  if (!r.ok) throw new Error("Gemini returned " + r.status + ": " + body.slice(0, 300));

  const data = JSON.parse(body);
  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error("Gemini returned no candidate: " + body.slice(0, 300));
  return ((cand.content && cand.content.parts) || []).map((x) => x.text || "").join("").trim();
}

async function callModel(env, requests, text) {
  const user = [
    "METRICS TO FIND:",
    JSON.stringify(requests.map((r, i) => ({
      id: i,
      metric: r.query,
      period: r.periodWanted || "the period that has just ended",
      basis: r.expectBasis.describe,
      expects: r.expect.describe,
      expects_unit: r.expect.unit,
    })), null, 1),
    "",
    "RELEASE:",
    text,
  ].join("\n");

  const content = providerOf(env) === "gemini"
    ? await askGemini(env, user)
    : await askDeepSeek(env, user);
  const clean = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error("Model did not return JSON: " + clean.slice(0, 300));
  }

  return Array.isArray(parsed.actuals) ? parsed.actuals : [];
}

/**
 * One release and a list of metrics in, the reported figures out.
 *
 * Every requested metric comes back whether found or not. A missing row and a
 * row reporting nothing must not look the same: the first is the model
 * ignoring an instruction, the second is a fact about the release.
 *
 * The basis is checked here as well as asked for in the prompt, and the check
 * is the part that matters. An instruction can be ignored; a check cannot. The
 * Walmart pair that survived everything else was found under a label that
 * matched exactly, and only comparing the markers in that label against the
 * markers in the guide catches it.
 */
export async function actualsFrom(env, cik, release, requests, cal) {
  const filing = await readFiling(env, cik, release.accession);
  const rows = await callModel(env, requests, filing.text);

  /**
   * EACH ANSWER IS MATCHED TO ITS REQUEST BY ID, NOT BY NAME.
   *
   * Matching by name alone handed one answer to two questions. Delta's release
   * is asked for "Earnings Per Share" twice - the quarter and the full year -
   * and the model returns two rows, both named "Earnings Per Share". The map
   * kept the first and gave it to both requests. When the full-year row came
   * first it was empty, because the year had not ended, and the quarter lost a
   * figure printed plainly on page one: "Earnings per share of $0.64". When it
   * came first carrying a value, the quarter was handed the year: Delta's
   * fourth-quarter EPS guide of $1.60 to $1.90 was scored against $5.82, the
   * full-year figure, and flagged as a 205% beat.
   *
   * Two different models failed this identically, which is what gave it away.
   * The fault was never in the reading.
   *
   * So every request carries an id and the model copies it back. The name is a
   * fallback only when it is unambiguous - when exactly one request and one
   * answer share it. Position is the last resort, as before.
   */
  const byId = new Map();
  const byName = new Map();
  const nameCount = new Map();
  for (const row of rows) {
    if (row.id !== undefined && row.id !== null && !byId.has(Number(row.id))) {
      byId.set(Number(row.id), row);
    }
    const k = String(row.metric || row.metric_as_written || "").trim().toLowerCase();
    if (!k) continue;
    nameCount.set(k, (nameCount.get(k) || 0) + 1);
    if (!byName.has(k)) byName.set(k, row);
  }
  const askedCount = new Map();
  for (const req of requests) {
    const k = req.query.toLowerCase();
    askedCount.set(k, (askedCount.get(k) || 0) + 1);
  }

  const actuals = requests.map((req, i) => {
    const k = req.query.toLowerCase();
    const nameIsUnique = nameCount.get(k) === 1 && askedCount.get(k) === 1;
    const row = byId.get(i) || (nameIsUnique ? byName.get(k) : null) || rows[i] || {};
    const value = typeof row.value === "number" ? row.value : null;
    const unit = row.unit || null;

    const wantedPercent = req.expect.unit === "percent";
    const gotPercent = unit === "percent";
    const unitMismatch = value !== null && Boolean(unit) && wantedPercent !== gotPercent;

    // What the release called the figure that was taken. The quote is included
    // because a table row often carries the qualifier the label omits.
    /* The heading is read as well as the label and the line.
     *
     * Delta lists results as bullets under "June Quarter 2024 Adjusted
     * Financial Results", and the bullet reads only "Earnings per share of
     * $2.36". This check looked for the word adjusted in the label and the
     * line, found it in neither, and refused the correct adjusted figure as
     * "the figure taken is as reported" - even on the runs where the model had
     * found exactly the right number. The basis was stated; it was stated one
     * line up. */
    const found = markers(String(row.found_as || "") + " " + String(row.section || "")
      + " " + String(row.quote || ""));

    let basisMismatch = null;
    if (value !== null && row.found_as) {
      if (req.expectBasis.wantsAdjusted && !found.adjusted) {
        basisMismatch = "The guide is on an adjusted basis and the figure taken is as reported.";
      } else if (!req.expectBasis.wantsAdjusted && !req.expectBasis.exempt && found.adjusted) {
        basisMismatch = "The guide is on a GAAP basis and the figure taken is adjusted.";
      } else if (req.expectBasis.wantsCC && !found.cc) {
        basisMismatch = "The guide is in constant currency and the figure taken is not.";
      }
    }

    let resolved = cal
      ? resolvePeriod(row.period_text, cal, { referenceDate: release.filed, direction: "past" })
      : { period: null, why: "No fiscal calendar was supplied." };

    /* The period the release must be reporting, when the stated one cannot be
     * used.
     *
     * The first version only fired when the period text was MISSING, and it
     * almost never was. Broadcom returns wording we cannot parse rather than
     * no wording at all, so nine answers a run fell through a recovery written
     * for a case that barely happens.
     *
     * So it fires whenever the period is unresolved - absent, unparseable, or
     * a phrase never met before.
     *
     * With one exception, and it is the important one. If the stated text says
     * the figure covers a year-to-date or half-year span, that is not a period
     * we failed to read, it is the WRONG period honestly reported. Overriding
     * it would pair a six-month figure against a quarterly guide, which is the
     * failure this whole product is built to avoid. Those stay refused.
     */
    let periodAssumed = false;
    if (cal && value !== null && !resolved.period) {
      /* Only text that names a year-to-date span AND NOTHING ELSE counts as
       * honestly reporting the wrong period.
       *
       * "three and nine months ended August 2, 2026" is a table HEADER: the
       * table carries the quarter and the year to date side by side, and the
       * figure taken is almost certainly the quarter. Refusing it because the
       * words "nine months" appear throws away the answer over wording that
       * describes the table rather than the figure. */
      const stated = String(row.period_text || "");
      const namesYtd = /year[-\s]to[-\s]date|six months|nine months|26 weeks|39 weeks|half[-\s]year/i.test(stated);
      // "three AND nine months" is the wording, not "three months" - the first
      // attempt missed it and refused the very case it was written for.
      const namesQuarter =
        /three months|13 weeks|quarter|three\s+and\s+(six|nine)\s+months|13\s+and\s+(26|39)\s+weeks/i
          .test(stated);
      const statedWrongSpan = namesYtd && !namesQuarter;

      if (!statedWrongSpan) {
        const fromFiling = periodReportedBy(release.filed, cal);
        if (fromFiling) {
          resolved = {
            period: fromFiling,
            how: "the stated period could not be read"
              + (row.period_text ? ' ("' + row.period_text + '")' : " and none was given")
              + ", so the quarter this release reports was taken from its filing date",
          };
          periodAssumed = true;
        }
      }
    }

    return {
      metric: req.metric,
      metric_as_written: req.metric_as_written,
      asked_as: req.query,
      basis: req.basis,
      expected_basis: req.expectBasis.describe,
      guided_shape: req.shape,
      guided_unit: req.unit,
      guide_period: req.guidePeriod,
      period_wanted: req.periodWanted,
      expected: req.expect.describe,
      found_as: row.found_as ?? null,
      section: row.section ?? null,
      period_text: row.period_text ?? null,
      period: resolved.period,
      period_assumed: periodAssumed,
      period_how: resolved.how || null,
      period_why: resolved.why || null,
      value,
      unit,
      unit_mismatch: unitMismatch,
      basis_mismatch: basisMismatch,
      quote: row.quote ?? null,
    };
  });

  return {
    release: {
      accession: release.accession,
      filed: release.filed,
      items: release.items,
      pickedBy: filing.pickedBy,
      files: filing.files,
      textChars: filing.chars,
    },
    requested: requests.length,
    model: providerOf(env) === "gemini" ? (env.GEMINI_MODEL || GEMINI_MODEL) : MODEL,
    found: actuals.filter((a) => a.value !== null).length,
    unitMismatches: actuals.filter((a) => a.unit_mismatch).length,
    basisMismatches: actuals.filter((a) => a.basis_mismatch).length,
    actuals,
  };
}
