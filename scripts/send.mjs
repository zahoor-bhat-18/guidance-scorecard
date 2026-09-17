/**
 * The live send.
 *
 * Fired by the Worker when a watched company files an 8-K carrying item 2.02.
 * Reads that one release, scores it against the stored record, updates the
 * record, and emails everyone following the ticker.
 *
 * Three model calls, not the twenty-odd the backfill makes: the guidance from
 * the release before it is already stored, so only the new release has to be
 * read.
 *
 * --test does none of that. See testSend below.
 *
 * The pairing rule lives in src/pairing.js and is shared with the backfill.
 * There were two copies and they were the last place still matching a guide to
 * its actual on the raw label, which cost Walmart a quarter of operating
 * income every time it renamed the row.
 */

import { resolveCik, companyCalendar } from "../src/xbrl.js";
import { earningsReleases, guidanceFrom } from "../src/guidance.js";
import { requestsFrom, actualsFrom } from "../src/actuals.js";
import { pairUp } from "../src/pairing.js";
import { scoreAll } from "../src/score.js";
import { revisionsBetween } from "../src/revisions.js";
import { forEmail, headline } from "../src/records.js";
import { renderEmail } from "../src/email.js";

const env = {
  SEC_USER_AGENT: process.env.SEC_USER_AGENT,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.KV_NAMESPACE_ID;
const SITE = process.env.SITE_URL || "https://guidance.zahoorbhat.com";

/* KV over the REST API. Actions has no Worker bindings, and shelling out to
   wrangler for every read would be slower and harder to see when it fails. */
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
  const body = new FormData();
  body.set("value", value);
  body.set("metadata", "{}");
  const r = await fetch(kvUrl(key), {
    method: "PUT",
    headers: { Authorization: "Bearer " + CF_TOKEN },
    body,
  });
  if (!r.ok) throw new Error("KV write failed for " + key + ": " + r.status + " " + (await r.text()).slice(0, 200));
}

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
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
    },
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

/**
 * The email as it stands, to one address, changing nothing.
 *
 * This deliberately does NOT score anything.
 *
 * The obvious --test - "run the real send but skip the already-sent guard" -
 * produces a worse email than the preview route, not a better one. handle()
 * scores record.currentGuidance, which holds the guides issued IN the latest
 * release, against the actuals reported in that same release. Those are
 * different periods, samePeriod rejects every one of them, and the result is
 * an empty record built from three model calls.
 *
 * What needs judging in a mail client is the rendering, and the rendering is
 * the same object either way: the stored record, through forEmail, headline
 * and renderEmail - the identical three calls handle() makes. So this reads
 * the record and renders it.
 *
 * Nothing here writes. kvPut is never reached, so there is no flag to thread
 * through the write path and nothing for a later edit to quietly re-enable.
 */
async function testSend(ticker, to) {
  const stored = await kvGet("record:" + ticker);
  if (!stored) throw new Error("No stored record for " + ticker + ". Run the backfill first.");
  const record = JSON.parse(stored);

  const view = forEmail(record);
  const unsub = SITE + "/unsubscribe?e=" + encodeURIComponent(to)
    + "&s=" + (await hmac(process.env.UNSUB_SECRET, to));

  const mail = renderEmail(
    { ...view, headline: headline(view.landed) },
    { unsubscribeUrl: unsub, postalAddress: process.env.POSTAL_ADDRESS }
  );

  await sendMail(to, mail, unsub);

  return {
    ticker,
    test: true,
    to,
    builtAt: record.builtAt,
    release: record.releasesRead?.[0]?.accession || null,
    filed: record.releasesRead?.[0]?.filed || null,
    sent: 1,
  };
}

/**
 * One company, one new release.
 *
 * The stored record already holds the guidance from the previous release, so
 * the guides being answered are read from KV rather than extracted again.
 */
async function handle(ticker) {
  const stored = await kvGet("record:" + ticker);
  if (!stored) throw new Error("No stored record. Run the backfill for " + ticker + " first.");
  const record = JSON.parse(stored);

  const { cik, name } = await resolveCik(env, ticker);
  const calendar = await companyCalendar(env, cik);
  const releases = await earningsReleases(env, cik, 3);
  if (!releases.length) throw new Error("No earnings releases found.");

  const current = releases[0];

  // Already briefed. The feed keeps showing a filing for hours, and the other
  // product re-briefed a company because a failure left it unrecorded.
  if ((record.releasesRead || []).some((r) => r.accession === current.accession)) {
    return { ticker, skipped: "Already in the record: " + current.accession };
  }

  // The guides this release answers were extracted when the previous release
  // was read. Re-reading it would double the bill for a known answer.
  const priorGuides = record.currentGuidance || [];
  const requests = requestsFrom(priorGuides);

  let actuals = [];
  if (requests.length) {
    const result = await actualsFrom(env, cik, current, requests, calendar);
    actuals = result.actuals;
  }

  const scored = scoreAll(pairUp(priorGuides, actuals));

  // What they have just guided for next, and what moved.
  const nowGuiding = await guidanceFrom(env, cik, current, calendar);
  const moved = revisionsBetween(priorGuides, nowGuiding.guides, {
    reportedPeriods: actuals.map((a) => a.period).filter(Boolean),
  });

  const updated = {
    ...record,
    company: name,
    builtAt: new Date().toISOString(),
    releasesRead: [{ accession: current.accession, filed: current.filed }, ...(record.releasesRead || [])],
    pairs: [
      ...scored.pairs.map((p) => ({ ...p, fromRelease: record.releasesRead?.[0]?.accession, answeredBy: current.accession })),
      ...(record.pairs || []),
    ],
    revisions: [
      ...moved.revisions.map((r) => ({ ...r, release: current.accession, filed: current.filed })),
      ...(record.revisions || []),
    ],
    currentGuidance: nowGuiding.guides,
  };

  await kvPut("record:" + ticker, JSON.stringify(updated));

  const view = forEmail(updated);
  const subscribers = JSON.parse((await kvGet("subscribers")) || "{}");
  const followers = Object.entries(subscribers)
    .filter(([, v]) => (v.tickers || []).includes(ticker))
    .map(([email]) => email);

  let sent = 0;
  for (const email of followers) {
    // One email per recipient, never a shared To: line.
    const unsub = SITE + "/unsubscribe?e=" + encodeURIComponent(email)
      + "&s=" + (await hmac(process.env.UNSUB_SECRET, email));
    const mail = renderEmail(
      { ...view, headline: headline(view.landed) },
      { unsubscribeUrl: unsub, postalAddress: process.env.POSTAL_ADDRESS }
    );
    await sendMail(email, mail, unsub);
    sent += 1;
  }

  return {
    ticker,
    release: current.accession,
    filed: current.filed,
    newPairs: scored.pairs.filter((p) => p.comparable).length,
    revisions: moved.revisions.length,
    followers: followers.length,
    sent,
  };
}

async function main() {
  // Flags come off first. Without this, --test is parsed as a ticker called
  // "--TEST" and the run fails looking for a record for it.
  const args = process.argv.slice(2);
  const isTest = args.includes("--test");
  const positional = args.filter((a) => !a.startsWith("--"));

  // A test run reads KV and posts an email. It does not touch EDGAR or the
  // model, so it must not demand keys for either - a missing DEEPSEEK_API_KEY
  // failing a render-only run would be a lie about what went wrong.
  const required = isTest
    ? {
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: CF_TOKEN,
        KV_NAMESPACE_ID: KV_ID, RESEND_API_KEY: process.env.RESEND_API_KEY,
        UNSUB_SECRET: process.env.UNSUB_SECRET, TEST_EMAIL: process.env.TEST_EMAIL,
      }
    : {
        SEC_USER_AGENT: env.SEC_USER_AGENT, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: CF_TOKEN,
        KV_NAMESPACE_ID: KV_ID, RESEND_API_KEY: process.env.RESEND_API_KEY,
        UNSUB_SECRET: process.env.UNSUB_SECRET,
      };

  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(name + " is not set.");
  }

  const tickers = String(positional.join(",") || "")
    .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) throw new Error("Name at least one ticker.");

  const results = [];
  let failures = 0;

  for (const ticker of tickers) {
    try {
      const r = isTest
        ? await testSend(ticker, process.env.TEST_EMAIL)
        : await handle(ticker);
      results.push(r);
      console.log(JSON.stringify(r));
    } catch (e) {
      failures += 1;
      results.push({ ticker, error: e.message });
      console.error(ticker + " FAILED: " + e.message);
    }
  }

  // The summary says plainly which kind of run this was. A test run that read
  // like a live one is how someone concludes the product sent something it
  // did not.
  const lines = isTest
    ? ["## Test send - rendered from the stored record, nothing written, nothing scored", "",
       "| ticker | record built | to | sent |", "|---|---|---|---|"]
    : ["## Live send", "", "| ticker | release | pairs | revisions | sent |", "|---|---|---|---|---|"];

  for (const r of results) {
    if (r.error) {
      lines.push(isTest
        ? "| " + r.ticker + " | FAILED | | " + r.error + " |"
        : "| " + r.ticker + " | FAILED | | | " + r.error + " |");
    } else if (r.skipped) {
      lines.push("| " + r.ticker + " | " + r.skipped + " | | | |");
    } else if (isTest) {
      lines.push("| " + r.ticker + " | " + r.builtAt + " | " + r.to + " | " + r.sent + " |");
    } else {
      lines.push("| " + r.ticker + " | " + r.filed + " | " + r.newPairs + " | " + r.revisions + " | " + r.sent + " |");
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  // A run where everything failed must not look like a run that worked.
  if (failures === tickers.length) throw new Error("Every ticker failed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
