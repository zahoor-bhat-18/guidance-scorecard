/**
 * After a backfill someone asked for: tell them what it found.
 *
 * Run by the backfill workflow, only when the run was started by a signup on
 * the site (repository_dispatch "backfill-request"). For each ticker it reads
 * the record the backfill just wrote to out/, and emails everyone following
 * that ticker one of three short notes - ONE email per follower, with a row
 * per company when they asked for several (see combinedNote):
 *
 *   covered      - the company puts enough numeric guidance in its releases
 *                  to score, and the first email comes with its next release;
 *   too little   - it does not, so nothing will be sent unless that changes;
 *   no releases  - it files fewer than two earnings releases with the SEC, so
 *                  there is nothing to score. An answer about the company.
 *
 * AND NOTHING WHEN THE FAILURE IS OURS. A backfill that fails because SEC
 * was busy, the model was down or the code broke tells the subscriber
 * nothing: a first email saying "could not be set up" over a two-second SEC
 * hiccup is the wrong first impression, and it says nothing true about the
 * company. The owner gets the error instead, and the subscriber hears from
 * us once it works. Which failures are which is decided once, in
 * scripts/backfill.mjs (failureKind), and read here from out/summary.json.
 *
 * Nobody is removed from the list. A company with too little guidance today
 * may guide next year, and the live send already skips it until then.
 *
 * Usage: node scripts/notify.mjs "META,ORCL"
 */

import { readFile } from "node:fs/promises";
import { displayName } from "../src/format.js";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.KV_NAMESPACE_ID;
const SITE = (process.env.SITE_URL || "https://guidance.zahoorbhat.com").replace(/\/$/, "");
const POSTAL = process.env.POSTAL_ADDRESS || "";

const kvUrl = (key) =>
  "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
  + "/storage/kv/namespaces/" + KV_ID + "/values/" + encodeURIComponent(key);

async function kvGet(key) {
  const r = await fetch(kvUrl(key), { headers: { Authorization: "Bearer " + CF_TOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("KV read failed for " + key + ": " + r.status);
  return r.text();
}

async function kvPut(key, value) {
  const r = await fetch(kvUrl(key), { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body: value });
  if (!r.ok) throw new Error("KV write failed for " + key + ": " + r.status);
}

async function kvDelete(key) {
  const r = await fetch(kvUrl(key), { method: "DELETE", headers: { Authorization: "Bearer " + CF_TOKEN } });
  if (!r.ok && r.status !== 404) throw new Error("KV delete failed for " + key + ": " + r.status);
}

/** Tickers whose followers are still owed their first note. */
async function owedTickers() {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
    + "/storage/kv/namespaces/" + KV_ID + "/keys?prefix=" + encodeURIComponent(OWED);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + CF_TOKEN } });
  if (!r.ok) throw new Error("KV list failed: " + r.status);
  const j = await r.json();
  return (j.result || []).map((k) => k.name.slice(OWED.length));
}

/* OWED A NOTE.
 *
 * A ticker whose requested backfill failed on our side is marked owed:TICKER.
 * Its followers have been told nothing, so when the ticker is next built -
 * by a hand run from the Actions page, not only by another request - they
 * get the note they were waiting for, and the mark is removed. Without this,
 * "they get their note when it works" would be false: a hand run does not
 * write to subscribers, and should not, or every rebuild would email them. */
const OWED = "owed:";

/* The same signature the Worker checks on /unsubscribe, and the same as
   scripts/send.mjs. */
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function sendMail(to, mail, unsub) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.RESEND_API_KEY },
    body: JSON.stringify({
      from: "Guidance Scorecard <" + (process.env.EMAIL_FROM || "guidance@zahoorbhat.com") + ">",
      reply_to: [process.env.REPLY_TO || "hello@zahoorbhat.com"],
      to: [to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: { "List-Unsubscribe": "<" + unsub + ">" },
    }),
  });
  if (!r.ok) throw new Error("Resend " + r.status + ": " + (await r.text()).slice(0, 200));
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** What the backfill said about a ticker it could not build, if anything. */
async function failureOf(ticker) {
  try {
    const run = JSON.parse(await readFile("out/summary.json", "utf8"));
    return (run.summary || []).find((r) => r.ticker === ticker && r.error) || null;
  } catch {
    return null;
  }
}

/** What the backfill found for one ticker. */
export async function statusOf(ticker) {
  let record = null;
  try {
    record = JSON.parse(await readFile("out/" + ticker + ".json", "utf8"));
  } catch {
    // No record. Either the company gave its own answer (permanent), or the
    // failure was ours - including a run that died before saying anything,
    // which is why "not built" is the default.
    const failed = await failureOf(ticker);
    if (failed && failed.kind === "permanent") {
      return { ticker, kind: "no releases", company: ticker, error: failed.error };
    }
    return { ticker, kind: "not built", company: ticker, error: failed ? failed.error : "the run ended without a result for it" };
  }
  const matched = (record.pairs || []).filter((p) => p.comparable).length;
  const publishable = Boolean(record.coverage && record.coverage.publishable);
  return {
    ticker,
    company: record.company || ticker,
    matched,
    kind: publishable ? "covered" : "too little",
  };
}

/** The note itself. Short, and says only what the record supports.
    Null for a failure of ours: the subscriber is not written to. */
export function noteFor(s, unsub) {
  if (s.kind === "not built") return null;
  const name = displayName(s.company) + " (" + s.ticker + ")";
  const figures = (n) => n + (n === 1 ? " guided figure" : " guided figures");
  let subject;
  let lines;

  if (s.kind === "covered") {
    subject = "Now covering " + s.ticker;
    lines = [
      "We have read the last fourteen earnings releases from " + name + " and matched "
        + figures(s.matched) + " to what the company then reported.",
      "Your first email comes when " + s.ticker + " files its next earnings release. The record so far is on "
        + SITE + ".",
    ];
  } else if (s.kind === "too little") {
    subject = s.ticker + ": not enough guidance to score";
    lines = [
      "We have read the last fourteen earnings releases from " + name + ". They carry too little numeric"
        + " guidance to score" + (s.matched ? " (" + figures(s.matched) + " matched)" : "")
        + ", so there is nothing useful to send.",
      "Many companies give their outlook only on the call or in slides, which are not filed with the SEC."
        + " You stay on the list: each time it reports you will get a short note saying so, and the full"
        + " scorecard once there is something to score.",
    ];
  } else {
    // "no releases": the company does not put earnings releases on file with
    // the SEC often enough - a foreign filer, a new listing, a fund.
    subject = s.ticker + ": not enough guidance to score";
    lines = [
      "We could not find at least two earnings releases from " + s.ticker + " filed with the SEC,"
        + " so there is no guidance to score.",
      "You stay on the list, and hear from us only if that changes.",
    ];
  }

  const footer = "Unsubscribe: " + unsub + (POSTAL ? "\n" + POSTAL : "");
  const text = lines.join("\n\n") + "\n\n" + footer + "\n";
  const html = '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.55;color:#16281F;max-width:560px">'
    + lines.map((l) => "<p>" + esc(l).replace(esc(SITE), '<a href="' + esc(SITE) + '">' + esc(SITE.replace(/^https?:\/\//, "")) + "</a>") + "</p>").join("")
    + '<p style="font-family:Arial,sans-serif;font-size:12px;color:#5B7166;margin-top:28px">'
    + '<a href="' + esc(unsub) + '" style="color:#5B7166">Unsubscribe</a>' + (POSTAL ? " · " + esc(POSTAL) : "")
    + "</p></div>";

  return { subject, text, html };
}

/**
 * ONE note for everything a follower asked for.
 *
 * Someone who signed up for eight companies got eight emails, minutes apart.
 * The content was right and the count was wrong: it is one answer to one
 * signup. So the statuses are gathered per follower and sent as a single
 * email with a row per company. One company still gets the plain note above,
 * word for word.
 */
export function combinedNote(statuses, unsub) {
  const list = (statuses || []).filter((s) => s.kind !== "not built");
  if (!list.length) return null;
  if (list.length === 1) return noteFor(list[0], unsub);

  const figures = (n) => n + (n === 1 ? " guided figure" : " guided figures");
  const order = { covered: 0, "too little": 1, "no releases": 2 };
  const rows = list.slice().sort((x, y) => (order[x.kind] - order[y.kind]) || x.ticker.localeCompare(y.ticker))
    .map((s) => {
      if (s.kind === "covered") {
        return { s, status: "Covered", detail: figures(s.matched) + " matched to what it then reported. First email at its next earnings release." };
      }
      if (s.kind === "too little") {
        return { s, status: "Not enough guidance", detail: "Too little numeric guidance in its releases to score"
          + (s.matched ? " (" + figures(s.matched) + " matched)" : "") + ". A short note each time it reports." };
      }
      return { s, status: "No releases found", detail: "Fewer than two earnings releases filed with the SEC. You hear from us only if that changes." };
    });

  const covered = list.filter((s) => s.kind === "covered").length;
  const rest = list.length - covered;
  const subject = covered === list.length ? "Now covering your " + list.length + " companies"
    : covered === 0 ? "Your " + list.length + " companies: not enough guidance to score"
    : "Now covering " + covered + " of your " + list.length + " companies";

  const intro = "We have read the last fourteen earnings releases from each company you asked for. "
    + (covered ? covered + (covered === 1 ? " has" : " have") + " enough numeric guidance to score"
      + (rest ? ", " + rest + (rest === 1 ? " does" : " do") + " not." : ".")
      : "None has enough numeric guidance to score yet.");
  const after = [];
  if (covered) after.push("For the covered companies, your first email comes when each files its next earnings release. The record so far is on " + SITE + ".");
  if (rest) after.push("Many companies give their outlook only on the call or in slides, which are not filed with the SEC. You stay on the list for all of them, and get the full scorecard once there is something to score.");

  const name = (s) => (s.company && s.company !== s.ticker ? displayName(s.company) + " (" + s.ticker + ")" : s.ticker);
  const footer = "Unsubscribe: " + unsub + (POSTAL ? "\n" + POSTAL : "");
  const text = intro + "\n\n"
    + rows.map((r) => name(r.s) + " - " + r.status + ". " + r.detail).join("\n")
    + "\n\n" + after.join("\n\n") + "\n\n" + footer + "\n";

  const link = (l) => esc(l).replace(esc(SITE), '<a href="' + esc(SITE) + '">' + esc(SITE.replace(/^https?:\/\//, "")) + "</a>");
  const cell = "padding:10px 8px;border-bottom:1px solid #E3E8E5;vertical-align:top;";
  const html = '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.55;color:#16281F;max-width:560px">'
    + "<p>" + esc(intro) + "</p>"
    + '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;line-height:1.45;margin:6px 0 14px">'
    + rows.map((r) => "<tr>"
      + '<td style="' + cell + 'width:36%"><b>' + esc(r.s.ticker) + "</b>"
      + (r.s.company && r.s.company !== r.s.ticker ? '<br><span style="color:#5B7166;font-size:12px">' + esc(displayName(r.s.company)) + "</span>" : "") + "</td>"
      + '<td style="' + cell + '"><b style="color:' + (r.s.kind === "covered" ? "#1f4435" : "#5B7166") + '">' + esc(r.status) + "</b><br>"
      + '<span style="color:#3b4a57;font-size:13px">' + esc(r.detail) + "</span></td></tr>").join("")
    + "</table>"
    + after.map((l) => "<p>" + link(l) + "</p>").join("")
    + '<p style="font-family:Arial,sans-serif;font-size:12px;color:#5B7166;margin-top:28px">'
    + '<a href="' + esc(unsub) + '" style="color:#5B7166">Unsubscribe</a>' + (POSTAL ? " · " + esc(POSTAL) : "")
    + "</p></div>";

  return { subject, text, html };
}

/** Was this ticker part of the run that just finished? */
async function inThisRun(ticker) {
  try {
    const run = JSON.parse(await readFile("out/summary.json", "utf8"));
    return (run.summary || []).some((r) => r.ticker === ticker);
  } catch {
    return false;
  }
}

async function main() {
  /* Two modes.
   *   notify.mjs "META,ORCL"   after a request from the site: everyone
   *                            following those tickers hears the outcome.
   *   notify.mjs --owed-only   after a hand run: only followers still owed a
   *                            note from an earlier failure, and only for
   *                            tickers this run built. Anyone else hears
   *                            nothing, however many times a rebuild runs. */
  const owedOnly = process.argv.includes("--owed-only");

  for (const [k, v] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: CF_TOKEN,
    KV_NAMESPACE_ID: KV_ID, RESEND_API_KEY: process.env.RESEND_API_KEY, UNSUB_SECRET: process.env.UNSUB_SECRET })) {
    if (!v) throw new Error(k + " is not set.");
  }

  let tickers;
  if (owedOnly) {
    tickers = [];
    let owed;
    try {
      owed = await owedTickers();
    } catch (e) {
      // A hand run is not about notes; do not turn it red over one.
      console.error("Could not read which followers are owed a note: " + e.message);
      return;
    }
    for (const t of owed) if (await inThisRun(t)) tickers.push(t);
    if (!tickers.length) {
      console.log("No follower is owed a note for any ticker in this run.");
      return;
    }
  } else {
    tickers = String(process.argv[2] || "")
      .split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!tickers.length) throw new Error("No tickers given.");
  }

  const raw = await kvGet("subscribers");
  const list = raw ? JSON.parse(raw) : {};

  const lines = [];

  /* Every ticker's outcome first, then ONE email per follower covering all
     of theirs - see combinedNote. */
  const statuses = [];
  for (const ticker of tickers) {
    const s = await statusOf(ticker);
    // Still failing on a hand run: the owner already knows, and ran it.
    // Nothing more to send; the mark stays for the next try.
    if (owedOnly && s.kind === "not built") {
      const line = ticker + ": still not built (" + s.error + "). Followers still owed their note.";
      console.log(line);
      lines.push(line);
      continue;
    }
    s.followers = Object.entries(list)
      .filter(([, v]) => (v.tickers || []).includes(ticker))
      .map(([email]) => email);
    s.sent = 0;
    statuses.push(s);
  }

  // A failure of ours is left out: not one follower is written to about it.
  const perFollower = new Map();
  for (const s of statuses) {
    if (s.kind === "not built") continue;
    for (const email of s.followers) {
      if (!perFollower.has(email)) perFollower.set(email, []);
      perFollower.get(email).push(s);
    }
  }
  for (const [email, theirs] of perFollower) {
    const unsub = SITE + "/unsubscribe?e=" + encodeURIComponent(email)
      + "&s=" + (await hmac(process.env.UNSUB_SECRET, email));
    try {
      await sendMail(email, combinedNote(theirs, unsub), unsub);
      for (const s of theirs) s.sent += 1;
    } catch (e) {
      console.error(theirs.map((s) => s.ticker).join(",") + " to one follower: " + e.message);
    }
  }
  console.log("Emails sent: " + Array.from(perFollower.values()).filter((t) => t.every((s) => s.sent > 0)).length
    + " of " + perFollower.size + " followers, one each.");

  for (const s of statuses) {
    const ticker = s.ticker;
    const followers = s.followers;
    const sent = s.sent;
    // The owner is the only one told about a failure of ours - with the
    // error, so the log need not be opened to know what happened.
    if (s.kind === "not built") {
      const owner = process.env.REPLY_TO || "hello@zahoorbhat.com";
      const body = [
        ticker + " was requested on the site and its backfill failed twice, so no record was built.",
        "Error: " + s.error,
        followers.length + " following. None of them has been told anything.",
        "To retry: Actions, backfill, Run workflow, tickers " + ticker + ". They get their note when it works.",
      ];
      try {
        await sendMail(owner, {
          subject: "Backfill failed for " + ticker + " - subscribers not told",
          text: body.join("\n\n") + "\n",
          html: body.map((l) => "<p>" + esc(l) + "</p>").join(""),
        }, SITE);
      } catch (e) {
        console.error("Could not tell the owner about " + ticker + ": " + e.message);
      }
      try {
        await kvPut(OWED + ticker, new Date().toISOString());
      } catch (e) {
        console.error("Could not mark " + ticker + " as owed: " + e.message);
      }
    } else {
      // Told, so no longer owed. Removed only when every follower was sent
      // their note, so a failed send is tried again on the next run.
      if (sent === followers.length) {
        try {
          await kvDelete(OWED + ticker);
        } catch (e) {
          console.error("Could not clear the owed mark for " + ticker + ": " + e.message);
        }
      }
    }

    const line = ticker + ": " + s.kind
      + (typeof s.matched === "number" ? ", " + s.matched + " matched" : "")
      + (s.error ? " (" + s.error + ")" : "")
      + ". Told " + sent + " of " + followers.length + " following"
      + (s.kind === "not built" ? " - a failure of ours, owner told instead." : ".");
    console.log(line);
    lines.push(line);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, "\n## Told who asked\n\n" + lines.map((l) => "- " + l).join("\n") + "\n");
  }
}

// Run only when called as a script, so the test can import noteFor.
if (import.meta.url === "file://" + process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
