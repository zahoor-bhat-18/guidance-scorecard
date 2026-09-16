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
 */

import { resolveCik, companyCalendar } from "../src/xbrl.js";
import { earningsReleases, guidanceFrom } from "../src/guidance.js";
import { requestsFrom, actualsFrom } from "../src/actuals.js";
import { samePeriod } from "../src/period.js";
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

/* The same pairing rule as everywhere else: identical periods or nothing. */
function pairUp(guides, actuals) {
  const byName = new Map();
  for (const a of actuals) byName.set(String(a.metric_as_written || "").toLowerCase(), a);

  const pairs = [];
  for (const g of guides) {
    const hasNumber = typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number";
    if (!hasNumber) continue;

    const a = byName.get(String(g.metric_as_written || "").toLowerCase());
    const base = {
      metric: g.metric, metric_as_written: g.metric_as_written, basis: g.basis,
      unit: g.unit, shape: g.shape,
      guide: { low: g.low ?? null, high: g.high ?? null, value: g.value ?? null },
      guide_period: g.period, guide_period_text: g.period_text,
    };

    if (!a) { pairs.push({ ...base, comparable: false, why: "No actual was looked for under this metric." }); continue; }

    base.actual = a.value;
    base.actual_unit = a.unit;
    base.actual_period = a.period;
    base.actual_period_text = a.period_text;
    base.period_assumed = Boolean(a.period_assumed);
    base.actual_found_as = a.found_as;
    base.quote = a.quote;

    if (a.value === null) { pairs.push({ ...base, comparable: false, why: "The release does not report this figure." }); continue; }
    if (!g.period || !a.period) { pairs.push({ ...base, comparable: false, why: "A period could not be read." }); continue; }
    if (!samePeriod(g.period, a.period)) {
      pairs.push({ ...base, comparable: false, why: "Different periods: the guide is for " + g.period + " and the figure reported is for " + a.period + "." });
      continue;
    }
    if (a.unit_mismatch) { pairs.push({ ...base, comparable: false, why: "The figure reported is not the kind of number that was guided." }); continue; }
    if (a.basis_mismatch) { pairs.push({ ...base, comparable: false, why: a.basis_mismatch }); continue; }

    pairs.push({ ...base, comparable: true });
  }
  return pairs;
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
  for (const [name, value] of Object.entries({
    SEC_USER_AGENT: env.SEC_USER_AGENT, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: CF_TOKEN,
    KV_NAMESPACE_ID: KV_ID, RESEND_API_KEY: process.env.RESEND_API_KEY,
    UNSUB_SECRET: process.env.UNSUB_SECRET,
  })) {
    if (!value) throw new Error(name + " is not set.");
  }

  const tickers = String(process.argv.slice(2).join(",") || "")
    .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) throw new Error("Name at least one ticker.");

  const results = [];
  let failures = 0;

  for (const ticker of tickers) {
    try {
      const r = await handle(ticker);
      results.push(r);
      console.log(JSON.stringify(r));
    } catch (e) {
      failures += 1;
      results.push({ ticker, error: e.message });
      console.error(ticker + " FAILED: " + e.message);
    }
  }

  const lines = ["## Live send", "", "| ticker | release | pairs | revisions | sent |", "|---|---|---|---|---|"];
  for (const r of results) {
    lines.push(r.error
      ? "| " + r.ticker + " | FAILED | | | " + r.error + " |"
      : r.skipped
        ? "| " + r.ticker + " | " + r.skipped + " | | | |"
        : "| " + r.ticker + " | " + r.filed + " | " + r.newPairs + " | " + r.revisions + " | " + r.sent + " |");
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  // A run where everything failed must not look like a run that worked.
  if (failures === tickers.length) throw new Error("Every ticker failed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
