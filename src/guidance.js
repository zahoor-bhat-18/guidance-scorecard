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
import { resolvePeriod, conventionFromText, periodIsClosedBy } from "./period.js";
import { metricKey } from "./metrics.js";

const MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";
export const MAX_CHARS = 80000;

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
/**
 * Every 8-K the company has filed in the last few years.
 *
 * EDGAR's submissions file lists only the latest thousand or so filings of
 * any kind. For most companies that is years. JPMorgan files about two
 * thousand documents a MONTH (prospectus supplements for structured notes),
 * so its list reached back twelve months and held four earnings releases,
 * where fourteen are wanted. Every large bank is the same.
 *
 * When the list is cut short like that - older pages exist, and the list
 * does not reach back four years - EDGAR's own list of the company's 8-Ks
 * alone is read as well: one request, a hundred 8-Ks, with their items.
 * For everyone else nothing changes and nothing extra is fetched.
 */
const EIGHT_KS = new Map();
async function eightKs(env, cik) {
  const held = EIGHT_KS.get(cik);
  if (held && Date.now() - held.at < 5 * 60 * 1000) return held.list;

  const subs = await secJson(env, "https://data.sec.gov/submissions/CIK" + cik + ".json");
  const r = (subs.filings && subs.filings.recent) || {};
  const forms = r.form || [];
  const list = [];
  const seen = new Set();
  let oldest = null;
  for (let i = 0; i < forms.length; i++) {
    const filed = r.filingDate[i];
    if (filed && (!oldest || filed < oldest)) oldest = filed;
    if (!/^8-K/.test(String(forms[i]))) continue;
    seen.add(r.accessionNumber[i]);
    list.push({
      form: forms[i],
      accession: r.accessionNumber[i],
      filed,
      primaryDocument: (r.primaryDocument || [])[i],
      items: String((r.items || [])[i] || ""),
    });
  }

  const cutShort = ((subs.filings && subs.filings.files) || []).length > 0
    && oldest && Date.parse(oldest) > Date.now() - 4 * 365 * 86400000;
  if (cutShort) {
    try {
      const feed = await fetchDoc(env, "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + cik
        + "&type=8-K&dateb=&owner=include&count=100&output=atom");
      const entry = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = entry.exec(feed))) {
        const pick = (tag) => { const x = m[1].match(new RegExp("<" + tag + ">([^<]*)<")); return x ? x[1].trim() : ""; };
        const accession = pick("accession-number");
        const form = pick("filing-type");
        if (!accession || seen.has(accession) || !/^8-K/.test(form)) continue;
        seen.add(accession);
        // "items 2.02 and 9.01" -> "2.02,9.01", as the submissions file writes it.
        const items = (pick("items-desc").match(/\d+\.\d+/g) || []).join(",");
        list.push({ form, accession, filed: pick("filing-date"), primaryDocument: undefined, items });
      }
    } catch (e) {
      console.error("Older 8-Ks for " + cik + " could not be listed: " + e.message);
    }
  }

  EIGHT_KS.set(cik, { at: Date.now(), list });
  return list;
}

export async function earningsReleases(env, cik, limit) {
  const all = [];

  for (const f of await eightKs(env, cik)) {
    if (f.form !== "8-K") continue;
    if (!f.items.includes("2.02")) continue;
    all.push({
      accession: f.accession,
      filed: f.filed,
      primaryDocument: f.primaryDocument,
      items: f.items,
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
  let items = ((dir.directory && dir.directory.item) || [])
    .filter((f) => /\.html?$/i.test(f.name) && !/-index/i.test(f.name));

  /* The JSON listing is sometimes incomplete. On 30 Sep 2026 EDGAR's
     index.json for PepsiCo's October 2025 release listed only the headers,
     the .txt and the XBRL zip - no documents - while the filing's own index
     page listed the release (q320258-kxexhibit991.htm) as it always had. A
     rebuild failed on it. The index page is read as a second source; sizes
     are unknown there, so the 99-series naming decides, as it does anyway. */
  if (!items.length) {
    try {
      const page = await fetchDoc(env, base + "/" + accession + "-index.html");
      const seen = new Set();
      const re = /href="(?:\/ix\?doc=)?\/Archives\/edgar\/data\/\d+\/\d+\/([^"\/]+\.html?)"/gi;
      let m;
      while ((m = re.exec(page))) {
        const name = m[1];
        if (/-index/i.test(name) || seen.has(name)) continue;
        seen.add(name);
        items.push({ name, size: 0 });
      }
    } catch (e) {
      // Fall through to the error below, which names the filing.
    }
  }

  if (!items.length) throw new Error("No HTML document in filing " + accession + ".");

  const named = items.filter((f) => /(?:^|[^0-9])99(?:[._-]?\d)?(?:[^0-9]|$)/.test(f.name));

  if (named.length) {
    named.sort((a, b) => exhibitRank(a.name) - exhibitRank(b.name));
    return {
      pickedBy: "the 99-series exhibits, in order",
      files: named.slice(0, 4).map((f) => ({ name: f.name, url: base + "/" + f.name, bytes: Number(f.size || 0) })),
    };
  }

  /* "R1.htm", "R2.htm" are pages EDGAR generates from the cover page's tags.
     They are never the release, and they can be the largest file: for seven
     of McCormick's fourteen releases R1.htm (44 KB) outweighed the press
     release (42 KB), so the generated page was read and the release was not. */
  const real = items.filter((f) => !/^R\d+\.html?$/i.test(f.name));
  const pool = real.length ? real : items;
  const biggest = pool.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];

  /* And the largest of the rest is not always the exhibit either. JPMorgan's
     earnings presentation (27 KB of slide text) is smaller than the 8-K
     cover page it is attached to. The filing's own index page says which
     document is which ("EX-99"). It is asked only here, where the names did
     not say, and it changes what is read only when the largest file is NOT
     an exhibit: then the exhibits are read first and the largest file after
     them, because an 8-K sometimes carries its news in its own body (Delta's
     March 2025 guidance cut). Where the largest is the exhibit, what is read
     is exactly as before. */
  try {
    const page = await fetchDoc(env, base + "/" + accession + "-index.html");
    const typed = [];
    const row = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = row.exec(page))) {
      const file = m[1].match(/href="(?:\/ix\?doc=)?\/Archives\/edgar\/data\/\d+\/\d+\/([^"\/]+\.html?)"/i);
      if (!file || !/<td[^>]*>\s*EX-99[^<]*<\/td>/i.test(m[1])) continue;
      const known = items.find((f) => f.name === file[1]);
      if (!typed.some((f) => f.name === file[1])) typed.push({ name: file[1], size: known ? known.size : 0 });
    }
    if (typed.length && !typed.some((f) => f.name === biggest.name)) {
      return {
        pickedBy: "the exhibits the filing index marks EX-99, then the largest HTML",
        files: typed.slice(0, 3).concat([biggest]).map((f) => ({ name: f.name, url: base + "/" + f.name, bytes: Number(f.size || 0) })),
      };
    }
  } catch (e) {
    // The index page could not be read: the size rule stands.
  }

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
  const docs = [];
  for (const file of chosen.files) {
    docs.push({ file, text: htmlToText(await fetchDoc(env, file.url)), header: "\n\n===== " + file.name + " =====\n\n" });
  }

  /* WHO GETS THE ROOM.
   *
   * The budget used to be spent in order: the first exhibit took what it
   * needed, the second the rest, and a third got nothing. Wells Fargo files
   * its release (99.1), a three-megabyte table supplement (99.2) and its
   * presentation (99.3), where the outlook is. The supplement swallowed the
   * budget and the presentation was never read - for all fourteen releases.
   *
   * Now, only when everything does not fit:
   *   - the first exhibit still comes first, but leaves the others up to a
   *     quarter of the budget if they need it;
   *   - the others are served smallest first, so a short document is read
   *     whole and the long tables are what gets cut;
   *   - room nobody used goes back to the first.
   * The text is still joined in exhibit order. When everything fits, or the
   * only cut is to the last exhibit, the result is exactly what it was.
   */
  const need = docs.map((d) => d.header.length + d.text.length);
  const give = need.slice();
  if (need.reduce((a, b) => a + b, 0) > MAX_CHARS && docs.length) {
    const others = need.slice(1).reduce((a, b) => a + b, 0);
    give[0] = Math.min(need[0], MAX_CHARS - Math.min(others, MAX_CHARS / 4));
    let room = MAX_CHARS - give[0];
    const order = docs.map((_, k) => k).slice(1).sort((a, b) => need[a] - need[b]);
    order.forEach((k, n) => {
      const stillToCome = order.length - n - 1;
      give[k] = Math.max(0, Math.min(need[k], room - 2000 * stillToCome));
      room -= give[k];
    });
    if (room > 0) give[0] = Math.min(need[0], give[0] + room);
  }

  const parts = [];
  const used = [];
  let spent = 0;
  docs.forEach((d, k) => {
    const room = give[k] - d.header.length;
    if (room <= 500) {
      used.push({ file: d.file.name, chars: d.text.length, included: false, reason: "no room left in the character budget" });
      return;
    }
    const slice = d.text.length > room ? d.text.slice(0, room) : d.text;
    parts.push(d.header + slice);
    spent += d.header.length + slice.length;
    used.push({ file: d.file.name, chars: d.text.length, included: true, truncated: slice.length < d.text.length });
  });

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

  /* The cover page outranks the release text. Levi's 10-K states fiscal
     year 2025 ended 30 November 2025 - labelled by the year it ENDS in - and
     one sentence in one release, comparing a quarter of fiscal 2024 with
     "fiscal 2023", out-voted it 1 to 0. Every Levi period then sat a year
     late, and seventeen results read as "the period had not ended". Text
     settles the convention only where the company's own cover page does not;
     where they disagree, the disagreement is recorded and the cover stands. */
  const fromCover = /Document Fiscal Year Focus/i.test(String((cal.meta && cal.meta.conventionFrom) || ""));
  if (fromCover && learned.offset !== cal.labelOffset) {
    return {
      ...cal,
      meta: { ...cal.meta, textDisagreed: { votes: learned.votes, evidence: learned.evidence } },
    };
  }

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

/**
 * THE ENDS OF A RANGE WRITTEN AS A MIDPOINT AND A BAND.
 *
 * Micron guides "Revenue $10.60 billion ± $200 million" and "Diluted EPS
 * $2.50 ± $0.15"; Nvidia "Revenue is expected to be $55.0 billion, plus or
 * minus 2%". The model reads those correctly as $10.40bn to $10.80bn, $2.35
 * to $2.65 and $53.9bn to $56.1bn - and the guard, finding no 10.40 or 10.80
 * in the sentence, decided both ends were invented and dropped the guide.
 * Micron's first backfill kept one guide in fourteen releases, and its
 * subscriber was told it gives too little guidance to score.
 *
 * The ends ARE in the sentence, as arithmetic the company wrote out: midpoint
 * minus band, midpoint plus band. Only those two numbers are added, and only
 * where the sentence says ±, +/- or "plus or minus". The band is read in the
 * company's own unit:
 *   $10.60 billion ± $200 million  -> 10.40 to 10.80 (band converted to billions)
 *   86.0% ± 1.0%                   -> 85 to 87 (percentage points)
 *   72.0%, plus or minus 50 basis points -> 71.5 to 72.5
 *   $55.0 billion, plus or minus 2%      -> 53.9 to 56.1 (2% OF the midpoint)
 */
const SCALE = { thousand: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9 };
const BAND_RE = new RegExp(
  "(-?\\$?\\s*-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(billion|million|thousand|bn|b|m|%|percent)?"
  + "\\s*,?\\s*(?:\u00b1|\\+\\s*\\/\\s*-|plus\\s+or\\s+minus)\\s*"
  + "(\\$?\\s*\\d[\\d,]*(?:\\.\\d+)?)\\s*(billion|million|thousand|bn|b|m|%|percent|basis\\s+points|bps)?",
  "gi"
);

export function bandEnds(quote) {
  const ends = new Set();
  const text = String(quote || "");
  const num = (s) => parseFloat(String(s).replace(/[$,\s]/g, ""));
  const tidy = (x) => Number(x.toFixed(6));

  for (const m of text.matchAll(BAND_RE)) {
    const mid = num(m[1]);
    const band = num(m[3]);
    if (!Number.isFinite(mid) || !Number.isFinite(band) || band <= 0) continue;

    const midUnit = (m[2] || "").toLowerCase();
    const bandUnit = (m[4] || "").toLowerCase().replace(/\s+/g, " ");
    const midIsPercent = midUnit === "%" || midUnit === "percent";

    let width;
    if (bandUnit === "basis points" || bandUnit === "bps") {
      width = band / 100;
    } else if (bandUnit === "%" || bandUnit === "percent") {
      // A percentage band on a percentage is points; on money it is a share
      // of the midpoint.
      width = midIsPercent ? band : Math.abs(mid) * band / 100;
    } else if (SCALE[bandUnit] && SCALE[midUnit]) {
      width = band * SCALE[bandUnit] / SCALE[midUnit];
    } else if (SCALE[bandUnit] && !midUnit) {
      // "$10,600 million ± $200 million" is caught above; a bare midpoint with
      // a scaled band is too ambiguous to guess at.
      continue;
    } else {
      width = band;
    }

    for (const e of [mid - width, mid + width]) {
      ends.add(tidy(e));
      // The model may give a billions figure in millions, as it does elsewhere.
      if (SCALE[midUnit] === 1e9) ends.add(tidy(e * 1000));
    }
  }

  /* "72.0% and 73.0%, respectively, plus or minus 50 basis points" - one band
     for several midpoints, so it sits next to none of them. Applied to every
     percentage in the same sentence before it, and only for a band in points. */
  const RESP = /respectively,?\s*(?:\u00b1|\+\s*\/\s*-|plus\s+or\s+minus)\s*(\d+(?:\.\d+)?)\s*(basis\s+points|bps|%|percent)/gi;
  for (const m of text.matchAll(RESP)) {
    const unit = m[2].toLowerCase();
    const width = /basis|bps/.test(unit) ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    const sentence = text.slice(0, m.index).split(/[.;](?=\s|$)/).pop();
    for (const p of sentence.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)) {
      const mid = parseFloat(p[1]);
      ends.add(tidy(mid - width));
      ends.add(tidy(mid + width));
    }
  }
  return ends;
}

function present(value, pool) {
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  for (const n of pool) {
    if (Math.abs(n - value) <= 0.0005) return true;
  }
  return false;
}

/* "+/- $50 billion" is "about $50 billion".
   Wells Fargo: "Expect 2026 net interest income to be +/- $50 billion". The
   model read a range from minus fifty to fifty, the minus fifty is not in the
   sentence, and the guide was dropped. A plus-or-minus sign BEFORE a lone
   figure means "approximately" - unlike Micron's "$2.64 ± $0.07", where the
   figure comes first and the sign introduces a tolerance. */
function aboutNotPlusMinus(g) {
  const m = String(g.quote || "").replace(/(\d),(?=\d{3})/g, "$1")
    .match(/(^|[^\d$.\s])\s*(?:\+\s?\/\s?-|\u00B1)\s*\$?\s?(\d+\.?\d*)/);
  if (!m) return g;
  const n = Number(m[2]);
  const nums = [g.low, g.high, g.value].filter((x) => typeof x === "number");
  if (!nums.length || !nums.every((x) => Math.abs(Math.abs(x) - n) < 1e-9)) return g;
  if (!nums.some((x) => x < 0)) return g;
  return { ...g, low: null, high: null, value: n, shape: "point", plus_minus_read_as: "about" };
}

/* THE EARLIER COLUMN IS NOT THE GUIDE.
   Lamb Weston's outlook table has two columns, the previous outlook and the
   updated one: "Net Sales 0.0% to 1.0% | Up Low Single Digits". Both came
   back as guides for the year - the words (read as 1% to 3%) and the old
   figures - and the email printed the old ones as "held" when the company
   had just raised them. Where one row yields a worded guide and a figure
   guide for the same measure and period, and the words come AFTER the
   figures in that row, the figures are the earlier column and are dropped. */
export function dropEarlierColumn(guides) {
  const flat = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9.%$ ]/g, " ").replace(/\s+/g, " ").trim();
  const drop = new Set();
  for (const w of guides) {
    if (!w.from_words || !w.period) continue;
    const words = flat(w.from_words);
    if (!words) continue;
    for (const f of guides) {
      if (f === w || f.from_words || f.period !== w.period) continue;
      if (metricKey(f) !== metricKey(w)) continue;
      const row = flat(f.quote);
      const at = row.indexOf(words);
      if (at < 0) continue;
      const lastDigit = row.slice(0, at).search(/\d[^\d]*$/);
      if (lastDigit < 0) continue;                       // no figure before the words
      if (/\d/.test(row.slice(at + words.length))) continue; // figures after them too: not this shape
      drop.add(f);
    }
  }
  return drop.size ? guides.filter((g) => !drop.has(g)) : guides;
}

/* A table row labelled as the guide is, whose last numbers are the guide's
   figures - at the same scale, a thousand times larger or a thousand times
   smaller ("$12,860" in millions for a guide of $12.86bn). */
function rowEndingIn(text, label, values) {
  const want = (values || []).filter((v) => typeof v === "number");
  const name = String(label || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || !name || !want.length || want.length > 2) return null;
  for (const raw of String(text).split("\n")) {
    if (raw.length > 400) continue;
    const firstDigit = raw.search(/[$(]?\s?\d/);
    if (firstDigit < 1) continue;
    const head = raw.slice(0, firstDigit).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    if (head !== name) continue;
    const nums = (raw.slice(firstDigit).replace(/(\d),(?=\d{3})/g, "$1").match(/\(?-?\d+\.?\d*\)?/g) || [])
      .map((x) => (/^\(/.test(x) ? -1 : 1) * Number(x.replace(/[()]/g, "")));
    if (nums.length < want.length + 1) continue;       // a row of one figure is not a table of periods
    const tail = nums.slice(-want.length);
    for (const scale of [1, 1000, 0.001]) {
      const sorted = (a) => a.slice().sort((x, y) => x - y);
      const t = sorted(tail.map((n) => n * scale));
      const w = sorted(want);
      if (t.every((n, i) => Math.abs(n - w[i]) <= Math.max(0.0005, Math.abs(w[i]) * 1e-6))) return raw.replace(/\s+/g, " ").trim();
    }
  }
  return null;
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
export function guardGuide(input, filingText) {
  const g = aboutNotPlusMinus(input.shape === "reaffirmed" ? recoverReaffirmed(input) : input);

  const pool = quoteNumbers(g.quote);
  for (const e of bandEnds(g.quote)) pool.add(e);
  /* "Flat" is zero, for a change. Delta's July 2025 release guided September
     quarter revenue "flat to up 4 percent compared to the prior year", and
     printed the same guide in its outlook table as "0% - 4%". The model
     quoted the sentence, the 0 was not in it, and the whole guide was dropped
     as unverified - so a guide the company printed twice was never scored.
     A change guided as "flat" means no change: 0, and nothing else. Only for
     changes (a percentage or growth guide), never for a level - "flat
     revenue" of a dollar amount has no number to stand for. */
  const isChange = g.unit === "percent" || /growth/.test(String(g.shape || ""));
  if (isChange && /\bflat\b/i.test(String(g.quote || ""))) pool.add(0);
  const stated = [];
  if (typeof g.low === "number") stated.push(["low", g.low]);
  if (typeof g.high === "number") stated.push(["high", g.high]);
  if (typeof g.value === "number") stated.push(["value", g.value]);

  if (!stated.length) return { ...g, numbers_verified: true };

  /* A YEAR IS NOT A FIGURE. UnitedHealth "affirmed the 2024 performance
     objectives established at its November 29th Investor Conference", and
     the guide came back as $29 to $2,024 a share: both numbers are in the
     sentence, so both passed. A whole number that reads as a year counts as
     the company's figure only where the sentence prints it as money or a
     percentage ("$2,024 million", "2,024%"); otherwise it is the date. */
  const plain = String(g.quote || "").replace(/(\d),(?=\d{3})/g, "$1");
  const isYear = (v) => Number.isInteger(v) && v >= 1990 && v <= 2100 && g.unit !== "other"
    && !new RegExp("\\$\\s?" + v + "\\b|\\b" + v + "\\s?(%|percent|million|billion|bn|bps|basis points)", "i").test(plain);
  const unsupported = stated.filter(([, v]) => !present(v, pool) || isYear(v)).map(([k, v]) => k + "=" + v);
  if (!unsupported.length) return { ...g, numbers_verified: true };

  /* THE FIGURE IS IN THE TABLE, THE QUOTE IS THE SENTENCE ABOVE IT.
     Netflix writes "Our summary results, and forecast for Q3, are below" and
     then a table whose last column is the forecast. The model read the table
     correctly - revenue $12,860m, operating income $4,268m, EPS $0.82 - and
     quoted the sentence, which has no number in it, so all three guides were
     stripped as unverified. Where the release has a row under the guide's
     own label that ENDS in the guided figure (or the two ends of the range),
     the figure is the company's and the row becomes the quote. Last column
     only: an earlier column is a past result. */
  const row = rowEndingIn(filingText, g.metric_as_written, stated.map(([, v]) => v));
  if (row && !stated.some(([, v]) => isYear(v))) {
    return { ...g, quote: row, quote_was: g.quote, numbers_verified: true, numbers_recovered: "table row" };
  }

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
 * ONE GUIDE PER MEASURE AND PERIOD WHEN A COMPANY GIVES TWO BASES.
 *
 * Micron's guidance table has a GAAP column and a non-GAAP column: operating
 * expenses "$1.60 billion" and "$1.40 billion", EPS "$18.90 ± $0.40" and
 * "$19.15 ± $0.40". Both came back under the same label and period, pairing
 * kept the first - the GAAP one - and scored it against the NON-GAAP result:
 * "operating expenses $1.60bn guided, $1.52bn reported" when the like-for-like
 * reading is $1.40bn guided, above. All eleven operating-expense rows and all
 * seven EPS rows were compared across bases, and the guide path read the two
 * columns as a cut from $1.60bn to $1.40bn.
 *
 * Where the twins carry different numbers, the non-GAAP one is kept: it is
 * what the company and the market judge the quarter on, and what the results
 * table is asked for. Where the numbers are the same (Micron's revenue is one
 * figure under both headings) the GAAP one is kept, so nothing that is not
 * adjusted gets asked for as if it were.
 *
 * Returns the set of guides to leave out. They still go into asExtracted, so
 * the questions asked of the next release do not change.
 */
function gaapTwins(guides) {
  const drop = new Set();
  const byKey = new Map();
  for (const g of guides) {
    if (!g.period) continue;
    const key = String(g.metric_as_written || "").trim().toLowerCase() + "|" + g.period;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(g);
  }
  const nums = (g) => [g.low, g.high, g.value].map((n) => (typeof n === "number" ? n : null)).join(",");
  for (const group of byKey.values()) {
    const gaap = group.filter((g) => g.basis === "gaap");
    const adjusted = group.filter((g) => g.basis === "non_gaap");
    if (!gaap.length || !adjusted.length) continue;
    const same = gaap.every((a) => adjusted.some((b) => nums(a) === nums(b)));
    for (const g of same ? adjusted : gaap) drop.add(g);
  }
  return drop;
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

/* ------------------------------------------------------------------ *
 * A second look at guidance lines the first reading skipped
 * ------------------------------------------------------------------ */

/* A line that carries a guide-shaped figure: a "±" band, or a range of
   dollars or percentages ("$1.25 - $1.75", "0% - 4%", "$60 to $63 billion"). */
const GUIDE_SHAPED = /±|(?:\$\s?\d[\d.,]*|\d[\d.,]*\s?%)\s*(?:-|–|—|to)\s*\$?\s?\d[\d.,]*\s?(?:%|billion|million)?/i;
const OUTLOOK_WORD = /\b(outlook|guidance|expects?|expected|anticipates?|forecast|targets?)\b/i;
const BOILERPLATE = /forward[-\s]looking statements?|safe harbor|private securities litigation/i;

/* The figures a line states, without the width of a "±" band: "38.5% ± 1.0%"
   states 38.5. */
function statedNumbers(line) {
  return quoteNumbers(String(line).replace(/±\s*\$?\s?[\d.,]+\s*(%|billion|million)?/gi, " "));
}

/**
 * Guide-shaped lines in an outlook passage that no reported guide accounts
 * for, each with the lines around it.
 *
 * Micron's September 2024 release printed its first-quarter outlook as a
 * table: revenue, gross margin, operating expenses, EPS, each "X ± Y". The
 * model reported three of the four rows and skipped gross margin, and the
 * record showed "Q1 2025 not guided" for a guide the company had printed. A
 * line is a candidate when it is guide-shaped, sits within a few dozen lines
 * after an outlook word (not the safe-harbour paragraph), and none of its
 * figures appears in any guide already reported. Free: no model involved.
 */
export function missedGuideLines(text, guides) {
  const lines = String(text || "").split("\n");
  const pool = new Set();
  for (const g of guides || []) {
    for (const n of quoteNumbers(g.quote)) pool.add(n);
    for (const k of ["low", "high", "value"]) if (typeof g[k] === "number") pool.add(g[k]);
  }
  const covered = (n) => [...pool].some((x) => Math.abs(x - n) <= 0.0005);

  let lastOutlook = -1000;
  const hits = [];
  lines.forEach((line, i) => {
    if (BOILERPLATE.test(line)) { lastOutlook = -1000; return; }
    if (OUTLOOK_WORD.test(line)) lastOutlook = i;
    if (i - lastOutlook > 40) return;
    /* Guide-shaped, or a sentence that says it is a guide. Broadcom writes
       "we expect AI semiconductor revenue to double year-over-year to $8.2
       billion" - no range, no band, and a guide all the same. */
    const sentenceGuide = OUTLOOK_WORD.test(line) && /\$\s?\d|\d\s?%/.test(line);
    if (!GUIDE_SHAPED.test(line) && !sentenceGuide) return;
    const nums = [...statedNumbers(line)].filter((n) => n !== 0 || /\b0(\.0+)?\s?%/.test(line));
    if (!nums.length) return;
    /* A results row, not a guide row. FactSet's results table carries a
       "guidance" column beside the year's actuals ("Revenues $535,797 ...
       $2,085,508 ... $2.08 - $2.10B"), and Honeywell's sets last year's
       results beside this year's guides on one line; read alone, the range
       was given the wrong year. A guide row states one figure or one range
       for each of at most two columns (GAAP and adjusted): four figures. */
    /* ...but only for a ROW. A sentence carries more figures than four
       easily and is still a guide: FactSet's "Fiscal 2024 guidance update:
       expected ASV plus professional services growth of 5-7%, GAAP revenue
       growth of 5.5-6%" has five, and was lost when every line over four
       was skipped. A row is mostly figures; a sentence is mostly words. */
    const words = (line.match(/[A-Za-z]{2,}/g) || []).length;
    if (nums.length > 4 && words < 2 * nums.length) return;
    /* Not from a reconciliation. General Electric's January 2024 release
       reconciles GE VERNOVA's free cash flow guide under its own heading,
       and "CFOA (GAAP) $1.5 - $1.9" was taken for General Electric's own
       cash flow. Reconciliations restate guides already given in the
       outlook, often for a part of the company; the outlook is where a
       skipped guide is looked for. */
    const before = lines.slice(Math.max(0, i - 40), i).join(" ");
    if (/reconcil/i.test(before)) return;
    if (nums.some(covered)) return;
    hits.push(i);
  });
  if (!hits.length) return [];

  // Each hit with the twelve lines before it (the table's header and the
  // row's label are usually there) and two after; overlapping windows merge.
  const windows = [];
  for (const i of hits) {
    const a = Math.max(0, i - 12), b = Math.min(lines.length - 1, i + 2);
    const last = windows[windows.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else windows.push([a, b]);
  }
  return windows.map(([a, b]) => lines.slice(a, b + 1).join("\n"));
}

async function secondLookGuides(env, filing, guides) {
  const snippets = missedGuideLines(filing.text, guides);
  if (!snippets.length) return { asked: 0, found: [] };
  const intro = String(filing.text).slice(0, 1200);
  const text = "THE START OF THE RELEASE (for its date and the period it reports):\n" + intro
    + "\n\nPASSAGES FROM THE SAME RELEASE THAT MAY CONTAIN GUIDANCE:\n"
    + snippets.join("\n=====\n");
  let extra = [];
  try {
    extra = await callModel(env, text);
  } catch (e) {
    console.log("Guidance second look failed for " + filing.accession + ": " + e.message);
    return { asked: snippets.length, found: [] };
  }
  // Only what the first reading did not already have.
  const pool = new Set();
  for (const g of guides) for (const k of ["low", "high", "value"]) if (typeof g[k] === "number") pool.add(g[k]);
  const found = extra.filter((g) => {
    const v = [g.low, g.high, g.value].filter((x) => typeof x === "number");
    return v.length && !v.every((x) => pool.has(x));
  }).map((g) => ({ ...g, second_look: true }));
  for (const g of found) console.log("Guidance second look " + filing.accession + ": found " + g.metric_as_written + " " + (g.period_text || "") + " " + JSON.stringify([g.low, g.high, g.value]));
  return { asked: snippets.length, found };
}


/* ------------------------------------------------------------------ *
 * Scope: the whole company, or one part of it
 * ------------------------------------------------------------------ */

/* Words that open a line without naming a part of the company. */
const NOT_A_PART = /^(now|also|still|currently|today|additionally|further|enterprise|fiscal|full|year|years|quarter|first|second|third|fourth|q[1-4]|fy\d*|h[12]|guidance|outlook|update|updated|company|consolidated|total|enterprise|gaap|non|adjusted|reported|organic|comparable|net|the|our|we|expected|expectations|reaffirmed|raised|lowered|note|notes|and|of|for|in)$/i;


/* The company's own name, from its headline: "GE ANNOUNCES FOURTH QUARTER
   2023 RESULTS", "GE AEROSPACE REPORTS ...". Null when the headline does not
   say. */
export function companyFromIntro(intro) {
  const t = String(intro || "").replace(/=====[^=]*=====/g, " ")
    .replace(/\bEX-99[\.\d]*\b|\bDocument\b|\bFOR IMMEDIATE RELEASE\b|\bNEWS RELEASE\b|\bPRESS RELEASE\b/gi, " ")
    .replace(/\s+/g, " ");
  const m = t.match(/\b([A-Z][A-Za-z&.'\-]*(?:\s+[A-Z][A-Za-z&.'\-]*){0,3})\s+(?:ANNOUNCES|REPORTS|POSTS|DELIVERS|Announces|Reports|Posts|Delivers)\b/);
  return m ? m[1].trim() : null;
}

/* Is this name the company itself? By its headline name when there is one -
   "GE" and "GE Aerospace" are General Electric, "GE Vernova" (its business
   being spun off) is not. Without a headline, any name in the opening lines
   is taken as the company, as before. */
function isTheCompany(name, intro) {
  const co = companyFromIntro(intro);
  const n = String(name || "").toLowerCase().trim();
  if (co) {
    const c = co.toLowerCase();
    // "McCormick" in "McCORMICK REPORTS"; "GE" in "GE AEROSPACE REPORTS".
    return n === c || c.startsWith(n + " ") || c.endsWith(" " + n);
  }
  return Boolean(intro) && new RegExp("\\b" + escapeRe(String(name)) + "\\b").test(String(intro));
}

/* Abbreviations that name a measure or a unit, never a part. */
const COMMON_ABBR = /^(GAAP|EPS|FCF|EBIT|EBITDA|EBITDAR|CEO|CFO|COO|US|USA|USD|UK|EU|FY|YOY|YTD|QTD|ROIC|ROE|ROA|CAPEX|SG|SGA|ASV|ARR|NII|NIM|RPM|TRASM|CASM|PRASM|ASM|RASM|AI|IT|ESG|LLC|INC|PLC|CORP|THE|WE|Q[1-4]|H[12])$/;

/* A measure, not a part: "Tax rate: reported approximately 20%" opens with
   what is guided, not with where. */
const MEASURE_WORD = /\b(rate|sales|revenues?|income|margins?|eps|earnings|cash|flows?|costs?|expenses?|capex|capital|tax|shares?|dividends?|ebitda|profit|growth|outlook|guidance|appendix|summary|highlights?)\b/i;

function isPartName(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (/\d/.test(name)) return false;
  if (MEASURE_WORD.test(name)) return false;
  return words.some((w) => !NOT_A_PART.test(w.replace(/[^A-Za-z]/g, "")));
}

/* "Wine and Spirits: organic net sales decline" -> "Wine and Spirits". */
function prefixPart(text) {
  const m = String(text || "").match(/^\s*([A-Z][A-Za-z&'.\- ]{1,48}?)\s*:\s/);
  return m && isPartName(m[1]) ? m[1].trim() : null;
}

/**
 * The parts a release names: from labels and lines that open with a part
 * ("Beer: net sales growth of 0% - 3%") and from lines that call one a
 * segment or division ("for the Aerospace segment").
 */
export function partsNamed(guides, intro) {
  const names = new Set();
  // Found only as the subject of "expects" - the company's own name can turn
  // up that way, so these alone are checked against the top of the release.
  // A part named as a heading ("Beer:") is a part even when the release's
  // headline mentions it - Constellation's does, and its Beer guides were
  // lost when every name in the headline was dropped.
  const bySubject = new Set();
  for (const g of guides || []) {
    for (const t of [g.metric_as_written, g.quote]) {
      const p = prefixPart(t);
      if (p) names.add(p);
    }
    /* "Business" too, and at the start of a sentence. Constellation writes
       "The Wine and Spirits Business expects organic net sales decline of
       5 - 8%"; only "segment", "division" and "business unit" were known, and
       only after a lower-case "the" - so the guide was read as the company's,
       and scored against the company's sales as a 13-point beat. */
    const re = /\b(?:[Tt]he|[Oo]ur|[Ii]ts)\s+([A-Z][A-Za-z&' ]{1,48}?)\s+(?:segment|division|business unit|[Bb]usiness)(?:es|s)?\b/g;
    let m;
    while ((m = re.exec(String(g.quote || "")))) if (isPartName(m[1])) names.add(m[1].trim());
    /* A part named by its initials as the subject of the guide. General
       Electric writes "DPT expects operating profit of $1.6-$1.7 billion" -
       its Defense & Propulsion Technologies segment - and the guide was read
       as the company's operating profit, then "revised" from $9.85bn to
       $1.55bn as a scope change. Two to five capitals, not a common
       accounting abbreviation, doing the expecting. */
    // The subject doing the expecting: initials ("DPT expects") or a short
    // proper name ("GE Vernova expects"). The company itself is removed
    // below, by its name at the top of the release.
    const subject = /\b((?:[A-Z][A-Za-z&]*\s+){0,2}[A-Z][A-Za-z&]*)\s+(?:now\s+|still\s+|also\s+)?(?:continues to\s+)?expects?\b/g;
    while ((m = subject.exec(String(g.quote || "")))) {
      const n = m[1].trim();
      if (/^(the|we|our|it|this|management|company|in|for|and)\b/i.test(n)) continue;
      if (COMMON_ABBR.test(n)) continue;
      if ((/^[A-Z]{2,5}$/.test(n) || isPartName(n)) && !names.has(n)) bySubject.add(n);
    }
    // "Defense & Propulsion Technologies (DPT)": the name and its initials.
    const pair = /([A-Z][A-Za-z&' ]{2,48}?)\s*\(([A-Z]{2,5})\)/g;
    for (const t of [g.metric_as_written, g.quote]) {
      while ((m = pair.exec(String(t || "")))) {
        if (isPartName(m[1]) && !COMMON_ABBR.test(m[2])) { names.add(m[1].trim()); names.add(m[2]); }
      }
    }
  }
  /* A name on most of the guides is the company, not a part of it ("Carnival
     Corporation & plc: ..."). */
  const all = (guides || []).length;
  const top = String(intro || "");
  for (const n of bySubject) {
    if (names.has(n)) continue;
    // The company itself, named at the top of its own release ("GE
    // Aerospace reports...", "GE expects..."): not a part of itself.
    if (top && isTheCompany(n, top)) continue;
    // Not the tail of a longer name: "Wine and Spirits Business expects"
    // must not yield "Spirits Business".
    if ((guides || []).some((g) => new RegExp("(and|&)\\s+" + escapeRe(n) + "\\b").test(String(g.quote || "")))) continue;
    names.add(n);
  }
  return [...names].filter((n) => {
    if (/\b(inc|corp|corporation|company|plc|ltd|limited|holdings?|group)\b/i.test(n)) return false;
    const re = new RegExp("\\b" + escapeRe(n) + "\\b", "i");
    const on = (guides || []).filter((g) => re.test(String(g.quote || "")) || re.test(String(g.metric_as_written || ""))).length;
    return all < 4 || on / all <= 0.6;
  });
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Put the part back into a guide's label when the model left it out.
 *
 * Constellation Brands' "Wine and Spirits: organic net sales decline of 17% -
 * 20%" came back labelled "organic net sales". The result was then looked up
 * for the whole company - consolidated organic net sales, down 3.8% - and a
 * guide for one part was scored against the total, "above". A part can be
 * named anywhere in the line, so the part chosen is the one named closest
 * BEFORE the guide's own figures ("Beer net sales growth of 0% - 3%; Wine
 * and Spirits decline of 17% - 20%" gives each range its own part).
 * Deterministic and free.
 */
export function scopeByName(guides, intro) {
  const parts = partsNamed(guides, intro);
  if (!parts.length) return guides;
  return guides.map((g) => {
    const label = String(g.metric_as_written || "");
    const inLabel = parts.find((n) => new RegExp("\\b" + escapeRe(n) + "\\b", "i").test(label));
    if (inLabel) return { ...g, segment: inLabel };
    const quote = String(g.quote || "");
    const fig = [g.low, g.high, g.value].find((x) => typeof x === "number");
    // Where the guide's figure sits in its line.
    let at = -1;
    if (typeof fig === "number") {
      const forms = [String(Math.abs(fig)), Math.abs(fig).toFixed(1), Math.abs(fig).toFixed(2)];
      for (const f of forms) { const i = quote.indexOf(f); if (i >= 0 && (at < 0 || i < at)) at = i; }
    }
    if (at < 0) return g;
    let best = null, bestAt = -1;
    for (const n of parts) {
      const re = new RegExp("\\b" + escapeRe(n) + "\\b", "gi");
      let m;
      while ((m = re.exec(quote))) if (m.index < at && m.index > bestAt) { best = n; bestAt = m.index; }
    }
    if (!best) return g;
    return { ...g, segment: best, metric_as_written: best + ": " + label, scope_from: "named in the line" };
  });
}


/* A short line on its own that names something: a heading. */
function isHeading(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 70 || /\d/.test(t) || /[.;:]$/.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length <= 8 && /^[A-Z]/.test(t);
}

/**
 * Part names a release prints as headings: "Commercial Engines & Services
 * (CES)", "Defense & Propulsion Technologies (DPT)". Both the name and the
 * initials are parts.
 */
export function partsFromHeadings(text) {
  const out = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!isHeading(line)) continue;
    const m = line.trim().match(/^([A-Z][A-Za-z&' ]{2,60}?)\s*\(([A-Z]{2,5})\)$/);
    if (m && isPartName(m[1]) && !COMMON_ABBR.test(m[2])) { out.add(m[1].trim()); out.add(m[2]); }
  }
  return [...out];
}

/**
 * The part a guide belongs to when its own line does not say, read from
 * where the line sits in the release.
 *
 * General Electric's April 2026 release: under the heading "Commercial
 * Engines & Services (CES)", one paragraph reads "In 2026, CES continues to
 * expect revenue growth of mid-teens ... Operating profit continues to be
 * expected in the range of $9.6-$9.9 billion." The guide's own sentence names
 * no part, so the $9.6bn-9.9bn was read as GE's company operating profit and
 * "cut" from $9.85bn-10.25bn. Two places are read, nearest first:
 *   1. the same paragraph, before the guide's sentence - the last part named
 *      there ("CES continues to expect ...");
 *   2. the nearest heading above it. A heading naming a part gives that part;
 *      any other heading ("2026 Guidance", "Outlook") stops the search with
 *      no change - the guide is the company's.
 * Only for parts the release itself names. Free and deterministic.
 */
export function scopeByPlace(guides, text) {
  const lines = String(text || "").split("\n");
  const intro = String(text || "").slice(0, 600);
  // Not the company itself: a heading or subject that also names the company
  // at the top of its own release ("GE Aerospace") is not a part.
  const known = new Set([...partsNamed(guides, intro), ...partsFromHeadings(text)]
    .filter((n) => !isTheCompany(n, intro)));
  if (!known.size) return guides;
  const parts = [...known];
  const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const lastPartIn = (t) => {
    let best = null, at = -1;
    for (const n of parts) {
      const re = new RegExp("\\b" + escapeRe(n) + "\\b", "g");
      let m;
      while ((m = re.exec(t))) if (m.index > at) { best = n; at = m.index; }
    }
    return best;
  };
  return guides.map((g) => {
    if (g.segment) return g;
    const q = norm(g.quote);
    if (q.length < 20) return g;
    const probe = q.slice(0, 50);
    const i = lines.findIndex((l) => norm(l).includes(probe));
    if (i < 0) return g;
    // The guide's own sentence says the company is speaking ("GE Aerospace
    // expects ..."): it is the company's guide, whatever came before it.
    {
      const own = /\b((?:[A-Z][A-Za-z&]*\s+){0,2}[A-Z][A-Za-z&]*)\s+(?:now\s+|still\s+|also\s+)?(?:continues to\s+)?expects?\b/g;
      let om;
      while ((om = own.exec(q))) {
        const who = om[1].trim();
        if (isTheCompany(who, intro)) return g;
        // ...or a part speaking in the guide's own sentence: that part, and
        // not whichever part a sentence earlier named. ("GE Aerospace
        // expects adjusted revenue..." after a sentence on GE Vernova.)
        const own2 = parts.find((n) => n.toLowerCase() === who.toLowerCase());
        if (own2) {
          if (parts.some((n) => new RegExp("\\b" + escapeRe(n) + "\\b", "i").test(String(g.metric_as_written || "")))) return g;
          return { ...g, segment: own2, metric_as_written: own2 + ": " + g.metric_as_written, scope_from: "named in the line" };
        }
      }
    }
    const line = norm(lines[i]);
    // 1. Same paragraph, before the guide's own sentence - and only where the
    //    part is the subject of a guiding verb ("CES continues to expect"),
    //    not merely the row before in a flattened table.
    const before = line.slice(0, line.indexOf(probe));
    let part = null;
    if (before) {
      const cand = lastPartIn(before);
      const verb = "[^.]{0,40}\\b(expects?|continues|affirm\\w*|reaffirm\\w*|guid\\w*|anticipates?|projects?|sees)\\b";
      if (cand && new RegExp("\\b" + escapeRe(cand) + "\\b" + verb, "i").test(before)) {
        /* ...unless the company itself speaks AFTER that part and before the
           guide. GE's January 2024 paragraph gives GE Vernova's outlook,
           then "GE Aerospace expects adjusted revenue to grow low double
           digits" - the nearest subject is GE Aerospace, the company. */
        const candAt = before.lastIndexOf(cand);
        const subj = /\b((?:[A-Z][A-Za-z&]*\s+){0,2}[A-Z][A-Za-z&]*)\s+(?:now\s+|still\s+|also\s+)?(?:continues to\s+)?expects?\b/g;
        let sm, companyLater = false;
        while ((sm = subj.exec(before))) {
          if (sm.index > candAt && isTheCompany(sm[1].trim(), intro)) companyLater = true;
        }
        if (!companyLater) part = cand;
      }
    }
    // 2. The nearest heading above.
    if (!part) {
      for (let j = i - 1; j >= Math.max(0, i - 25); j--) {
        if (!isHeading(lines[j])) continue;
        // A row label inside a table ("Defense & Propulsion Technologies
        // (DPT) Operating Profit") names a measure: the guide sits in a
        // table, not under a part's heading. Nothing is taken from it.
        if (MEASURE_WORD.test(lines[j])) break;
        part = lastPartIn(lines[j]);
        break;
      }
    }
    if (!part) return g;
    // A guide whose label already names some part keeps its own.
    if (parts.some((n) => new RegExp("\\b" + escapeRe(n) + "\\b", "i").test(String(g.metric_as_written || "")))) return g;
    return { ...g, segment: part, metric_as_written: part + ": " + g.metric_as_written, scope_from: "where it sits in the release" };
  });
}

/* The few guides the names cannot settle: their line speaks of a segment or
   division the release never names as a part. One short, saved question. */
async function scopeByModel(env, guides, accession) {
  const ask = [];
  guides.forEach((g, i) => {
    if (g.segment) return;
    /* "Segment margin" and "segment profit" are company-wide measures
       (Honeywell guides its total segment margin), not a part: the word
       only counts when it is not naming the measure itself. */
    const q = String(g.quote || "").replace(/\bsegment\s+(margin|profit|income|ebitda|operating)/gi, " ");
    if (/\b(segments?|divisions?|business units?)\b/i.test(q)) ask.push(i);
  });
  if (!ask.length) return { guides, asked: 0 };
  const list = ask.map((i, j) => ({ id: j, label: guides[i].metric_as_written, line: guides[i].quote }));
  let answer = [];
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.DEEPSEEK_API_KEY },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Each item is one guidance figure from a company's earnings release, with the line it came from. Say whether the figure covers the WHOLE company or only ONE PART of it (a segment, division, business unit, region or brand). Use only the line. Return JSON: {\"scopes\":[{\"id\":0,\"scope\":\"company\"|\"part\",\"part\":\"the part's name as written, or null\"}]}." },
          { role: "user", content: JSON.stringify(list) },
        ],
      }),
    });
    if (r.ok) {
      const data = await r.json();
      const content = ((data.choices || [])[0] || {}).message?.content || "{}";
      answer = JSON.parse(content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()).scopes || [];
    }
  } catch (e) {
    console.log("Scope check failed for " + accession + ": " + e.message);
  }
  const out = guides.slice();
  for (const a of answer) {
    const i = ask[Number(a.id)];
    if (i === undefined || a.scope !== "part" || !a.part) continue;
    const part = String(a.part).trim();
    // A real part's name, not a measure or a footnoted heading
    // ("Segment Margin 2", "Segment").
    if (!isPartName(part) || /^(segment|division|business|unit)s?$/i.test(part)) continue;
    // The part must be printed in the line itself; nothing is taken on trust.
    if (!new RegExp("\\b" + escapeRe(part) + "\\b", "i").test(String(out[i].quote || ""))) continue;
    out[i] = { ...out[i], segment: part, metric_as_written: part + ": " + out[i].metric_as_written, scope_from: "scope check" };
    console.log("Scope check " + accession + ": " + out[i].metric_as_written);
  }
  return { guides: out, asked: ask.length };
}


/* ------------------------------------------------------------------ *
 * Guidance in words: "high-single digits", "mid-teens", "mid-20s"
 * ------------------------------------------------------------------ */

/* The street convention, fixed in code (approved 1 Oct 2026). The model
   never chooses a range: the same words give the same range every time. */
const TIER = { low: [1, 3], mid: [4, 6], high: [7, 9] };
const TEENS = { low: [11, 13], mid: [14, 16], high: [17, 19] };

/* One phrase as a range of whole percentages, or null. */
function phraseRange(tierA, tierB, kind, decade) {
  const a = String(tierA || "").toLowerCase();
  const b = String(tierB || a).toLowerCase();
  if (!TIER[a] || !TIER[b]) return null;
  if (kind === "single") return [TIER[a][0], TIER[b][1]];
  if (kind === "double") return a === "low" && b === "low" ? [10, 13] : null;
  if (kind === "teens") return [TEENS[a][0], TEENS[b][1]];
  if (kind === "decade") {
    const d = Number(decade);
    if (!d || d < 20 || d > 90) return null;
    return [d + TIER[a][0] - (a === "low" ? 1 : 0), d + TIER[b][1]];
  }
  return null;
}

/* Two-sided phrases written out in full, read before the single ones:
   RPM's "high-single to low-double-digit" (7-13%) and "low-single- to
   mid-single-digit" (1-6%). Read as one phrase, never as their second half. */
const SPAN_PHRASE = /\b(low|mid|high)[-\s]*single[-\s]*(?:digit)?[-\s]*(?:to|and)[-\s]+(?:(low|mid|high)[-\s]*single[-\s]*digits?|(low)[-\s]*double[-\s]*digits?)/gi;

const WORD_PHRASE = new RegExp(
  "\\b(flat)\\b(?:\\s+to\\s+(up|down)\\s+)?"
  + "|\\b(low|mid|high)(?:[-\\s]+(?:to|and)[-\\s]+(low|mid|high))?[-\\s]*"
  + "(?:(single)[-\\s]*digits?|(double)[-\\s]*digits?|(teens)|(20|30|40|50)s|(20|30|40|50)[-\\s]*(?:percent|%))",
  "gi");

const DOWN = /\b(declin\w*|decreas\w*|down|lower|drop\w*|fall\w*|contract\w*|negative)\b/i;
const UP = /\b(grow\w*|growth|increas\w*|up|rise|rising|higher|expan\w*|positive)\b/i;

/**
 * Read a guide given in words as a range, the way the street reads it.
 *
 * Nike's October 2026 release: "Revenues are expected to decline high-single
 * digits in fiscal 2027"; "Effective tax rate ... in the mid-20 percent
 * range". Neither had a number, so neither was scored. Read by the fixed
 * table above: decline 7%-9%, and 24%-26%.
 *
 * Only for a guide with NO figures of its own, only for a rate or a change
 * (a percentage), and only when the sentence is clear: one phrase - or the
 * phrase nearest the measure's own name - and, for a change, a direction.
 * Anything less clear is left as words. The words are kept on the guide
 * (from_words) so the email always shows what the company actually said.
 */
export function rangeFromWords(g) {
  if ([g.low, g.high, g.value].some((x) => typeof x === "number")) return g;
  const quote = String(g.quote || "");
  const found = [];
  let m;
  const taken = [];
  SPAN_PHRASE.lastIndex = 0;
  while ((m = SPAN_PHRASE.exec(quote))) {
    const a = TIER[m[1].toLowerCase()];
    const r = m[2] ? [a[0], TIER[m[2].toLowerCase()][1]] : [a[0], 13];
    found.push({ at: m.index, text: m[0].trim(), r, flat: false, flatTo: null, isLevel: false });
    taken.push([m.index, m.index + m[0].length]);
  }
  WORD_PHRASE.lastIndex = 0;
  while ((m = WORD_PHRASE.exec(quote))) {
    if (taken.some(([x, y]) => m.index >= x && m.index < y)) continue;
    let r = null, flat = false, flatTo = null;
    if (m[1]) { flat = true; flatTo = m[2] ? m[2].toLowerCase() : null; }
    else if (m[5]) r = phraseRange(m[3], m[4], "single");
    else if (m[6]) r = phraseRange(m[3], m[4], "double");
    else if (m[7]) r = phraseRange(m[3], m[4], "teens");
    else if (m[8] || m[9]) r = phraseRange(m[3], m[4], "decade", m[8] || m[9]);
    found.push({ at: m.index, text: m[0].trim(), r, flat, flatTo, isLevel: Boolean(m[8] || m[9]) });
  }
  if (!found.length) return g;
  found.sort((x, y) => x.at - y.at);

  // "flat to up low-single digits" is one phrase: 0 to the top of the next.
  const merged = [];
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    /* "Flat to up slightly" has no second phrase to read: Walmart's capex
       guide. The whole guide stays as words rather than become "flat". */
    if (f.flat && f.flatTo && !(found[i + 1] && found[i + 1].r)) return g;
    if (f.flat && f.flatTo && found[i + 1] && found[i + 1].r) {
      const n = found[i + 1];
      merged.push({ at: f.at, text: quote.slice(f.at, n.at + n.text.length), r: f.flatTo === "up" ? [0, n.r[1]] : [-n.r[1], 0], signed: true, isLevel: false });
      i++;
    } else if (f.flat) {
      merged.push({ at: f.at, text: f.text, r: [0, 0], signed: true, isLevel: false });
    } else if (f.r) merged.push(f);
  }
  if (!merged.length) return g;

  // Which phrase belongs to this guide: the only one, or the one nearest
  // AFTER the measure's own name in the sentence.
  let pick = null;
  if (merged.length === 1) pick = merged[0];
  else {
    const word = String(g.metric_as_written || "").toLowerCase()
      .replace(/\b(adjusted|reported|gaap|non-gaap|organic|diluted|net|total|fiscal|full[- ]year)\b/g, " ")
      .trim().split(/\s+/).find((w) => w.length > 2);
    const at = word ? quote.toLowerCase().indexOf(word) : -1;
    if (at < 0) return g;
    const after = merged.filter((f) => f.at > at).sort((a, b) => a.at - b.at);
    if (!after.length) return g;
    /* A table row with several phrases side by side - General Electric's
       "Adjusted Revenue Growth  +10%  $35.1B  +Mid-teens  +High-teens" -
       is columns, not clauses: which column is the guide in force is not
       in the words. Left as words. */
    if (after.length > 1) {
      const between = quote.slice(after[0].at + after[0].text.length, after[1].at);
      if (!/[a-z]{3,}/i.test(between)) return g;
    }
    pick = after[0];
  }

  // A level ("tax rate in the mid-20 percent range") or a change.
  const rate = /\b(rate|margin)\b/i.test(String(g.metric_as_written || "")) && !UP.test(quote) && !DOWN.test(quote);
  // "Gross margin about flat" means unchanged from last year - a level we
  // do not have here. Left as words.
  if (pick.signed && /\b(rate|margin)\b/i.test(String(g.metric_as_written || ""))) return g;
  let lo = pick.r[0], hi = pick.r[1];
  if (!pick.signed && !(rate || pick.isLevel)) {
    // The direction word can sit before the phrase ("decline high-single
    // digits") or just after it ("low-single-digit organic revenue growth").
    const before = quote.slice(Math.max(0, pick.at - 70), pick.at + pick.text.length + 40);
    const down = DOWN.test(before), up = UP.test(before);
    if (down === up) return g;           // no direction, or both: leave as words
    if (down) [lo, hi] = [-hi, -lo];
  }
  const isChange = !(rate || pick.isLevel);
  return {
    ...g,
    low: lo === hi ? null : lo,
    high: lo === hi ? null : hi,
    value: lo === hi ? lo : null,
    unit: "percent",
    shape: isChange ? (lo === hi ? "growth_point" : "growth_range") : (lo === hi ? "point" : "range"),
    from_words: pick.text,
    numbers_verified: true,
  };
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
export async function guidanceFrom(env, cik, release, cal, readAlready) {
  // readAlready: the filing, when the caller has already read it (the
  // update search below reads every candidate to filter it, and fetching it
  // twice would double the SEC calls for nothing).
  const filing = readAlready || await readFiling(env, cik, release.accession);
  const calendar = cal ? refineCalendar(cal, filing.text) : null;

  const first = await callModel(env, filing.text);
  // Guide-shaped lines the first reading skipped get one more, short ask.
  // A NEW question, paid once and saved; the first answer is untouched.
  const second = await secondLookGuides(env, { ...filing, accession: release.accession }, first);
  // Which part of the company each guide covers, when it is a part.
  const named = scopeByPlace(
    scopeByName(first.concat(second.found), String(filing.text || "").slice(0, 600)),
    filing.text);
  const scoped = await scopeByModel(env, named, release.accession);
  const raw = scoped.guides;

  const withPeriodsAll = raw.map((g) => guardGuide(g, filing.text)).map(rangeFromWords).map((g) => {
    const r = calendar
      ? resolvePeriod(g.period_text, calendar, { referenceDate: release.filed, direction: "future" })
      : { period: null, why: "No fiscal calendar was supplied." };
    return { ...g, period: r.period, period_how: r.how || null, period_why: r.why || null };
  });
  const withPeriods = dropEarlierColumn(withPeriodsAll);

  // Every guide as extracted, in order - what the next release is ASKED
  // about. Kept unchanged so the backfill sends the model the same questions
  // it always has and reuses the saved answers.
  /* The name the company goes by in THIS release's headline, kept on every
     guide. A part of the company can later BECOME the company: in January
     2024 "GE Aerospace" was one business inside GE, and from April 2024 it
     was the whole company. Its January guide ("GE Aerospace: operating
     profit") and the later ones ("operating profit") are then the same line,
     and the later one replaces the earlier - see guidesToCarry and
     revisionsBetween, which compare a part's name with this. */
  const saidBy = companyFromIntro(String(filing.text || "").slice(0, 600));
  const asExtracted = dedupeGuides(withPeriods).map((g) => (saidBy ? { ...g, said_by: saidBy } : g));
  // What is scored, tracked and revised: the same, without currency and deal
  // effects. Set aside rather than hidden - listed in the backfill summary.
  const effects = asExtracted.filter(isEffectGuide);
  const twins = gaapTwins(asExtracted);
  const guides = asExtracted.filter((g) => !isEffectGuide(g) && !twins.has(g));

  /* THE OUTLOOK FILED BESIDE THE RELEASE.
   *
   * JPMorgan's earnings release carries no outlook at all. Its outlook is a
   * slide in the earnings presentation, filed the same day as an 8-K of its
   * own (item 7.01) - and readable, because the filing carries the slides'
   * text. Reading only the 2.02 filing, the company looked as though it gave
   * no guidance.
   *
   * So when a release has NO guide with a figure, the other 8-Ks filed that
   * day are read as part of it. Only then: a release that guides on its own
   * is left exactly as it was, with the same questions and saved answers.
   * Not for an update filing (readAlready), which is one of these itself.
   */
  const companions = [];
  if (!readAlready && !guides.some(hasFigure)) {
    let sameDay = [];
    try {
      sameDay = (await updateCandidates(env, cik)).filter((f) => f.filed === release.filed
        && f.accession !== release.accession && !/(^|[^0-9.])2\.02([^0-9]|$)/.test(String(f.items || "")));
    } catch {
      sameDay = [];
    }
    for (const f of sameDay.slice(0, MAX_COMPANIONS)) {
      try {
        const beside = await readFiling(env, cik, f.accession);
        if (!looksLikeGuidance(beside.text)) continue;
        const g = await guidanceFrom(env, cik, f, calendar || cal, beside);
        // A figure for a period already over is a result on a slide, not a guide.
        const open = (x) => !(x.period && (calendar || cal) && periodIsClosedBy(x.period, f.filed, calendar || cal));
        const tag = (x) => ({ ...x, filed_beside: f.accession });
        const add = (g.guides || []).filter(open).map(tag);
        if (!add.length) continue;
        guides.push(...add);
        asExtracted.push(...(g.asExtracted || []).filter(open).filter((x) => !isEffectGuide(x)).map(tag));
        companions.push({ accession: f.accession, items: f.items, guides: add.length });
      } catch (e) {
        console.error("Filing beside the release " + f.accession + " could not be read: " + e.message);
      }
    }
  }

  return {
    release: {
      accession: release.accession,
      filed: release.filed,
      items: release.items,
      pickedBy: filing.pickedBy,
      files: filing.files,
      textChars: filing.chars,
      companions,
    },
    calendar,
    scopeAsked: scoped.asked,
    secondLookAsked: second.asked,
    secondLookFound: second.found.length,
    guarded: guides.filter((g) => g.numbers_verified === false).length,
    recovered: guides.filter((g) => g.numbers_recovered).length,
    unresolvedPeriods: guides.filter((g) => !g.period).length,
    guides,
    effects,
    asExtracted,
  };
}

/* ------------------------------------------------------------------ *
 * Guidance updated between earnings releases
 * ------------------------------------------------------------------ */

/**
 * WHY THIS EXISTS.
 *
 * On 10 March 2025 Delta cut its first-quarter guide - revenue growth from
 * 7-9% to 3-4%, operating margin from 6-8% to 4-5%, EPS from $0.70-$1.00 to
 * $0.30-$0.50 - in an 8-K filed ahead of an investor conference. It then
 * reported 3.3%, 4.6% and $0.46: inside all three cut ranges. The record
 * scored them against January's guide and called all three misses, because
 * only earnings releases were read, and a second item 2.02 filing inside 45
 * days was merged away as the same event.
 *
 * The guide a result is measured against is the one in force when the
 * period ended. So every 8-K between two earnings releases that could carry
 * guidance is looked at, and any it carries overrides the earlier guide for
 * the same measure and period.
 */

const UPDATE_ITEMS = /(^|[^0-9.])(2\.02|7\.01|8\.01)([^0-9]|$)/;
const MAX_UPDATES_PER_GAP = 6;
// Other 8-Ks filed the same day as a release that carries no guidance itself.
const MAX_COMPANIONS = 3;

/**
 * Does this filing talk about guidance WITH numbers?
 *
 * The only free step: most 8-Ks between releases are debt deals, board
 * changes and conference notices, and each would cost a paid question to
 * learn it has no guide. A filing passes when "guidance", "outlook" or
 * "forecast" sits within a few hundred characters of a percentage or a
 * dollar figure - and not inside the forward-looking-statements boilerplate,
 * which uses those words in every filing and never with a figure that is a
 * guide.
 */
export function looksLikeGuidance(text) {
  const t = String(text || "");
  // A footnote mark may be stuck to the word: JPMorgan's slide is headed
  // "Outlook1", and its April 2026 deck was passed over for that digit.
  const word = /\b(guidance|outlook|forecast)\d{0,2}\b/gi;
  const figure = /(\d[\d,]*(\.\d+)?\s?(%|percent\b)|\$\s?\d)/i;
  let m;
  while ((m = word.exec(t))) {
    const around = t.slice(Math.max(0, m.index - 300), m.index + 300);
    if (/forward[-\s]looking/i.test(around)) continue;
    if (figure.test(around)) return true;
  }
  return false;
}

/**
 * Completed acquisitions and disposals: 8-Ks carrying item 2.01, oldest first.
 *
 * Honeywell spun off Solstice between guiding its 2025 sales and reporting
 * them, and the result was scored against a guide for a bigger company.
 * Item 2.01 ("Completion of Acquisition or Disposition of Assets") is filed
 * for exactly this, and only for deals large enough to matter. Free: the same
 * submissions list the releases come from.
 */
export async function completedDeals(env, cik) {
  const out = [];
  for (const f of await eightKs(env, cik)) {
    if (!/(^|[^0-9.])2\.01([^0-9]|$)/.test(f.items)) continue;
    out.push({ accession: f.accession, filed: f.filed, items: f.items });
  }
  return out.sort((a, b) => String(a.filed).localeCompare(String(b.filed)));
}

/**
 * The text of the other 8-Ks filed the same day as a release.
 *
 * For the RESULTS side of a company whose guidance lives beside its release
 * (see guidanceFrom). JPMorgan guides "adjusted expense" and "net interest
 * income excluding Markets" on a slide, and reports them on a slide: the
 * press release never uses the first term at all. A guide read from the
 * deck is answered from the next deck, with the release.
 */
export async function textBesideRelease(env, cik, release, room) {
  let sameDay = [];
  try {
    sameDay = (await updateCandidates(env, cik)).filter((f) => f.filed === release.filed
      && f.accession !== release.accession && !/(^|[^0-9.])2\.02([^0-9]|$)/.test(String(f.items || "")));
  } catch {
    return "";
  }
  let out = "";
  for (const f of sameDay.slice(0, MAX_COMPANIONS)) {
    try {
      const beside = await readFiling(env, cik, f.accession);
      if (out.length + beside.text.length > (room || 40000)) continue;
      out += (out ? "\n\n" : "") + beside.text;
    } catch (e) {
      console.error("Filing beside the release " + f.accession + " could not be read: " + e.message);
    }
  }
  return out;
}

/** Every 8-K that could carry a guidance update, oldest first. */
export async function updateCandidates(env, cik) {
  const out = [];
  for (const f of await eightKs(env, cik)) {
    if (!UPDATE_ITEMS.test(f.items)) continue;
    out.push({ accession: f.accession, filed: f.filed, items: f.items });
  }
  out.sort((a, b) => (a.filed < b.filed ? -1 : 1));
  return out;
}

/**
 * The guidance updates filed strictly between two dates, oldest first.
 *
 * `exclude` holds the earnings releases themselves, which are read already.
 * `candidates` can be passed in so a backfill lists the filings once.
 * Returns [{ release, guides }] for each filing that carried at least one
 * guide, and a log of what was skipped and why.
 */
export async function guidanceUpdatesBetween(env, cik, after, before, cal, opts) {
  const o = opts || {};
  const exclude = new Set(o.exclude || []);
  const all = o.candidates || await updateCandidates(env, cik);
  const inGap = all.filter((f) => String(f.filed) > String(after) && String(f.filed) < String(before)
    && !exclude.has(f.accession));

  const updates = [];
  const log = [];
  for (const f of inGap.slice(-MAX_UPDATES_PER_GAP)) {
    let filing;
    try {
      filing = await readFiling(env, cik, f.accession);
    } catch (e) {
      log.push(f.filed + " " + f.accession + ": could not be read (" + e.message + ")");
      continue;
    }
    if (!looksLikeGuidance(filing.text)) {
      log.push(f.filed + " " + f.accession + " (items " + f.items + "): no guidance language near a figure, not read further");
      continue;
    }
    let g;
    try {
      g = await guidanceFrom(env, cik, f, cal, filing);
    } catch (e) {
      log.push(f.filed + " " + f.accession + ": guidance could not be read (" + e.message + ")");
      continue;
    }
    // A figure for a period that had already ENDED when the 8-K was filed is
    // a pre-announcement of a result, not a guide: scoring the result against
    // it would put every one of them "within". Only open periods count.
    const guides = (g.guides || []).filter((x) => x.period && hasFigure(x)
      && !(cal && periodIsClosedBy(x.period, f.filed, g.calendar || cal)));
    log.push(f.filed + " " + f.accession + " (items " + f.items + "): " + guides.length + " guides");
    if (guides.length) updates.push({ release: { accession: f.accession, filed: f.filed, items: f.items }, guides });
  }
  return { updates, log };
}

function hasFigure(g) {
  return typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number";
}

/**
 * The update, if any, that replaces this guide.
 *
 * Same period, same unit, same measure. "Same measure" is the label with
 * dates, "adjusted", "total" and the like stripped (metricKey) - Delta's
 * release says "Earnings Per Share" and its update "EPS", both the same key.
 * If the key does not match, the broad metric class is tried, but only when
 * the update has exactly one guide of that class for the period: two EPS
 * guides in one update (GAAP and adjusted) must not be guessed between.
 */
function matchIn(update, g) {
  const key = metricKey(g.metric_as_written || g.metric);
  const same = update.guides.filter((u) => u.period === g.period && u.unit === g.unit);
  const byKey = same.filter((u) => metricKey(u.metric_as_written || u.metric) === key);
  if (byKey.length === 1) return byKey[0];
  if (byKey.length > 1) {
    const exact = byKey.filter((u) => String(u.metric_as_written) === String(g.metric_as_written));
    return exact.length === 1 ? exact[0] : null;
  }
  // "other" is not a class, it is everything without one. JPMorgan's February
  // 2026 update gave one figure, "2026 expense outlook of ~$105B", and it
  // replaced the guides for net interest income as well, all three being
  // "other". Only a named class may be matched this way.
  if (!g.metric || g.metric === "other") return null;
  const byClass = same.filter((u) => u.metric && u.metric === g.metric);
  return byClass.length === 1 ? byClass[0] : null;
}

/**
 * The guides in force, after any updates.
 *
 * Each guide keeps its own label, so the question asked of the next release
 * is unchanged and its saved answer reused; only the figures move to the
 * latest update's. A guide that appears only in an update is not added -
 * nothing was asked about it, and adding it would change the questions.
 *
 * `applied` lists every override in date order, for the guide path.
 */
/* Does this guide say it is adjusted / non-GAAP? Its basis tag, or its own
   label or sentence. */
const ADJUSTED_WORDS = /\b(non-?gaap|adjusted|adj\.|core|underlying|excluding)\b/i;
function saysAdjusted(g) {
  return g.basis === "non_gaap" || ADJUSTED_WORDS.test(String(g.metric_as_written || "") + " " + String(g.quote || ""));
}

/**
 * May this update's figure replace an ADJUSTED guide?
 *
 * Only if the update says it is adjusted too. Micron's 11 August 2025 update
 * printed GAAP and non-GAAP side by side; its EPS was read as "$2.64 ± $0.07"
 * with no label, and replaced a non-GAAP guide of $2.35-$2.65 - by all
 * appearances with the GAAP column. An adjusted guide is replaced only by a
 * figure the update itself marks as adjusted. Revenue has one basis and is
 * exempt.
 */
function basisAllows(g, u) {
  if (g.metric === "revenue") return true;
  if (!saysAdjusted(g)) return true;
  return saysAdjusted(u);
}

export function applyUpdates(guides, updates) {
  const applied = [];
  const skipped = [];
  const effective = (guides || []).map((g) => {
    // Only a guide that had a figure is replaced. A release entry with no
    // number was never asked about when the next results came out, so an
    // update filling one in (Delta's September 2025 update gave third-quarter
    // revenue "2 to 4 percent" for a July entry with no figure) produced a
    // pair that could not be scored and an email line "guided period left
    // out". Updates correct guides; they do not create them.
    if (!hasFigure(g)) return g;
    let current = g;
    for (const up of updates || []) {
      const u = matchIn(up, g);
      if (!u || !hasFigure(u)) continue;
      if (!basisAllows(g, u)) {
        skipped.push({ key: (g.metric_as_written || "") + "|" + g.period, filed: up.release.filed,
          why: "the guide is adjusted and the update's figure does not say it is", quote: u.quote || null });
        continue;
      }
      const same = (u.low ?? null) === (current.low ?? null) && (u.high ?? null) === (current.high ?? null)
        && (u.value ?? null) === (current.value ?? null);
      if (same) continue;
      current = {
        ...current,
        low: u.low ?? null,
        high: u.high ?? null,
        value: u.value ?? null,
        shape: u.shape || current.shape,
        quote: u.quote || current.quote,
        updated: {
          accession: up.release.accession,
          filed: up.release.filed,
          was: { low: g.low ?? null, high: g.high ?? null, value: g.value ?? null },
          quote: u.quote || null,
          label: u.metric_as_written || null,
        },
      };
      applied.push({
        key: (g.metric_as_written || "") + "|" + g.period,
        figure: { low: current.low, high: current.high, value: current.value, unit: current.unit || null },
        filed: up.release.filed,
      });
    }
    return current;
  });
  return { effective, applied, skipped };
}
