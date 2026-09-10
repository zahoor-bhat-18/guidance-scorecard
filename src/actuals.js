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
 * Nothing checkable is asked for. The period is taken verbatim and resolved in
 * code against the fiscal-label logic already built and verified in xbrl.js.
 */
const SYSTEM = [
  "You read one company earnings press release and report ACTUAL REPORTED RESULTS.",
  "",
  "You are given a list of metrics. For each one, find the figure this release",
  "reports for the period that has just ENDED.",
  "",
  "A result is a figure for a completed period. A forecast, outlook, guidance or",
  "expectation is NOT a result. Never report one. If a metric appears only as a",
  "forecast, return it with value null.",
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
  "If a metric is genuinely absent, value null, found_as null, quote null.",
].join("\n");

async function callModel(env, requests, text) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set on the Worker.");

  const user = [
    "METRICS TO FIND:",
    JSON.stringify(requests.map((r) => ({
      metric_as_written: r.metric_as_written,
      basis: r.basis,
    }))),
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
    return {
      metric: req.metric,
      metric_as_written: req.metric_as_written,
      basis: req.basis,
      guided_unit: req.unit,
      found_as: row.found_as ?? null,
      period_text: row.period_text ?? null,
      value: typeof row.value === "number" ? row.value : null,
      unit: row.unit || null,
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
    actuals,
  };
}
