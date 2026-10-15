/**
 * The preview send. Run once a day (preview.yml).
 *
 * For each company a Guidance Scorecard subscriber follows: estimate the next
 * report date from the record (src/preview.js), and when it falls one to three
 * days ahead, send the preview to that company's followers - once per report.
 *
 *   node scripts/preview.mjs                    every followed company, real send
 *   node scripts/preview.mjs --test DAL,MU      those companies, to TEST_EMAIL only, whatever the date
 *   node scripts/preview.mjs --dry              every followed company: who is due, nothing sent
 *
 * The record is read from KV, as the day-of send reads it. Nothing is fetched
 * from EDGAR and no model is asked.
 */

import { renderPreview } from "../src/preview.js";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.KV_NAMESPACE_ID;
const SITE = process.env.SITE_URL || "https://zahoorbhat.com";

// Send when the estimated date is this many days ahead (inclusive).
const SEND_FROM = 1, SEND_TO = 3;

const kvUrl = (key) => "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
  + "/storage/kv/namespaces/" + KV_ID + "/values/" + encodeURIComponent(key);
async function kvGet(key) {
  const r = await fetch(kvUrl(key), { headers: { Authorization: "Bearer " + CF_TOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("KV read failed for " + key + ": " + r.status);
  return r.text();
}
async function kvPut(key, value) {
  const body = new FormData();
  body.set("value", value);
  body.set("metadata", "{}");
  const r = await fetch(kvUrl(key), { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body });
  if (!r.ok) throw new Error("KV write failed for " + key + ": " + r.status);
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

async function main() {
  const args = process.argv.slice(2);
  const test = args.includes("--test");
  const dry = args.includes("--dry");
  const listed = args.filter((a) => !a.startsWith("--")).join(",").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  const subscribers = JSON.parse((await kvGet("subscribers")) || "{}");
  const followersOf = (t) => Object.entries(subscribers).filter(([, v]) => (v.tickers || []).includes(t)).map(([e]) => e);
  const tickers = listed.length ? listed
    : Array.from(new Set(Object.values(subscribers).flatMap((v) => v.tickers || []))).sort();
  console.log((test ? "TEST " : dry ? "DRY RUN " : "") + "Preview for " + tickers.length + " companies, " + today + ".");

  let sent = 0;
  for (const ticker of tickers) {
    const stored = await kvGet("record:" + ticker);
    if (!stored) { console.log("  " + ticker + ": no record"); continue; }
    const record = JSON.parse(stored);
    const probe = renderPreview(record);
    if (!probe) { console.log("  " + ticker + ": nothing to preview (no guide in force for the next report)"); continue; }
    const ahead = daysBetween(today, probe.next.expected);
    const reported = daysBetween(probe.next.latestFiled, today) < 30;
    const mark = "preview:" + ticker + ":" + probe.next.expected;
    const due = ahead >= SEND_FROM && ahead <= SEND_TO && !reported;
    console.log("  " + ticker + ": next " + probe.next.period + " expected " + probe.next.expected + " (" + ahead + " days)"
      + (due ? " - DUE" : "") + (reported ? " - reported recently, skipped" : ""));
    if (dry || (!test && !due)) continue;
    if (!test && (await kvGet(mark))) { console.log("    already sent"); continue; }

    const to = test ? [process.env.TEST_EMAIL].filter(Boolean) : followersOf(ticker);
    for (const email of to) {
      const unsub = SITE + "/unsubscribe?e=" + encodeURIComponent(email) + "&s=" + (await hmac(process.env.UNSUB_SECRET, email)) + "&p=guidance";
      const mail = renderPreview(record, { unsubscribeUrl: unsub, postalAddress: process.env.POSTAL_ADDRESS });
      if (test) mail.subject = "[TEST] " + mail.subject;
      await sendMail(email, mail, unsub);
      sent++;
    }
    if (!test) await kvPut(mark, new Date().toISOString());
    console.log("    sent to " + to.length + (test ? " (test address)" : " follower(s)"));
  }
  console.log("Previews sent: " + sent + ".");
}

main().catch((e) => { console.error(e); process.exit(1); });
