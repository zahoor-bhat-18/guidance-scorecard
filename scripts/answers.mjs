/**
 * Saved model answers, for the backfill only.
 *
 * WHY. Every rebuild asked DeepSeek about every release again - roughly two
 * hundred calls for eight companies - and paid for each one. Worse, the model
 * does not give the same answer twice on the same filing, so a rebuild made to
 * test one fix also re-rolled every extraction. A number that moved could be
 * the fix, a new bug, or the model having a different day, and there was no
 * way to tell which.
 *
 * WHAT. Every answer the model gives is kept, keyed by a fingerprint of the
 * exact request sent: the model name, the instructions, the release text and,
 * for actuals, the list of figures asked for. The next time the backfill sends
 * the identical request, the saved answer is returned and nothing is paid.
 *
 * WHY AT THE REQUEST, NOT THE RESULT. What is saved is the model's raw reply,
 * before any of our own code touches it. So everything we control - the quote
 * guard, period reading, pairing, scoring, revisions - still runs fresh on
 * every rebuild, and a fix to any of it shows up in full. Only the part that
 * costs money and varies by itself is frozen.
 *
 * WHEN IT ASKS AGAIN, BY ITSELF. Anything that changes what is sent changes
 * the fingerprint: a new prompt, a different release text, a different list of
 * figures asked for. Those requests are genuinely new questions and are asked.
 *
 * --fresh asks the model again for everything in the run and replaces what was
 * saved. For when a saved answer is known to be wrong.
 *
 * Only DeepSeek requests are touched. SEC, the site and anything else pass
 * straight through.
 *
 * A reply is saved only if it contains JSON the rest of the code can read. A
 * broken reply is not worth replaying forever.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const MODEL_HOST = "https://api.deepseek.com/";
let originalFetch = null;

function fingerprint(body) {
  return createHash("sha256").update(String(body || "")).digest("hex");
}

/* The same test the two callModel functions apply: the reply's content, with
   any code fence removed, must parse as JSON. */
function usable(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    const content = ((data.choices || [])[0] || {}).message?.content || "";
    const clean = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    JSON.parse(clean);
    return true;
  } catch {
    return false;
  }
}

function replay(bodyText) {
  return new Response(bodyText, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Starts the store. Reads the saved answers from `from` (a missing or
 * unreadable file starts empty) and replaces the global fetch so model
 * requests go through the store.
 */
export async function startAnswers({ from, fresh = false }) {
  let saved = {};
  try {
    const parsed = JSON.parse(await readFile(from, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.answers && typeof parsed.answers === "object") {
      saved = parsed.answers;
    }
  } catch {
    saved = {};
  }

  const stats = { loaded: Object.keys(saved).length, reused: 0, asked: 0, notSaved: 0 };
  // The fetch as it was before any store was started. Starting twice must not
  // wrap one store inside another, or the inner one answers for the outer.
  if (!originalFetch) originalFetch = globalThis.fetch;
  const realFetch = originalFetch;

  globalThis.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = String((init && init.method) || "GET").toUpperCase();

    if (!url.startsWith(MODEL_HOST) || method !== "POST") {
      return realFetch(input, init);
    }

    const key = fingerprint(init && init.body);

    if (!fresh && typeof saved[key] === "string") {
      stats.reused += 1;
      return replay(saved[key]);
    }

    const r = await realFetch(input, init);
    stats.asked += 1;
    if (!r.ok) return r;

    const text = await r.text();
    if (usable(text)) saved[key] = text;
    else stats.notSaved += 1;
    return replay(text);
  };

  return {
    stats,
    async save(to) {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, JSON.stringify({ savedAt: new Date().toISOString(), answers: saved }));
    },
    line() {
      return "Model answers: " + stats.reused + " reused, " + stats.asked + " asked"
        + (stats.asked ? " (paid)" : "")
        + (stats.notSaved ? ", " + stats.notSaved + " unreadable and not saved" : "")
        + ". " + stats.loaded + " were on file at the start"
        + (fresh ? "; --fresh was on, so nothing on file was reused" : "") + ".";
    },
  };
}
