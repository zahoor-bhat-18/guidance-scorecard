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
import { resolvePeriod, conventionFromText } from "./period.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MAX_CHARS = 80000;

/* Two filings closer together than this are one event reported twice. A real
   quarter is about ninety days, so nothing legitimate is merged. */
const SAME_EVENT_DAYS = 45;

/**
 * Earnings releases only.
 *
 * Item 2.02 is "Results of Operations and Financial Condition", on every
 * earnings release and almost nothing else.
 *
 * Almost. Honeywell filed an 8-K carrying items 1.01, 2.01, 2.02, 3.03, 5.02,
 * 5.03, 7.01 and 9.01 three weeks before its actual results - a transaction
 * filing mentioning results in passing. Taking it as the previous release cost
 * a whole quarter, silently, because a company with no guidance looks exactly
 * like one we failed to read. Macy's produced the mirror image: two item-2.02
 * filings three weeks apart, preliminary results then full ones.
 *
 * One rule fixes both. Filings within six weeks are one event and the LATER
 * wins. What was dropped is reported, so a wrong merge is visible.
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

/* The characters Windows-1252 puts in 0x80-0x9F, which UTF-8 does not.
   Needed to turn mojibake back into the bytes it came from. */
const CP1252_HIGH = {
  "\u20AC": 0x80, "\u201A": 0x82, "\u0192": 0x83, "\u201E": 0x84,
  "\u2026": 0x85, "\u2020": 0x86, "\u2021": 0x87, "\u02C6": 0x88,
  "\u2030": 0x89, "\u0160": 0x8A, "\u2039": 0x8B, "\u0152": 0x8C,
  "\u017D": 0x8E, "\u2018": 0x91, "\u2019": 0x92, "\u201C": 0x93,
  "\u201D": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
  "\u02DC": 0x98, "\u2122": 0x99, "\u0161": 0x9A, "\u203A": 0x9B,
  "\u0153": 0x9C, "\u017E": 0x9E, "\u0178": 0x9F,
};

/**
 * Double-encoded text, put back.
 *
 * The symptom is everywhere in these filings: "Macyâ€™s", "(â€œEBITDAâ€)",
 * "Â¢". It survived being decoded as UTF-8, which is the proof of what it is -
 * SEC serves bytes that were already mangled before they were encoded, so a
 * correct decoder faithfully reproduces the mangling.
 *
 * Patching the visible sequences one at a time was tried and missed most of
 * them. This reverses the process instead: map each character back to the
 * single byte it stands for, then read those bytes as UTF-8 - which is what
 * should have happened upstream.
 *
 * Only runs when the signature is present, and returns the original untouched
 * if anything fails. A document that is merely unusual should not be rewritten
 * on suspicion.
 */
function repairDoubleEncoding(s) {
  if (!/[\u00C2\u00C3][\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/.test(s)) {
    return s;
  }

  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    const mapped = CP1252_HIGH[ch];
    if (mapped === undefined) return s;   // not representable: leave it alone
    bytes.push(mapped);
  }

  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return repaired;
  } catch {
    return s;
  }
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

  return repairDoubleEncoding(decodeEntities(stripped))
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

/**
 * The calendar, improved by what the release says.
 *
 * companyCalendar starts from the year-end month and, where SEC serves it, the
 * company's own fiscal year focus tag. Where neither settles it the month is a
 * guess, and the month cannot settle it: Macy's, Walmart and Autodesk all
 * close in late January and do not agree.
 *
 * The release does settle it, so the release gets the last word.
 */
export function refineCalendar(cal, text) {
  const learned = conventionFromText(text, cal.fye);
  if (!learned) return cal;
  if (learned.offset === cal.labelOffset) {
    return {
      ...cal,
      meta: { ...cal.meta, conventionConfirmedBy: learned.source, conventionVotes: learned.votes },
    };
  }

  return {
    ...cal,
    labelOffset: learned.offset,
    meta: {
      ...cal.meta,
      labelConvention: learned.offset === 1
        ? "fiscal year is labelled by the year it STARTS in"
        : "fiscal year is labelled by the year it ENDS in",
      conventionFrom: learned.source,
      conventionWas: cal.meta.conventionFrom,
      conventionVotes: learned.votes,
      conventionEvidence: learned.evidence,
    },
  };
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
 */
/* Words that make the number after them a decline. "Flat" is deliberately
   NOT here - see guardGuide: "flat" is the company declining to give a
   number, and a 0 read out of it is an inference, not a figure. */
const DOWN_BEFORE = /\b(down|declines?|declined|decreases?|decreased|lower|negative|minus|reduction|contraction|drop|fall)\s+(?:(?:of|by|approximately|approx\.?|about|roughly|around|nearly)\s+)*\$?\s*$/i;

export function quoteNumbers(quote) {
  const found = new Set();
  if (!quote) return found;

  const text = String(quote);
  const re = /(\()?\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  let m;
  let lastNegative = false;
  let lastEnd = 0;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    found.add(n);

    // Accounting negatives: (2).
    if (m[1]) found.add(-n);

    const start = m.index + m[0].indexOf(m[2]);
    const before = text.slice(Math.max(0, start - 40), start);

    /**
     * A DECLINE WRITTEN IN WORDS IS A NEGATIVE NUMBER.
     *
     * Delta guided second-quarter 2025 revenue "Down 2% - up 2%". The model
     * read it correctly as -2 to 2, and this function could find only 2 in
     * the sentence - it knew negatives in parentheses and nothing else - so
     * the guard concluded -2 was invented and dropped the whole guide. Delta
     * then showed "not guided" for a quarter it had guided plainly.
     *
     * Every company that writes "down 2%", "a decline of approximately 3%" or
     * "decrease of 1%" was losing its guide the same way. The figure is in
     * the sentence; it is just spelled with a word instead of a sign.
     */
    let negative = DOWN_BEFORE.test(before);

    /**
     * A DECLINE GOVERNS THE WHOLE RANGE IT OPENS.
     *
     * "A decrease of 1% to 2%" is -1 to -2, but the word "decrease" sits
     * before the first number only. Joined by nothing but "to", "and",
     * "through" or a dash, the second number inherits the sign of the first.
     * Any other word between them - "up", "increase", "growth" - ends the
     * run, which is what keeps "Down 2% - up 2%" reading -2 and +2.
     */
    const between = text.slice(lastEnd, start);
    if (!negative && lastNegative
      && /^\s*%?\s*(?:to|and|through|-|\u2013)\s*\$?\s*$/i.test(between)) {
      negative = true;
    }
    if (negative) found.add(-n);

    /**
     * A minus sign attached to the number: "-$0.35", "-2%".
     *
     * Only when the sign does not join two numbers. "3-5%" and "3%-5%" are
     * ranges written with a hyphen, and reading the 5 as negative would turn
     * a range into nonsense. So the character before the sign must not be a
     * digit or a percent sign.
     */
    const sign = text[start - 1] === "$" ? start - 2 : start - 1;
    if ((text[sign] === "-" || text[sign] === "\u2212") && !/[\d%]/.test(text[sign - 1] || "")) {
      found.add(-n);
      negative = true;
    }

    lastNegative = negative;
    lastEnd = m.index + m[0].length;
  }
  return found;
}

function present(value, pool) {
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  for (const n of pool) {
    if (Math.abs(n - value) <= 0.0005) return true;
  }
  return false;
}

/**
 * A reaffirmed guide, with its numbers and its shape put back.
 *
 * Walmart reaffirmed six full-year guides and every one came back with its
 * figures nulled, because the instruction says reaffirmations carry no
 * numbers. But the quotes restate them: "Net sales (cc) Increase 3.5% to 4.5%
 * Unchanged". The company did not withdraw a number, it repeated one - and
 * Walmart's entire full-year outlook fell out of the pipeline.
 *
 * Recovering the numbers alone was not enough. "Interest, net Increase
 * approximately $200M to $300M" is a guide about a CHANGE, and with the shape
 * still reading "reaffirmed" the actuals call was told to look for a level.
 *
 * So the shape is read back out of the quote too, using the company's own
 * words - increase, decrease, growth, up, down.
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
      numbers_recovered: "range read from the reaffirmed quote" + (isChange ? ", stated as a change" : ""),
    };
  }

  return {
    ...g,
    shape: isChange ? "growth_point" : "point",
    was_reaffirmed: true,
    value: distinct[0],
    numbers_recovered: "point read from the reaffirmed quote" + (isChange ? ", stated as a change" : ""),
  };
}

/**
 * A guide, checked against its own quote.
 *
 * If any stated number is absent from the quote, ALL of them are dropped and
 * the guide becomes qualitative. Deliberately strict: United guided capacity
 * "flat to up approximately 2%", a model reports 0 to 2, and the 0 is an
 * inference from the word "flat" rather than a number the company printed.
 *
 * A guide that cannot be scored is a small loss. A guide scored against a
 * number nobody wrote is the loss that ends the product.
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
 * A currency or deal EFFECT, not a guide for the measure itself.
 *
 * Coca-Cola writes "Comparable net revenues (non-GAAP) are expected to include
 * an approximate 1% currency tailwind ... in addition to an approximate 1%
 * headwind from acquisitions and divestitures". The model returned that as
 * "comparable net revenues guided at 1%", and it was scored against revenue
 * growth of 6%: "guided 1, reported 6", flagged as a very large gap. The same
 * for EPS ("guided 3, reported 11"), and in the revision lines, where a change
 * in the acquisition headwind printed as "Comparable net revenues raised".
 *
 * The test is on the guide's OWN numbers. It is an effect only when every
 * number the guide carries is a number the quote attaches to a headwind or
 * tailwind. "Comparable EPS 9% to 10% growth, which includes approx. 3%
 * currency tailwind" keeps its 9% to 10%: those are not the tailwind's
 * numbers. Deterministic, so it does not depend on the model's labelling.
 */
const EFFECT_RE =
  /(-?\d+(?:\.\d+)?)\s*%?\s*(?:(?:to|-|–)\s*(-?\d+(?:\.\d+)?)\s*%?\s*)?(?:currency\s+|fx\s+|foreign\s+exchange\s+|structural\s+)?(?:headwind|tailwind)s?\b/gi;

export function isEffectGuide(g) {
  const nums = [g && g.low, g && g.high, g && g.value].filter((n) => typeof n === "number");
  if (!nums.length) return false;

  const quote = String((g && g.quote) || "").replace(/\s+/g, " ");
  const effectNumbers = new Set();
  for (const m of quote.matchAll(EFFECT_RE)) {
    effectNumbers.add(Math.abs(parseFloat(m[1])));
    if (m[2] !== undefined) effectNumbers.add(Math.abs(parseFloat(m[2])));
  }
  if (!effectNumbers.size) return false;

  return nums.every((n) => effectNumbers.has(Math.abs(n)));
}

/**
 * The same guide, reported twice.
 *
 * Delta prints its outlook in a table AND describes it in the narrative, so
 * one guide can arrive as "Total Revenue YoY (%)" and again as "total revenue
 * growth". Scoring both counts one company decision twice.
 *
 * The RESOLVED period is the key rather than the wording, which is what lets
 * that pair merge - "2Q26" and "the June quarter" now arrive as one label.
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
 * tried and removed: it worked, but two real guides stated in prose went
 * missing in both runs that carried it. The check belongs in guardGuide, where
 * it costs nothing and cannot compete with the task.
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
 * The calendar is refined against the release text before any period is
 * resolved, and the refined version is RETURNED so the actuals call uses the
 * same one. If the two sides disagreed about the convention, every pair would
 * be a year apart and all of them would be thrown away.
 *
 * Guidance looks FORWARD, so a period named without a year resolves to the
 * next one, not the last.
 */
export async function guidanceFrom(env, cik, release, cal) {
  const filing = await readFiling(env, cik, release.accession);
  const calendar = cal ? refineCalendar(cal, filing.text) : null;

  const raw = await callModel(env, filing.text);

  const withPeriods = raw.map(guardGuide).map((g) => {
    const r = calendar
      ? resolvePeriod(g.period_text, calendar, { referenceDate: release.filed, direction: "future" })
      : { period: null, why: "No fiscal calendar was supplied." };
    return { ...g, period: r.period, period_how: r.how || null, period_why: r.why || null };
  });

  // Every guide as extracted, in order - what the next release is ASKED
  // about. Kept unchanged so the backfill sends the model the same questions
  // it always has and reuses the saved answers.
  const asExtracted = dedupeGuides(withPeriods);
  // What is scored, tracked and revised: the same, without currency and deal
  // effects. Set aside rather than hidden - listed in the backfill summary.
  const effects = asExtracted.filter(isEffectGuide);
  const guides = asExtracted.filter((g) => !isEffectGuide(g));

  return {
    release: {
      accession: release.accession,
      filed: release.filed,
      items: release.items,
      pickedBy: filing.pickedBy,
      files: filing.files,
      textChars: filing.chars,
    },
    calendar,
    guarded: guides.filter((g) => g.numbers_verified === false).length,
    recovered: guides.filter((g) => g.numbers_recovered).length,
    unresolvedPeriods: guides.filter((g) => !g.period).length,
    guides,
    effects,
    asExtracted,
  };
}
