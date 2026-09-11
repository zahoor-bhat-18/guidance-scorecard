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
import { resolvePeriod } from "./period.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

/**
 * What kind of number answers this guide?
 *
 * The distinction the first version lost, at real cost. Walmart guided net
 * sales to "increase 4.0% to 5.0%" and the answer came back as 184,574 - a
 * dollar figure, from a table row printing the quarter and the year to date
 * side by side. The model had been told the metric name and the basis and
 * nothing about what sort of answer the question had.
 *
 * The fix then assumed every change is a percentage, and that was wrong in the
 * other direction. Walmart also guides "Interest, net Increase approximately
 * $200M to $300M" - a change measured in dollars. Asked for a percentage, the
 * model returned -74.7%, a real number from the right row and no answer to the
 * question.
 *
 * So a change keeps the unit the company guided it in. The only thing the
 * shape decides is whether the answer is a movement or a position.
 */
function expectedAnswer(shape, unit) {
  const isChange = shape === "growth_range" || shape === "growth_point";

  if (isChange && unit === "percent") {
    return {
      kind: "change",
      unit: "percent",
      describe: "a percentage CHANGE versus the prior year, not a dollar or share figure",
    };
  }
  if (isChange) {
    return {
      kind: "change",
      unit: unit || "other",
      describe: "the CHANGE versus the prior year, measured in " + (unit || "the unit the release uses")
        + " - the movement, not the level",
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
 * contains the word guidance and a period label now in the past.
 *
 * The company's own words are still what gets matched on. Only the scaffolding
 * around them is removed.
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
 * reaffirmed, withdrawn, qualitative and anything that arrived empty in one
 * rule.
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
      expect: expectedAnswer(g.shape, g.unit),
    });
  }
  return out;
}

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
  "The EXPECTS field is binding. If it asks for a change and the release reports",
  "only a level, return null - do NOT return the level. If it asks for a figure in",
  "one unit and only another unit is reported, return null. A number of the wrong",
  "kind is not the actual, however close its label sits.",
  "",
  "Where a table prints several columns - the quarter and the year to date, or this",
  "year and last - the quarter just ended is the one wanted. Say in period_text",
  "which period the figure you took belongs to.",
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
 * Each row carries a resolved period, read BACKWARD - an actual reports a
 * period that has ended. Without it, Walmart's full-year reaffirmations were
 * answered with quarterly figures and every one would have scored as a wild
 * beat or miss.
 *
 * The calendar passed in must be the one the guidance call refined, not a
 * fresh one. Two sides disagreeing about the fiscal convention would put every
 * pair a year apart.
 */
export async function actualsFrom(env, cik, release, requests, cal) {
  const filing = await readFiling(env, cik, release.accession);
  const rows = await callModel(env, requests, filing.text);

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

    const resolved = cal
      ? resolvePeriod(row.period_text, cal, { referenceDate: release.filed, direction: "past" })
      : { period: null, why: "No fiscal calendar was supplied." };

    return {
      metric: req.metric,
      metric_as_written: req.metric_as_written,
      asked_as: req.query,
      basis: req.basis,
      guided_shape: req.shape,
      guided_unit: req.unit,
      guide_period: req.guidePeriod,
      expected: req.expect.describe,
      found_as: row.found_as ?? null,
      period_text: row.period_text ?? null,
      period: resolved.period,
      period_how: resolved.how || null,
      period_why: resolved.why || null,
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
