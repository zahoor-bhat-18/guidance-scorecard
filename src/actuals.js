/**
 * Actuals, from the earnings release.
 *
 * The companion to guidance.js, and the part that had to be conceded.
 *
 * XBRL holds actuals exactly, but only GAAP ones, and only weeks later when
 * the 10-Q is filed. Testing six large caps showed GAAP-only leaves four
 * scoreable guides across six companies: management guides adjusted EPS,
 * constant-currency sales and segment margin, and none of those is tagged
 * anywhere. So the non-GAAP actual comes out of the release, where it is
 * printed as a headline.
 *
 * This is narrow on purpose. It is not asked what the company reported. It is
 * asked, for a specific list of metrics guided a quarter ago, what the figure
 * turned out to be. A model given a shorter question gives a better answer,
 * and everything it is not asked for is one less thing to be wrong about.
 *
 * The filing is read through guidance.js now rather than by a private copy.
 * The duplication was there to stop a change to shared code silently changing
 * both extractions at once - but reading the whole 99-series is a fact about
 * the FILING, not about either extraction, and having the two disagree about
 * which documents exist would be worse than the risk it avoided.
 */

import { readFiling } from "./guidance.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

/**
 * Is this guide a level, or a change?
 *
 * The distinction the first version of this file lost, at real cost. Walmart
 * guided net sales to "increase 4.0% to 5.0%" and the answer came back as
 * 184,574 - a dollar figure, from a table row printing the quarter and the
 * year to date side by side. Both the kind of number and the column were
 * wrong, because the model was told the metric name and the basis and nothing
 * about what sort of answer the question had.
 *
 * A guide expressed as a change can only be answered by a change. There is no
 * conversion available: constant-currency growth cannot be recovered from a
 * reported level, and a percentage of revenue is not a revenue figure.
 */
function expectedAnswer(shape, unit) {
  const isChange = shape === "growth_range" || shape === "growth_point";
  if (isChange) {
    return {
      kind: "change",
      unit: "percent",
      describe: "a percentage CHANGE versus the prior year, not a dollar or share figure",
    };
  }
  if (unit === "percent") {
    return {
      kind: "ratio",
      unit: "percent",
      describe: "a percentage - a margin, rate or percentage of revenue, not an absolute figure",
    };
  }
  return {
    kind: "level",
    unit: unit || "other",
    describe: "an absolute figure reported in " + (unit || "the unit the release uses"),
  };
}

/**
 * The metric name, with the guidance stripped out of it.
 *
 * Broadcom returned zero actuals from three perfectly good guides, and the
 * model was right to return nothing. It had been asked to find "Third quarter
 * revenue guidance" in the third-quarter results - a metric whose name
 * contains the word guidance and a period label that is now in the past. There
 * is no such line in a results release, and an instruction elsewhere in the
 * prompt says never to report a forecast.
 *
 * The company's own words are still what gets matched on. Only the scaffolding
 * around them is removed: the period, and the words that mark it as an
 * expectation rather than a result.
 */
export function cleanMetricName(written) {
  let s = " " + String(written || "") + " ";

  s = s
    .replace(/\b(first|second|third|fourth)\s+quarter\b/gi, " ")
    .replace(/\bfourth\s+quarter\s+of\s+fiscal\s+year\s*\d{2,4}\b/gi, " ")
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

  // If stripping consumed the whole name, the original was nothing but
  // scaffolding and the original is still the better question.
  return s.length >= 3 ? s : String(written || "").trim();
}

/**
 * What to look for, built from the guides in the previous release.
 *
 * A guide with no number is not a request. There is nothing to score it
 * against, so looking for its actual spends a lookup to learn nothing.
 *
 * The test is the numbers themselves rather than the shape, which covers four
 * cases at once and cannot fall out of step with a shape added later:
 *
 *   reaffirmed  - unless its numbers were recovered from the quote
 *   withdrawn   - there is no guide any more
 *   qualitative - "up low-teens", or a figure the quote guard rejected
 *   anything else that arrived empty
 *
 * Delta's "Total Revenue YoY - up low-teens" went looking for an actual under
 * the old rule, found a real 19%, and had nothing to compare it to.
 */
export function requestsFrom(guides) {
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

    const key = query.toLowerCase() + "|" + (g.basis || "");
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      metric: g.metric || "other",
      metric_as_written: written,
      query,
      basis: g.basis || "unclear",
      unit: g.unit || "other",
      shape: g.shape || "point",
      expect: expectedAnswer(g.shape, g.unit),
    });
  }
  return out;
}

/**
 * The prompt.
 *
 * Deliberately short. The instruction that matters is the one separating a
 * result from a forecast, because a release states both, often in neighbouring
 * sentences, and reading a forecast as a result would have the product tell a
 * subscriber a company missed a number it has not yet reported.
 *
 * The second, added after the Walmart failure, is that each metric carries the
 * kind of answer it takes. A guide stated as a percentage increase is not
 * answered by a dollar figure, and a model that produces one anyway has not
 * found the actual - it has found a different number sitting near the right
 * label.
 *
 * Nothing checkable is asked for. The period is taken verbatim and resolved in
 * code against the fiscal-label logic proven in xbrl.js.
 */
const SYSTEM = [
  "You read one company earnings press release and report ACTUAL REPORTED RESULTS.",
  "",
  "You are given a list of metrics. Each carries an EXPECTS field saying what kind",
  "of number answers it. For each metric, find the figure this release reports for",
  "the period that has just ENDED.",
  "",
  "A result is a figure for a completed period. A forecast, outlook, guidance or",
  "expectation is NOT a result. Never report one. If a metric appears only as a",
  "forecast, return it with value null.",
  "",
  "The EXPECTS field is binding. If it asks for a percentage change and the release",
  "reports only an absolute figure, return null - do NOT return the absolute figure.",
  "If it asks for an absolute figure and only a percentage is reported, return null.",
  "A number of the wrong kind is not the actual, however close its label sits.",
  "",
  "Where a table prints several columns - the quarter and the year to date, or this",
  "year and last - the quarter just ended is the one wanted.",
  "",
  "Match on meaning, not on wording. 'Net sales' and 'total revenue' may be the same",
  "figure. 'Adjusted diluted EPS' and 'adjusted earnings per share' are the same. But",
  "an adjusted figure is never a substitute for a GAAP one, or the reverse.",
  "",
  "The document may contain several exhibits, separated by ===== markers. Read all.",
  "",
  "Return one row for EVERY metric you were given, in the same order, including the",
  "ones you could not find.",
  "",
  "Reply with JSON only. No prose, no markdown fences. Shape:",
  '{"actuals":[{',
  '  "metric": "the metric you were asked for, copied back unchanged",',
  '  "found_as": "what this release calls it, verbatim, or null",',
  '  "period_text": "the period as written, e.g. third quarter, full year 2025, or null",',
  '  "value": number or null,',
  '  "unit": "USD millions|USD billions|USD per share|percent|other",',
  '  "quote": "the sentence or table row it came from, verbatim, 40 words or fewer, or null"',
  "}]}",
  "",
  "Numbers exactly as written: $4.6 billion is value 4.6 with unit USD billions, not",
  "4600. A percentage is the number without the sign: 23.5.",
  "",
  "If a metric is genuinely absent, or only the wrong kind of number is reported,",
  "value null, found_as null, quote null.",
].join("\n");

async function callModel(env, requests, text) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set on the Worker.");

  const user = [
    "METRICS TO FIND:",
    JSON.stringify(requests.map((r) => ({
      metric: r.query,
      basis: r.basis,
      expects: r.expect.describe,
      expects_unit: r.expect.unit,
    })), null, 1),
    "",
    "RELEASE:",
    text,
  ].join("\n");

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

  if (!r.ok) {
    const body = await r.text();
    throw new Error("Model returned " + r.status + ": " + body.slice(0, 300));
  }

  const data = await r.json();
  const content = ((data.choices || [])[0] || {}).message?.content || "";
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
 * The expected unit is checked here as well as asked for in the prompt. An
 * instruction is a request; a check is a fact. Mismatches are reported rather
 * than dropped, because a mismatch is usually the model finding a real number
 * of the wrong kind, and seeing which number it found is how the next fix gets
 * written.
 */
export async function actualsFrom(env, cik, release, requests) {
  const filing = await readFiling(env, cik, release.accession);
  const rows = await callModel(env, requests, filing.text);

  // Rows are keyed back to what was asked for. The model is told to copy the
  // name unchanged and keep the order, and mostly does - but a row that cannot
  // be tied back to a request is not usable, so the request list leads and the
  // rows follow it.
  const byName = new Map();
  for (const row of rows) {
    const k = String(row.metric || row.metric_as_written || "").trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, row);
  }

  const actuals = requests.map((req, i) => {
    const row = byName.get(req.query.toLowerCase()) || rows[i] || {};
    const value = typeof row.value === "number" ? row.value : null;
    const unit = row.unit || null;

    const wantedPercent = req.expect.unit === "percent";
    const gotPercent = unit === "percent";
    const unitMismatch = value !== null && Boolean(unit) && wantedPercent !== gotPercent;

    return {
      metric: req.metric,
      metric_as_written: req.metric_as_written,
      asked_as: req.query,
      basis: req.basis,
      guided_shape: req.shape,
      guided_unit: req.unit,
      expected: req.expect.describe,
      found_as: row.found_as ?? null,
      period_text: row.period_text ?? null,
      value,
      unit,
      unit_mismatch: unitMismatch,
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
    found: actuals.filter((a) => a.value !== null).length,
    unitMismatches: actuals.filter((a) => a.unit_mismatch).length,
    actuals,
  };
}
