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
 * Usage: node scripts/prices.mjs [--probe TICKER] [TICKERS...]
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
}
main().catch((e) => { console.error(e); process.exit(1); });
