/**
 * Guidance, from the earnings release.
 *
 * The other half. XBRL cannot carry guidance: nobody tags a forecast, and a
 * forecast is prose. So this is the one place a model is unavoidable - and it
 * is deliberately the ONLY place. Actuals never come through here.
 *
 * The old product asked one model call to read a release for guidance AND
 * actuals, and got both wrong slowly. This asks for guidance only.
 *
 * Nothing here is matched or scored. A guide is recorded as the company wrote
 * it, in the units it used, with the sentence it came from. Turning "$4.6 to
 * $4.8 billion for the fourth quarter" into a comparison against a fact is the
 * matcher's job, and keeping the two apart means a bad match can be fixed
 * without re-reading a single filing.
 */

import { secJson, fetchDoc } from "./sec.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

/* How much of the release the model sees. Releases run long because the
   financial statements are appended, and guidance is never in them. Cutting
   here costs tokens and latency, not findings - but the response reports
   whether the cut happened, because "no guidance found" and "the guidance was
   past the cut" look identical otherwise. */
const MAX_CHARS = 80000;

/**
 * Earnings releases only.
 *
 * An 8-K is filed for dozens of reasons - a director resigns, a note is
 * issued, a plan is amended. Item 2.02 is "Results of Operations and
 * Financial Condition", and it is on every earnings release and almost
 * nothing else. SEC publishes the item codes in the submissions index, so
 * this is a filter in code, not a judgement by a model.
 */
export async function earningsReleases(env, cik, limit) {
  const subs = await secJson(env, "https://data.sec.gov/submissions/CIK" + cik + ".json");
  const r = (subs.filings && subs.filings.recent) || {};
  const forms = r.form || [];
  const out = [];

  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== "8-K") continue;
    const items = String((r.items || [])[i] || "");
    if (!items.includes("2.02")) continue;
    out.push({
      accession: r.accessionNumber[i],
      filed: r.filingDate[i],
      primaryDocument: r.primaryDocument[i],
      items,
    });
    if (out.length >= (limit || 12)) break;
  }
  return out;
}

/**
 * Which file in the filing is the press release?
 *
 * Convention puts it in exhibit 99.1, but the filename is the filer's choice:
 * ex991.htm, a8-kexhibit991.htm, mq32025ex-991.htm have all been seen. So the
 * filename is tried first and size is the fallback - the press release is
 * always far larger than the 8-K cover page that wraps it.
 *
 * The chosen file is reported back rather than assumed, because picking the
 * wrong document produces an empty result that looks exactly like a company
 * that gave no guidance.
 */
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

/* Tags out, text in. Deliberately crude: this is not parsing, it is stripping.
   Tables are KEPT - several filers put the outlook in one, and dropping them
   to save characters would silently lose those companies. */
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

/* ------------------------------------------------------------------ *
 * The quote guard
 * ------------------------------------------------------------------ */

/**
 * Every number appearing in a quote.
 *
 * Written after Delta's non-fuel unit cost guide came back as 6 percent from
 * this sentence:
 *
 *   "we expect non-fuel unit costs to grow at a rate similar to the March
 *    quarter, reflecting the impact of our capacity actions"
 *
 * There is no 6 in it. The number was invented, and it was then compared
 * against a real 6.8% actual to produce a near-miss out of nothing. Nobody
 * reading the row would have doubted it.
 *
 * A prompt instruction would not fix this reliably. A check does: a guide is
 * only allowed to carry numbers that appear in the sentence it came from.
 *
 * Parenthesised figures are recorded as both signs. "(0.5%) to 0.5%" is a
 * range from minus a half to plus a half, and a model may report either sign
 * for the first one.
 */
function quoteNumbers(quote) {
  const found = new Set();
  if (!quote) return found;

  const text = String(quote);
  const re = /(\()?\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    found.add(n);
    if (m[1]) found.add(-n);   // "(0.5%)" is minus a half
    // A company writing "$200M" and a model reporting 200 agree; a company
    // writing "21,764" and a model reporting 21764 agree. Both are covered by
    // stripping commas and comparing as written.
  }
  return found;
}

/* Numbers agree when they are the same number. The tolerance is for
   representation only - 2 against 2.00, 6 against 6.0 - not for closeness. A
   guide of 7.7 is NOT supported by a 7.8 in the quote. */
function present(value, pool) {
  if (typeof value !== "number" || !Number.isFinite(value)) return true;  // nothing to check
  for (const n of pool) {
    if (Math.abs(n - value) <= 0.0005) return true;
  }
  return false;
}

/**
 * A guide, checked against its own quote.
 *
 * If any stated number is absent from the quote, ALL of them are dropped and
 * the guide becomes qualitative. That is deliberately strict, and it is a
 * judgement worth knowing about:
 *
 * United guided capacity "flat to up approximately 2%". A model reports that
 * as a range from 0 to 2. The 2 is in the sentence; the 0 is an inference from
 * the word "flat" - a good inference, but not a number the company printed.
 * Under this rule the whole range is dropped and the guide is kept as an
 * event with no score.
 *
 * The alternative is to keep the supported half, which turns a range into a
 * one-sided guide and changes what it means. A guide that cannot be scored is
 * a small loss. A guide scored against a number nobody wrote is the loss that
 * ends the product.
 *
 * Nothing is deleted. The original numbers and the reason are both reported,
 * so a rule that turns out to be too strict can be loosened by looking at
 * what it caught.
 */
function guardGuide(g) {
  const pool = quoteNumbers(g.quote);
  const stated = [];
  if (typeof g.low === "number") stated.push(["low", g.low]);
  if (typeof g.high === "number") stated.push(["high", g.high]);
  if (typeof g.value === "number") stated.push(["value", g.value]);

  if (!stated.length) {
    return { ...g, numbers_verified: true };
  }

  const unsupported = stated.filter(([, v]) => !present(v, pool)).map(([k, v]) => k + "=" + v);
  if (!unsupported.length) {
    return { ...g, numbers_verified: true };
  }

  return {
    ...g,
    shape: "qualitative",
    low: null,
    high: null,
    value: null,
    numbers_verified: false,
    unsupported_numbers: unsupported,
    reported_numbers: {
      low: g.low ?? null,
      high: g.high ?? null,
      value: g.value ?? null,
    },
    guard_note:
      "Dropped: " + unsupported.join(", ") + " does not appear in the quoted sentence, "
      + "so no number from this guide is trusted. Kept as a guidance event with no score.",
  };
}

/**
 * The prompt.
 *
 * Short on purpose. Every instruction added to a prompt competes with the
 * task, and a prompt that grew across one session on the other product took
 * findings from 25 to zero. What is here is what cannot be enforced in code:
 * what a guide is, what GAAP means, and that a number already reported is not
 * a forecast.
 *
 * Everything checkable - period arithmetic, unit conversion, whether the
 * numbers are actually in the sentence - is left out and done downstream.
 */
const SYSTEM = [
  "You read one company earnings press release and report only FORWARD-LOOKING GUIDANCE.",
  "",
  "A guide is a number management expects for a period that has NOT yet been reported.",
  "A figure for the quarter or year just ended is a result, not a guide. Never report it.",
  "",
  "Report a guide whether it is GAAP or non-GAAP, and label which it is.",
  "Treat it as non-GAAP if the release calls it adjusted, comparable, core, underlying,",
  "or excludes anything. Revenue with no qualifier is GAAP.",
  "",
  "Also report, with no numbers, when guidance is REAFFIRMED without change,",
  "or WITHDRAWN or SUSPENDED. Both are guidance events.",
  "",
  "Reply with JSON only. No prose, no markdown fences. Shape:",
  '{"guides":[{',
  '  "metric": "revenue|eps|operating_income|capex|operating_cash_flow|free_cash_flow|tax_rate|other",',
  '  "metric_as_written": "what the release calls it, verbatim",',
  '  "basis": "gaap|non_gaap|unclear",',
  '  "period_text": "the period as written, e.g. fourth quarter, full year 2025",',
  '  "shape": "range|point|at_least|at_most|growth_range|growth_point|reaffirmed|withdrawn",',
  '  "low": number or null, "high": number or null, "value": number or null,',
  '  "unit": "USD millions|USD billions|USD per share|percent|other",',
  '  "quote": "the sentence it came from, verbatim, 40 words or fewer"',
  "}]}",
  "",
  "low and high for a range. value for everything else. All three null for",
  "reaffirmed and withdrawn. Numbers as written: 4.6 billion is low 4.6 with",
  "unit USD billions, not 4600.",
  "",
  "The quote must contain the numbers you report. If a guide is stated in words",
  "with no figure - 'up mid-teens', 'similar to last quarter' - report it with all",
  "three numbers null. Never supply a figure the sentence does not contain.",
  "",
  "If the release gives no guidance at all, return {\"guides\":[]}.",
].join("\n");

async function callModel(env, text) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set on the Worker.");

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
        { role: "user", content: text },
      ],
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error("Model returned " + r.status + ": " + body.slice(0, 300));
  }

  const data = await r.json();
  const content = ((data.choices || [])[0] || {}).message?.content || "";

  // The fences are asked against, so this only fires when the model ignores
  // the instruction - which it occasionally does.
  const clean = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error("Model did not return JSON: " + clean.slice(0, 300));
  }

  return Array.isArray(parsed.guides) ? parsed.guides : [];
}

/**
 * One release in, the guides it contains out.
 *
 * Fails loudly. An empty result and a failed call must never look the same:
 * an empty result is a finding about the company, a failed call is a finding
 * about us, and sending an email built on the second is how a scorecard tells
 * a subscriber a company stopped guiding when it did not.
 */
export async function guidanceFrom(env, cik, release) {
  const exhibit = await pickExhibit(env, cik, release.accession);

  const full = htmlToText(await fetchDoc(env, exhibit.url));
  const truncated = full.length > MAX_CHARS;
  const text = truncated ? full.slice(0, MAX_CHARS) : full;

  const raw = await callModel(env, text);
  const guides = raw.map(guardGuide);

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
    guarded: guides.filter((g) => g.numbers_verified === false).length,
    guides,
  };
}
