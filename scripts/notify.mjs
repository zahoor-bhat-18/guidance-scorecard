/**
 * After a backfill someone asked for: tell them what it found.
 *
 * Run by the backfill workflow, only when the run was started by a signup on
 * the site (repository_dispatch "backfill-request"). For each ticker it reads
 * the record the backfill just wrote to out/, and emails everyone following
 * that ticker one of three short notes:
 *
 *   covered      - the company puts enough numeric guidance in its releases
 *                  to score, and the first email comes with its next release;
 *   too little   - it does not, so nothing will be sent unless that changes;
 *   not built    - the backfill failed for it.
 *
 * Nobody is removed from the list. A company with too little guidance today
 * may guide next year, and the live send already skips it until then.
 *
 * Usage: node scripts/notify.mjs "META,ORCL"
 */

import { readFile } from "node:fs/promises";

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

/** What the backfill found for one ticker. */
async function statusOf(ticker) {
  let record = null;
  try {
    record = JSON.parse(await readFile("out/" + ticker + ".json", "utf8"));
  } catch {
    return { ticker, kind: "not built", company: ticker };
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

/** The note itself. Short, and says only what the record supports. */
export function noteFor(s, unsub) {
  const name = s.company + " (" + s.ticker + ")";
  let subject;
  let lines;

  if (s.kind === "covered") {
    subject = "Now covering " + s.ticker;
    lines = [
      "We have read the last fourteen earnings releases from " + name + " and matched "
        + s.matched + " guided figures to what the company then reported.",
      "Your first email comes when " + s.ticker + " files its next earnings release. The record so far is on "
        + SITE + ".",
    ];
  } else if (s.kind === "too little") {
    subject = s.ticker + ": not enough guidance to score";
    lines = [
      "We have read the last fourteen earnings releases from " + name + ". They carry too little numeric"
        + " guidance to score" + (s.matched ? " (" + s.matched + " guided figures matched)" : "")
        + ", so there is nothing useful to send.",
      "Many companies give their outlook only on the call or in slides, which are not filed with the SEC."
        + " You stay on the list, and hear from us only if that changes.",
    ];
  } else {
    subject = s.ticker + ": could not be set up";
    lines = [
      "We could not build a record for " + s.ticker + " just now. We have been told and will look at it.",
      "You stay on the list. Questions: reply to this email.",
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

async function main() {
  const tickers = String(process.argv[2] || "")
    .split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) throw new Error("No tickers given.");

  for (const [k, v] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: CF_TOKEN,
    KV_NAMESPACE_ID: KV_ID, RESEND_API_KEY: process.env.RESEND_API_KEY, UNSUB_SECRET: process.env.UNSUB_SECRET })) {
    if (!v) throw new Error(k + " is not set.");
  }

  const raw = await kvGet("subscribers");
  const list = raw ? JSON.parse(raw) : {};

  const lines = [];
  for (const ticker of tickers) {
    const s = await statusOf(ticker);
    const followers = Object.entries(list)
      .filter(([, v]) => (v.tickers || []).includes(ticker))
      .map(([email]) => email);

    let sent = 0;
    for (const email of followers) {
      const unsub = SITE + "/unsubscribe?e=" + encodeURIComponent(email)
        + "&s=" + (await hmac(process.env.UNSUB_SECRET, email));
      try {
        await sendMail(email, noteFor(s, unsub), unsub);
        sent += 1;
      } catch (e) {
        console.error(ticker + " to one follower: " + e.message);
      }
    }
    // "We have been told" in the follower's note is only true because of this.
    if (s.kind === "not built") {
      const owner = process.env.REPLY_TO || "hello@zahoorbhat.com";
      try {
        await sendMail(owner, {
          subject: "Backfill failed for " + ticker,
          text: ticker + " was requested on the site and its backfill did not produce a record. "
            + followers.length + " following. See the latest backfill run in Actions.\n",
          html: "<p>" + esc(ticker) + " was requested on the site and its backfill did not produce a record. "
            + followers.length + " following. See the latest backfill run in Actions.</p>",
        }, SITE);
      } catch (e) {
        console.error("Could not tell the owner about " + ticker + ": " + e.message);
      }
    }

    const line = ticker + ": " + s.kind + (s.kind !== "not built" ? ", " + s.matched + " matched" : "")
      + ". Told " + sent + " of " + followers.length + " following.";
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
