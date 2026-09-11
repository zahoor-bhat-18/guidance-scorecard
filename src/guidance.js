/**
 * Guidance, from the earnings release.
 *
 * XBRL cannot carry guidance: nobody tags a forecast, and a forecast is prose.
 * So this is the one place a model is unavoidable - and deliberately the ONLY
 * place a guide comes from.
 *
 * Nothing here is matched or scored. A guide is recorded as the company wrote
 * it, in the units it used, with the sentence it came from.
 */

import { secJson, fetchDoc } from "./sec.js";
import { resolvePeriod } from "./period.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

/* How much of the release the model sees. The response reports whether the cut
   happened, because "no guidance found" and "the guidance was past the cut"
   look identical otherwise. */
const MAX_CHARS = 80000;

/* Two filings closer together than this are one event reported twice. A real
   quarter is about ninety days, so nothing legitimate is merged. */
const SAME_EVENT_DAYS = 45;

/**
 * Earnings releases only.
 *
 * Item 2.02 is "Results of Operations and Financial Condition", and it is on
 * every earnings release and almost nothing else.
 *
 * Almost. Honeywell filed an 8-K carrying items 1.01, 2.01, 2.02, 3.03, 5.02,
 * 5.03, 7.01 and 9.01 three weeks before its actual results - a transaction
 * filing mentioning results in passing. Taking it as the previous release cost
 * a whole quarter, silently, because a company with no guidance looks exactly
 * like one we failed to read.
 *
 * Macy's produced the mirror image: two item-2.02 filings three weeks apart,
 * preliminary results followed by full ones.
 *
 * One rule fixes both. Filings within six weeks are one event and the LATER
 * wins - the full results in Macy's case, the real earnings release in
 * Honeywell's. What was dropped is reported, so a wrong merge is visible.
 */
export async function earningsReleases(env, cik, limit) {
  const subs = await secJson(env, "https://data.sec.gov/submissions/CIK" + cik + ".json");
  const r = (subs.filings && subs.filings.recent) || {};
  const forms = r.form || [];
  const all = [];

  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== "8-K") continue;
    const items = String((r.items || [])[i] || "");
    if (!items.includes("2.02")) continue;
    all.push({
      accession: r.accessionNumber[i],
      filed: r.filingDate[i],
      primaryDocument: r.primaryDocument[i],
      items,
    });
  }

  all.sort((a, b) => (a.filed < b.filed ? 1 : -1));

  const kept = [];
  const merged = [];
  for (const f of all) {
    const previous = kept[kept.length - 1];
    if (previous) {
      const gap = (Date.parse(previous.filed) - Date.parse(f.filed)) / 86400000;
      if (gap >= 0 && gap < SAME_EVENT_DAYS) {
        merged.push({ dropped: f.accession, filed: f.filed, items: f.items, inFavourOf: previous.accession });
        continue;
      }
    }
    kept.push(f);
    if (kept.length >= (limit || 12)) break;
  }

  kept.mergedFilings = merged;
  return kept;
}

/* Which exhibit number is this, so 99.1 is read before 99.2? Unnumbered files
   sort last. */
function exhibitRank(name) {
  const m = name.match(/(?:^|[^0-9])99(?:[._-]?(\d))?(?:[^0-9]|$)/);
  if (!m) return 999;
  return m[1] ? parseInt(m[1], 10) : 99;
}

/**
 * Which files in the filing carry the guidance?
 *
 * The first version took one file, exhibit 99.1, and that quietly cost an
 * entire company. United's press release contains no numeric guidance at all -
 * its outlook lives in the Investor Update, filed alongside as exhibit 99.2.
 * The extractor read 99.1, found nothing, and reported that United does not
 * guide. It guides in detail.
 *
 * So the whole 99-series is read, 99.1 first. Ordering matters because the
 * character budget is finite: if a filer attaches long supplemental tables,
 * those are what gets cut, never the press release.
 */
async function collectExhibits(env, cik, accession) {
  const noDash = accession.replace(/-/g, "");
  const base = "https://www.sec.gov/Archives/edgar/data/" + Number(cik) + "/" + noDash;
  const dir = await secJson(env, base + "/index.json");
  const items = ((dir.directory && dir.directory.item) || [])
    .filter((f) => /\.html?$/i.test(f.name) && !/-index/i.test(f.name));

  if (!items.length) throw new Error("No HTML document in filing " + accession + ".");

  const named = items.filter((f) => /(?:^|[^0-9])99(?:[._-]?\d)?(?:[^0-9]|$)/.test(f.name));

  if (named.length) {
    named.sort((a, b) => exhibitRank(a.name) - exhibitRank(b.name));
    return {
      pickedBy: "the 99-series exhibits, in order",
      files: named.slice(0, 4).map((f) => ({ name: f.name, url: base + "/" + f.name, bytes: Number(f.size || 0) })),
    };
  }

  const biggest = items.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
  return {
    pickedBy: "largest HTML in the filing",
    files: [{ name: biggest.name, url: base + "/" + biggest.name, bytes: Number(biggest.size || 0) }],
  };
}

/**
 * Entities, decoded.
 *
 * The diagnostic showed the model reading raw &#34; and &#8226; and &#58;
 * throughout. Noise around a number is exactly where an extractor makes
 * mistakes, and it is free to remove.
 *
 * Decoded AFTER tags are stripped, deliberately. A document containing &#60;
 * would otherwise produce a "<" that the tag stripper reads as markup and eats
 * the text after it.
 *
 * The mojibake that appeared alongside this - "Companyâ€™s", "Â¢" - is NOT
 * handled here any more. It was never an entity problem: SEC declares a legacy
 * charset and the response was being decoded through it. That is fixed in
 * fetchDoc, at the decoder, which is where it belongs.
 */
function decodeEntities(s) {
  const named = {
    nbsp: " ", amp: "&", quot: '"', apos: "'",
    lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
    mdash: "-", ndash: "-", hellip: "...",
    cent: "\u00A2", pound: "\u00A3", deg: "\u00B0", sect: "\u00A7",
    reg: "\u00AE", copy: "\u00A9", trade: "\u2122", bull: "\u2022",
    lt: "<", gt: ">",
  };

  return s
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n > 0 && n < 1114112 ? String.fromCodePoint(n) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n > 0 && n < 1114112 ? String.fromCodePoint(n) : " ";
    })
    .replace(/&([a-z]+);/gi, (m, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, k) ? named[k] : m;
    });
}

/* Tags out, text in. Deliberately crude: this is not parsing, it is stripping.
   Tables are KEPT - several filers put the outlook in one. */
export function htmlToText(html) {
  const stripped = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Every exhibit, read and joined, within the character budget. */
export async function readFiling(env, cik, accession) {
  const chosen = await collectExhibits(env, cik, accession);
  const parts = [];
  const used = [];
  let spent = 0;

  for (const file of chosen.files) {
    const text = htmlToText(await fetchDoc(env, file.url));
    const header = "\n\n===== " + file.name + " =====\n\n";
    const room = MAX_CHARS - spent - header.length;

    if (room <= 500) {
      used.push({ file: file.name, chars: text.length, included: false, reason: "no room left in the character budget" });
      continue;
    }

    const slice = text.length > room ? text.slice(0, room) : text;
    parts.push(header + slice);
    spent += header.length + slice.length;
    used.push({ file: file.name, chars: text.length, included: true, truncated: slice.length < text.length });
  }

  return { text: parts.join(""), pickedBy: chosen.pickedBy, files: used, chars: spent };
}

/* ------------------------------------------------------------------ *
 * The quote guard
 * ------------------------------------------------------------------ */

/**
 * Every number appearing in a quote.
 *
 * Written after Delta's non-fuel unit cost guide came back as 6 percent from a
 * sentence reading "we expect non-fuel unit costs to grow at a rate similar to
 * the March quarter". There is no 6 in it. The number was invented, then
 * compared against a real 6.8% actual to produce a near-miss out of nothing.
 *
 * Parenthesised figures are recorded as both signs. "(0.5%) to 0.5%" runs from
 * minus a half to plus a half.
 */
export function quoteNumbers(quote) {
  const found = new Set();
  if (!quote) return found;

  const re = /(\()?\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(quote))) !== null) {
    const n = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    found.add(n);
    if (m[1]) found.add(-n);
  }
  return found;
}

/* Numbers agree when they are the same number. The tolerance is for
   representation only - 2 against 2.00 - not for closeness. */
function present(value, pool) {
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  for (const n of pool) {
    if (Math.abs(n - value) <= 0.0005) return true;
  }
  return false;
}

/**
 * A reaffirmed guide, with its numbers and its SHAPE put back.
 *
 * Walmart reaffirmed six full-year guides and every one came back with its
 * figures nulled, because the instruction says reaffirmations carry no
 * numbers. But the quotes restate them: "Net sales (cc) Increase 3.5% to 4.5%
 * Unchanged". The company did not withdraw a number, it repeated one - and
 * Walmart's entire full-year outlook fell out of the pipeline.
 *
 * Recovering the numbers alone was not enough. "Interest, net Increase
 * approximately $200M to $300M" is a guide about a CHANGE, and with the shape
 * still reading "reaffirmed" the actuals call was told to look for a level. It
 * dutifully returned 171 - the quarter's interest expense - against a guide
 * for a $200-300m increase.
 *
 * So the shape is read back out of the quote too. The words that mark a change
 * are the company's own, in the sentence, and they are the same words in every
 * release: increase, decrease, growth, up, down.
 *
 * Three or more numbers is ambiguous - a row carrying a prior column and a
 * current one - and is left alone rather than guessed at.
 */
function recoverReaffirmed(g) {
  const distinct = Array.from(quoteNumbers(g.quote))
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);

  if (!distinct.length || distinct.length > 2) return g;

  const isChange = /\b(increase|increased|decrease|decreased|growth|grow|up|down|higher|lower)\b/i
    .test(String(g.quote || ""));

  if (distinct.length === 2) {
    return {
      ...g,
      shape: isChange ? "growth_range" : "range",
      was_reaffirmed: true,
      low: distinct[0],
      high: distinct[1],
      numbers_recovered: "range read from the reaffirmed quote"
        + (isChange ? ", stated as a change" : ""),
    };
  }

  return {
    ...g,
    shape: isChange ? "growth_point" : "point",
    was_reaffirmed: true,
    value: distinct[0],
    numbers_recovered: "point read from the reaffirmed quote"
      + (isChange ? ", stated as a change" : ""),
  };
}

/**
 * A guide, checked against its own quote.
 *
 * If any stated number is absent from the quote, ALL of them are dropped and
 * the guide becomes qualitative. Deliberately strict:
 *
 * United guided capacity "flat to up approximately 2%". A model reports that
 * as a range from 0 to 2. The 2 is in the sentence; the 0 is an inference from
 * the word "flat" - a good inference, but not a number the company printed.
 * Under this rule the whole range is dropped and the guide is kept as an event
 * with no score.
 *
 * Keeping the supported half would turn a range into a one-sided guide and
 * change what it means. A guide that cannot be scored is a small loss. A guide
 * scored against a number nobody wrote is the loss that ends the product.
 */
function guardGuide(input) {
  const g = input.shape === "reaffirmed" ? recoverReaffirmed(input) : input;

  const pool = quoteNumbers(g.quote);
  const stated = [];
  if (typeof g.low === "number") stated.push(["low", g.low]);
  if (typeof g.high === "number") stated.push(["high", g.high]);
  if (typeof g.value === "number") stated.push(["value", g.value]);

  if (!stated.length) return { ...g, numbers_verified: true };

  const unsupported = stated.filter(([, v]) => !present(v, pool)).map(([k, v]) => k + "=" + v);
  if (!unsupported.length) return { ...g, numbers_verified: true };

  return {
    ...g,
    shape: "qualitative",
    low: null, high: null, value: null,
    numbers_verified: false,
    unsupported_numbers: unsupported,
    reported_numbers: { low: g.low ?? null, high: g.high ?? null, value: g.value ?? null },
    guard_note:
      "Dropped: " + unsupported.join(", ") + " does not appear in the quoted sentence, "
      + "so no number from this guide is trusted. Kept as a guidance event with no score.",
  };
}

/**
 * The same guide, reported twice.
 *
 * Delta prints its outlook in a table AND describes it in the narrative, so
 * one guide can arrive as "Total Revenue YoY (%)" and again as "total revenue
 * growth". Scoring both counts one company decision twice.
 *
 * Now that periods are resolved before this runs, the RESOLVED period is the
 * key rather than the wording - which is what lets the Delta pair merge, since
 * "2Q26" and "June quarter" finally arrive as the same label.
 */
function dedupeGuides(guides) {
  const seen = new Map();
  const out = [];

  for (const g of guides) {
    const key = [
      g.metric || "",
      g.basis || "",
      g.unit || "",
      g.low ?? "-",
      g.high ?? "-",
      g.value ?? "-",
      g.period || String(g.period_text || "").toLowerCase().replace(/\s+/g, " ").trim(),
    ].join("|");

    const held = seen.get(key);
    if (held) {
      held.duplicates = (held.duplicates || 0) + 1;
      continue;
    }
    seen.set(key, g);
    out.push(g);
  }
  return out;
}

/**
 * The prompt.
 *
 * Short on purpose. Every instruction added competes with the task, and a
 * prompt that grew across one session on the other product took findings from
 * 25 to zero.
 *
 * A line telling the model not to report numbers absent from its quote was
 * tried here and removed. It worked - Delta's invented 6 stopped appearing -
 * but two real guides stated in prose went missing in both runs that carried
 * it. Accuracy paid for in recall is the trade this product should not make,
 * because the check belongs in guardGuide, where it costs nothing and cannot
 * compete with the task.
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
  "The document may contain several exhibits, separated by ===== markers. The",
  "outlook is often in a later one. Read all of them.",
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
 * cal is the company's fiscal calendar. With it, every guide carries a
 * resolved period label as well as the words the company used - which is what
 * the matcher compares, and what stops a full-year guide being answered by a
 * first-quarter figure.
 *
 * Guidance looks FORWARD, so a period named without a year resolves to the
 * next one, not the last.
 *
 * Fails loudly. An empty result and a failed call must never look the same.
 */
export async function guidanceFrom(env, cik, release, cal) {
  const filing = await readFiling(env, cik, release.accession);

  const raw = await callModel(env, filing.text);

  const withPeriods = raw.map(guardGuide).map((g) => {
    const r = cal
      ? resolvePeriod(g.period_text, cal, { referenceDate: release.filed, direction: "future" })
      : { period: null, why: "No fiscal calendar was supplied." };
    return { ...g, period: r.period, period_how: r.how || null, period_why: r.why || null };
  });

  const guides = dedupeGuides(withPeriods);

  return {
    release: {
      accession: release.accession,
      filed: release.filed,
      items: release.items,
      pickedBy: filing.pickedBy,
      files: filing.files,
      textChars: filing.chars,
    },
    guarded: guides.filter((g) => g.numbers_verified === false).length,
    recovered: guides.filter((g) => g.numbers_recovered).length,
    unresolvedPeriods: guides.filter((g) => !g.period).length,
    guides,
  };
}
