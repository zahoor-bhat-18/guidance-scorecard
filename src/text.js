/**
 * What the model actually saw.
 *
 * Every fix so far has been reasoned from the extractor's OUTPUT, and one of
 * them was nearly reasoned wrong: a Delta guide reported a number that does
 * not appear anywhere in the sentence it quoted, and the only way to be sure
 * was to read the release. That is not a workflow.
 *
 * So this returns the release as the extractor sees it - same fetch, same
 * stripping, same truncation - and nothing else. No model, no cost, run it as
 * often as you like.
 *
 * It answers questions that reading the release in a browser cannot:
 *
 *   Did stripping destroy the outlook table?
 *   Did the guidance fall past the character limit?
 *   Is the mangled cent sign in the text the model reads, or only in the JSON?
 *   Is the number the model reported present in the document at all?
 *
 * The rule this exists to serve is the one that has held throughout: a
 * diagnostic beats guessing. On the other product, an endpoint reporting which
 * variables the Worker could see ended an hour of guesswork in five seconds.
 *
 * DELIBERATELY a copy of guidance.js's fetch and strip, not a shared import.
 * If it shared them, a change to the shared version would change what this
 * reports at the same moment it changed what the extractor does, and the
 * diagnostic would agree with the bug.
 */

import { secJson } from "./sec.js";

/* Must match MAX_CHARS in guidance.js and actuals.js. If they drift, this
   reports a truncation point the extractor does not use. */
const MAX_CHARS = 80000;

async function pickExhibit(env, cik, accession) {
  const noDash = accession.replace(/-/g, "");
  const base = "https://www.sec.gov/Archives/edgar/data/" + Number(cik) + "/" + noDash;
  const dir = await secJson(env, base + "/index.json");
  const all = ((dir.directory && dir.directory.item) || []);
  const items = all.filter((f) => /\.html?$/i.test(f.name) && !/-index/i.test(f.name));

  if (!items.length) throw new Error("No HTML document in filing " + accession + ".");

  const named = items.filter((f) => /(^|[^0-9])99[._-]?1([^0-9]|$)|ex-?99/i.test(f.name));
  const pool = named.length ? named : items;
  pool.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));

  return {
    url: base + "/" + pool[0].name,
    file: pool[0].name,
    bytes: Number(pool[0].size || 0),
    pickedBy: named.length ? "exhibit 99.1 by filename" : "largest HTML in the filing",
    // Every file in the filing, so a wrong pick is visible rather than
    // inferred from an empty result.
    allFiles: all.map((f) => ({ name: f.name, bytes: Number(f.size || 0) })),
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

/**
 * The release as text, optionally filtered.
 *
 * grep is a plain case-insensitive substring, not a pattern. A phone keyboard
 * and a regex are a bad combination, and every search worth running here is a
 * word: "expect", "guidance", "outlook", "per share".
 *
 * Lines are numbered against the FULL text, so a hit at line 900 tells you
 * where in the document it sits and whether truncation would have reached it.
 */
export async function releaseText(env, cik, accession, opts) {
  const options = opts || {};
  const exhibit = await pickExhibit(env, cik, accession);

  const res = await fetch(exhibit.url, {
    headers: { "User-Agent": env.SEC_USER_AGENT, Accept: "text/html" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) throw new Error("EDGAR " + res.status + " for " + exhibit.file);

  const full = htmlToText(await res.text());
  const lines = full.split("\n");

  // Where the extractor's view stops. Anything after this the model never saw,
  // which is the difference between "the company did not guide" and "we did
  // not look".
  let cut = -1;
  if (full.length > MAX_CHARS) {
    let run = 0;
    for (let i = 0; i < lines.length; i++) {
      run += lines[i].length + 1;
      if (run > MAX_CHARS) { cut = i + 1; break; }
    }
  }

  let selected;
  if (options.grep) {
    const needle = String(options.grep).toLowerCase();
    selected = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        selected.push({ line: i + 1, text: lines[i] });
      }
    }
  } else {
    const from = Math.max(1, parseInt(options.from, 10) || 1);
    const to = Math.min(lines.length, parseInt(options.to, 10) || from + 79);
    selected = [];
    for (let i = from - 1; i < to; i++) {
      selected.push({ line: i + 1, text: lines[i] });
    }
  }

  // A phone can only read so much, and a 400-line dump is not a diagnostic.
  const capped = selected.slice(0, 120);

  return {
    exhibit: {
      file: exhibit.file,
      url: exhibit.url,
      bytes: exhibit.bytes,
      pickedBy: exhibit.pickedBy,
    },
    filesInFiling: exhibit.allFiles,
    textChars: full.length,
    lines: lines.length,
    truncated: full.length > MAX_CHARS,
    truncatedAtLine: cut > 0 ? cut : null,
    matched: selected.length,
    shown: capped.length,
    text: capped,
  };
}
