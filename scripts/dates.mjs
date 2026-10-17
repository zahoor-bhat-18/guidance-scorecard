/**
 * Earnings dates for every followed company (the product structure, 17 Oct 2026).
 *
 * One call to Alpha Vantage's earnings calendar (free key, Actions secret
 * ALPHAVANTAGE_KEY) gives every US company reporting in the next three
 * months. For each company someone follows, on any product, the next date is
 * stored in KV as date:<TICKER> = { date, time, fiscalDateEnding, source, at }.
 * The preview reads it and sends the evening before.
 *
 * Checked against the company's own history: a date more than 14 days from
 * the same quarter last year is logged as a warning (it is still stored - the
 * company's own calendar can move).
 *
 * Usage: node scripts/dates.mjs [--dry]
 */

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.KV_NAMESPACE_ID;
const KEY = process.env.ALPHAVANTAGE_KEY;

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

/* One CSV line, with quoted fields ("Apple, Inc."). */
function cells(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

async function main() {
  const dry = process.argv.includes("--dry");
  if (!KEY) throw new Error("ALPHAVANTAGE_KEY is not set (Actions secret).");
  const r = await fetch("https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=" + encodeURIComponent(KEY));
  if (!r.ok) throw new Error("Alpha Vantage " + r.status);
  const text = await r.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = cells(lines[0] || "");
  if (head[0] !== "symbol" || !head.includes("reportDate")) throw new Error("Unexpected answer from Alpha Vantage: " + text.slice(0, 200));
  const col = (n) => head.indexOf(n);
  const next = new Map();
  const today = new Date().toISOString().slice(0, 10);
  for (const l of lines.slice(1)) {
    const c = cells(l);
    const sym = String(c[col("symbol")] || "").toUpperCase(), date = c[col("reportDate")];
    if (!sym || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || date < today) continue;
    const prev = next.get(sym);
    if (!prev || date < prev.date) next.set(sym, { date, time: col("timeOfTheDay") >= 0 ? (c[col("timeOfTheDay")] || "") : "", fiscalDateEnding: c[col("fiscalDateEnding")] || "" });
  }
  console.log("Calendar: " + next.size + " companies with a report date in the next three months.");

  const subs = JSON.parse((await kvGet("subscribers")) || "{}");
  const followed = Array.from(new Set(Object.values(subs).flatMap((v) => [...(v.tickers || []), ...(v.earnings || []), ...(v.filings || [])]))).sort();
  console.log("Followed: " + followed.length + " companies.");
  let stored = 0;
  for (const t of followed) {
    const d = next.get(t);
    if (!d) { console.log("  " + t.padEnd(6) + " no date in the next three months"); continue; }
    // Last year's same-quarter date, from the record, as a check.
    let warn = "";
    try {
      const rec = JSON.parse((await kvGet("record:" + t)) || "null");
      const rel = ((rec && rec.releasesRead) || []).map((x) => x.filed).sort().reverse();
      const lastYear = rel.find((f) => Math.abs(days(f, d.date) - 364) <= 45);
      if (lastYear && Math.abs(days(lastYear, d.date) - 364) > 14) warn = " - WARNING: " + days(lastYear, d.date) + " days after last year's " + lastYear;
    } catch { /* the check is a check, never a stop */ }
    console.log("  " + t.padEnd(6) + " " + d.date + (d.time ? " " + d.time : "") + warn);
    if (!dry) { await kvPut("date:" + t, JSON.stringify({ ...d, source: "Alpha Vantage earnings calendar", at: new Date().toISOString() })); stored++; }
  }
  console.log("Stored: " + stored + ".");
}

main().catch((e) => { console.error(e); process.exit(1); });
