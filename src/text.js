/**
 * What the model actually saw.
 *
 * Every fix so far was reasoned from the extractor's OUTPUT, and one was
 * nearly reasoned wrong: a Delta guide reported a number that appears nowhere
 * in the sentence it quoted, and the only way to be sure was to read the
 * release. That is not a workflow.
 *
 * It has already earned itself once. United appeared not to guide, and the
 * obvious explanations were a model recall miss or a bad prompt. The truth was
 * neither: the guidance is in exhibit 99.2 and the extractor was only reading
 * 99.1. Four rounds of prompt tuning would not have found that.
 *
 * So this returns the release exactly as the extractor assembles it - same
 * exhibit selection, same stripping, same budget - and nothing else. No model,
 * no cost, run it as often as you like.
 *
 * It answers questions reading the release in a browser cannot:
 *
 *   Which exhibits were read, and which were left out?
 *   Did stripping destroy the outlook table?
 *   Did the guidance fall past the character limit?
 *   Is the number the model reported present in the document at all?
 *
 * It now shares readFiling with the extractor rather than keeping a private
 * copy. Which files exist and how they are joined is a fact about the FILING,
 * and a diagnostic that disagreed with the extractor about that would answer
 * the wrong question - as it would have if it had kept reading one exhibit
 * while the extractor read four.
 */

import { secJson } from "./sec.js";
import { readFiling } from "./guidance.js";

/**
 * The release as text, optionally filtered.
 *
 * grep is a plain case-insensitive substring, not a pattern. A phone keyboard
 * and a regex are a bad combination, and every search worth running here is a
 * word: "expect", "guidance", "outlook", "per share".
 *
 * Lines are numbered against the assembled text, so a hit tells you where it
 * sits and which exhibit it came from - the ===== markers are lines too.
 */
export async function releaseText(env, cik, accession, opts) {
  const options = opts || {};

  // The whole directory, so a file the selector skipped is visible rather than
  // inferred from an empty result.
  const noDash = accession.replace(/-/g, "");
  const dir = await secJson(
    env,
    "https://www.sec.gov/Archives/edgar/data/" + Number(cik) + "/" + noDash + "/index.json"
  );
  const filesInFiling = ((dir.directory && dir.directory.item) || [])
    .map((f) => ({ name: f.name, bytes: Number(f.size || 0) }));

  const filing = await readFiling(env, cik, accession);
  const lines = filing.text.split("\n");

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
    pickedBy: filing.pickedBy,
    exhibitsRead: filing.files,
    filesInFiling,
    textChars: filing.chars,
    lines: lines.length,
    matched: selected.length,
    shown: capped.length,
    text: capped,
  };
}
