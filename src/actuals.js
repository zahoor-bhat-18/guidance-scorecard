/**
 * Actuals, from the earnings release.
 *
 * The companion to guidance.js, and the part that had to be conceded.
 *
 * XBRL holds actuals exactly, but only GAAP ones, and only weeks later when
 * the 10-Q is filed. Testing six large caps showed that GAAP-only leaves four
 * scoreable guides across six companies: management guides adjusted EPS,
 * constant-currency sales and segment margin, and none of those is tagged
 * anywhere. So the non-GAAP actual has to come out of the release, where it is
 * printed as a headline.
 *
 * This is narrow on purpose. It is not asked what the company reported. It is
 * asked, for a specific list of metrics that were guided a quarter ago, what
 * the figure turned out to be. A model given a shorter question gives a better
 * answer, and everything it is not asked for is one less thing to be wrong
 * about.
 *
 * Nothing here scores, matches or judges. It reads figures and reports them
 * with the sentence they came from.
 *
 * NOTE: pickExhibit and htmlToText are deliberate copies of the versions in
 * guidance.js. Sharing them would mean editing a file that works, for the sake
 * of a second fetch that EDGAR serves from cache anyway. They get merged once
 * both extractions are proven, not before.
 */

import { secJson } from "./sec.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MAX_CHARS = 80000;

/* --- copies of guidance.js internals, to be merged later --- */

async function pickExhibit(env, cik, accession) {
  const noDash = accession.replace(/-/g, "");
  const base = "https://www.sec.gov/Archives/edgar/data/" + Number(cik) + "/" + noDash;
  const dir = await secJson(env, base + "/index.json");
  const items = ((dir.directory && dir.directory.item) || [])
    .filter((f) => /\.html?$/i.test(f.name) && !/-index/i.test(f.name));

  if (!items.length) throw new Error("No HTML document in filing " + accession + ".");

  const named = items.filter((f) => /(^|[^0-9])99[._-]?1([^0-9]|$)|ex-?99/i.test(f.name));
  const pool = named.length ? named : items;
  pool.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));

  return {
    url: base + "/" + pool[0].name,
    file: pool[0].name,
    bytes: Number(pool[0].size || 0),
    pickedBy: named.length ? "exhibit 99.1 by filename" : "largest HTML in the filing",
  };
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8212;|&mdash;/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/* --- end copies --- */

/**
 * Is this guide a level, or a change?
 *
 * The distinction the first version of this file lost, at real cost. Walmart
 * guided net sales to "increase 4.0% to 5.0%" and the answer came back as
 * 184,574 - a dollar figure, from a table row printing the quarter and the
 * year to date side by side. Both the kind of number and the column were
 * wrong, and the reason is that the model was told the metric name and the
 * basis and nothing about what sort of answer the question had.
 *
 * A guide expressed as a change can only be answered by a change. There is no
 * conversion available here: constant-currency growth cannot be recovered from
 * a reported level, and a percentage of revenue is not a revenue figure.
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
 * What to look for, built from the guides in the previous release.
 *
 * Deduplicated on how the company writes the metric, not on the internal
 * name, because a company that guided a quarter and a year for the same
 * measure wrote it once and means one thing.
 *
 * Reaffirmations and withdrawals carry no number and are dropped: there is
 * nothing to find an actual for.
 */
export function requestsFrom(guides) {
  const seen = new Set();
  const out = [];

  for (const g of guides || []) {
    if (g.shape === "reaffirmed" || g.shape === "withdrawn") continue;

    const written = String(g.metric_as_written || "").trim();
    if (!written) continue;

    const key = written.toLowerCase() + "|" + (g.basis || "");
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      metric: g.metric || "other",
      metric_as_written: written,
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
 * Deliberately short. The single instruction that matters is the one
 * separating a result from a forecast, because a release states both, often in
 * neighbouring sentences, and reading a forecast as a result would have the
 * product tell a subscriber a company missed a number it has not yet reported.
 *
 * The second instruction, added after the Walmart failure, is that each metric
 * comes with the kind of answer it takes. A guide stated as a percentage
 * increase is not answered by a dollar figure, and a model that produces one
 * anyway has not found the actual - it has found a different number that
 * happens to sit near the right label.
 *
 * Nothing checkable is asked for. The period is taken verbatim and resolved in
 * code against the fiscal-label logic already built and verified in xbrl.js.
 */
const SYSTEM = [
  "You read one company earnings press release and report ACTUAL REPORTED RESULTS.",
  "",
  "You are given a list of metrics. Each one carries an EXPECTS field saying what",
  "kind of number answers it. For each metric, find the figure this release reports",
  "for the period that has just ENDED.",
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
  "Match on meaning, not on wording. 'Net sales' and 'total revenue' may be the",
  "same figure. 'Adjusted diluted EPS' and 'adjusted earnings per share' are the",
  "same. But an adjusted figure is never a substitute for a GAAP one, or the",
  "reverse.",
  "",
  "Prefer the current-period figure over the prior-year comparative. Releases",
  "print them side by side, and the prior-year column is not the result.",
  "",
  "Return one row for EVERY metric you were given, in the same order, including",
  "the ones you could not find.",
  "",
  "Reply with JSON only. No prose, no markdown fences. Shape:",
  '{"actuals":[{',
  '  "metric_as_written": "the metric you were asked for, copied back unchanged",',
  '  "found_as": "what this release calls it, verbatim, or null",',
  '  "period_text": "the period as written, e.g. third quarter, full year 2025, or null",',
  '  "value": number or null,',
  '  "unit": "USD millions|USD billions|USD per share|percent|other",',
  '  "quote": "the sentence or table row it came from, verbatim, 40 words or fewer, or null"',
  "}]}",
  "",
  "Numbers exactly as written: $4.6 billion is value 4.6 with unit USD billions,",
  "not 4600. A percentage is the number without the sign: 23.5.",
  "",
  "If a metric is genuinely absent, or only the wrong kind of number is reported,",
  "value null, found_as null, quote null.",
].join("\n");

async function callModel(env, requests, text) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set on the Worker.");

  const user = [
    "METRICS TO FIND:",
    JSON.stringify(requests.map((r) => ({
      metric_as_written: r.metric_as_written,
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
 * Every requested metric comes back whether it was found or not. A missing row
 * and a row reporting nothing must not look the same: the first is the model
 * ignoring an instruction, the second is a fact about the release.
 *
 * The expected unit is checked here as well as asked for in the prompt. An
 * instruction is a request; a check is a fact. Mismatches are reported rather
 * than dropped, because a mismatch is usually the model finding a real number
 * of the wrong kind, and seeing which number it found is how the next fix gets
 * written.
 *
 * Fails loudly on a failed call, for the same reason guidance.js does.
 */
export async function actualsFrom(env, cik, release, requests) {
  const exhibit = await pickExhibit(env, cik, release.accession);

  const res = await fetch(exhibit.url, {
    headers: { "User-Agent": env.SEC_USER_AGENT, Accept: "text/html" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) throw new Error("EDGAR " + res.status + " for " + exhibit.file);

  const full = htmlToText(await res.text());
  const truncated = full.length > MAX_CHARS;
  const text = truncated ? full.slice(0, MAX_CHARS) : full;

  const rows = await callModel(env, requests, text);

  // Returned rows are keyed back to what was asked for. The model is told to
  // copy the name unchanged and to keep the order, and mostly does - but a row
  // that cannot be tied back to a request is not usable, so the request list
  // leads and the rows follow it.
  const byName = new Map();
  for (const row of rows) {
    const k = String(row.metric_as_written || "").trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, row);
  }

  const actuals = requests.map((req, i) => {
    const row = byName.get(req.metric_as_written.toLowerCase()) || rows[i] || {};
    const value = typeof row.value === "number" ? row.value : null;
    const unit = row.unit || null;

    // A percentage answer to a percentage question is the same kind of number
    // even when one says "percent" and the other says "percent change"; a
    // dollar answer to a percentage question is not.
    const wantedPercent = req.expect.unit === "percent";
    const gotPercent = unit === "percent";
    const unitMismatch = value !== null && Boolean(unit) && wantedPercent !== gotPercent;

    return {
      metric: req.metric,
      metric_as_written: req.metric_as_written,
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
      exhibit: exhibit.file,
      pickedBy: exhibit.pickedBy,
      bytes: exhibit.bytes,
      textChars: full.length,
      truncated,
    },
    requested: requests.length,
    found: actuals.filter((a) => a.value !== null).length,
    unitMismatches: actuals.filter((a) => a.unit_mismatch).length,
    actuals,
  };
}
