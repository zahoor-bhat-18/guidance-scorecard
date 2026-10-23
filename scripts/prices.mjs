/**
 * Daily closing prices for followed companies, kept in KV as prices:<TICKER>
 * = { at, closes: { "YYYY-MM-DD": close, ... } } (unadjusted closes; the
 * reaction table compares the close before a release with the close after,
 * a day or two apart, so splits do not distort it except across a split day).
 *
 * Source: Alpha Vantage TIME_SERIES_DAILY (ALPHAVANTAGE_KEY). Free tier: 25
 * requests a day, so each company is fetched at most once a day, companies
 * with a stored date nearest first. Alpha Vantage's free licence is for
 * non-commercial use: fine while the product is free; to be revisited before
 * it is sold (owner's decision, 23 Oct 2026).
 *
 * Usage: node scripts/prices.mjs [--probe TICKER] [--dump TICKERS...] [TICKERS...]
 */
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID, CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN, KV_ID = process.env.KV_NAMESPACE_ID, KEY = process.env.ALPHAVANTAGE_KEY;
const kvUrl = (k) => "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + "/storage/kv/namespaces/" + KV_ID + "/values/" + encodeURIComponent(k);
async function kvGet(k) { const r = await fetch(kvUrl(k), { headers: { Authorization: "Bearer " + CF_TOKEN } }); if (r.status === 404) return null; if (!r.ok) throw new Error("KV " + r.status); return r.text(); }
async function kvPut(k, v) { const body = new FormData(); body.set("value", v); body.set("metadata", "{}"); const r = await fetch(kvUrl(k), { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body }); if (!r.ok) throw new Error("KV write " + r.status); }

async function daily(ticker, full) {
  const u = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=" + encodeURIComponent(ticker) + "&outputsize=" + (full ? "full" : "compact") + "&apikey=" + encodeURIComponent(KEY);
  const j = await (await fetch(u)).json();
  const ts = j["Time Series (Daily)"];
  if (!ts) return { error: JSON.stringify(j).slice(0, 300) };
  const closes = {};
  for (const [d, v] of Object.entries(ts)) closes[d] = Number(v["4. close"]);
  return { closes };
}

async function main() {
  if (!KEY) throw new Error("ALPHAVANTAGE_KEY is not set");
  const args = process.argv.slice(2);
  if (args[0] === "--probe") {
    for (const full of [true, false]) {
      const r = await daily(args[1] || "IBM", full);
      const days = r.closes ? Object.keys(r.closes).sort() : [];
      console.log((full ? "full" : "compact") + ": " + (r.error || days.length + " days, " + days[0] + " to " + days[days.length - 1]));
    }
    return;
  }
  // --dump T...: print what is stored, one line of JSON a company (prices are public data).
  if (args[0] === "--dump") {
    for (const t of args.slice(1)) console.log("PRICES " + t.toUpperCase() + " " + ((await kvGet("prices:" + t.toUpperCase())) || "null"));
    return;
  }
  // Every followed company (any product), soonest stored report date first; at most 24 a day.
  const subs = JSON.parse((await kvGet("subscribers")) || "{}");
  let tickers = args.length ? args.map((t) => t.toUpperCase())
    : Array.from(new Set(Object.values(subs).flatMap((v) => [...(v.tickers || []), ...(v.earnings || []), ...(v.filings || [])]))).sort();
  const dateOf = {};
  for (const t of tickers) { try { dateOf[t] = (JSON.parse((await kvGet("date:" + t)) || "null") || {}).date || "9999"; } catch { dateOf[t] = "9999"; } }
  tickers.sort((a, b) => dateOf[a].localeCompare(dateOf[b]));
  const today = new Date().toISOString().slice(0, 10);
  let asked = 0;
  for (const t of tickers) {
    const stored = JSON.parse((await kvGet("prices:" + t)) || "null") || { closes: {} };
    if (stored.at && stored.at.slice(0, 10) === today) { console.log("  " + t + ": already fetched today"); continue; }
    if (asked >= 24) { console.log("  " + t + ": over today's 24 requests - tomorrow"); continue; }
    if (asked) await new Promise((r) => setTimeout(r, 1500));          // the free key: one request a second
    asked++;
    const r = await daily(t, false);
    if (r.error) { console.log("  " + t + ": " + r.error.slice(0, 160)); continue; }
    // Kept, not replaced: the free key gives 100 days, and the history grows a day at a time.
    const closes = { ...stored.closes, ...r.closes };
    const days = Object.keys(closes).sort();
    await kvPut("prices:" + t, JSON.stringify({ at: new Date().toISOString(), source: "Alpha Vantage TIME_SERIES_DAILY", closes }));
    console.log("  " + t + ": " + days.length + " days stored, " + days[0] + " to " + days[days.length - 1]);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
