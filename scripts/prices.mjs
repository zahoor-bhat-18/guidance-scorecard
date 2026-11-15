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

/* The longer record. Alpha Vantage's free key gives the last 100 trading
   days, so the reaction table had two quarters. Nasdaq.com's historical
   quotes go back years and need no key; they fill the closes before Alpha
   Vantage's window, once per company (owner's request, 28 Oct 2026: 7-8
   quarters). Alpha Vantage's closes win where both have a day. Stooq was
   tried first and now refuses scripts. */
/* Says who is asking; never posing as a browser (owner's rule). A site that refuses this is left alone. */
const BROWSER = { "User-Agent": "Mozilla/5.0 (compatible; zahoorbhat.com research; hello@zahoorbhat.com)", Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" };
async function nasdaq(ticker, from) {
  const to = new Date().toISOString().slice(0, 10);
  const r = await fetch("https://api.nasdaq.com/api/quote/" + encodeURIComponent(ticker.replace(/\./g, "/")) + "/historical?assetclass=stocks&fromdate=" + from + "&todate=" + to + "&limit=9999", { headers: BROWSER });
  const text = await r.text();
  let rows;
  try { rows = JSON.parse(text).data.tradesTable.rows || []; } catch { return { error: "nasdaq " + r.status + ": " + text.slice(0, 120).replace(/\s+/g, " ") }; }
  const closes = {};
  for (const x of rows) {
    const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(x.date || ""), c = Number(String(x.close || "").replace(/[$,]/g, ""));
    if (m && c > 0) closes[`${m[3]}-${m[1]}-${m[2]}`] = c;
  }
  return { closes };
}
const YEARS_BACK = 2.25;

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
  if (args[0] === "--probe-nasdaq") {
    const t = (args[1] || "IBM").toUpperCase();
    const from = new Date(Date.now() - 2.3 * 365.25 * 86400000).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
    const r = await fetch("https://api.nasdaq.com/api/quote/" + t + "/historical?assetclass=stocks&fromdate=" + from + "&todate=" + to + "&limit=9999", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" } });
    const text = await r.text();
    let rows = [];
    try { rows = JSON.parse(text).data.tradesTable.rows || []; } catch { console.log("nasdaq " + r.status + ": " + text.slice(0, 160)); return; }
    console.log("nasdaq: " + rows.length + " days, " + (rows[rows.length - 1] || {}).date + " to " + (rows[0] || {}).date + "; " + JSON.stringify(rows[0]));
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
    let closes = { ...stored.closes, ...r.closes };
    closes = Object.fromEntries(Object.entries(closes).sort());
    const days = Object.keys(closes).sort();
    await kvPut("prices:" + t, JSON.stringify({ at: new Date().toISOString(), source: stored.source && /Nasdaq/.test(stored.source) ? stored.source : "Alpha Vantage TIME_SERIES_DAILY", closes }));
    console.log("  " + t + ": " + days.length + " days stored, " + days[0] + " to " + days[days.length - 1]);
  }
  // The longer record, for every company whose stored closes start within the
  // last YEARS_BACK years. No key and no daily limit, but one request a second.
  const want = new Date(Date.now() - YEARS_BACK * 365.25 * 86400000).toISOString().slice(0, 10);
  for (const t of tickers) {
    const stored = JSON.parse((await kvGet("prices:" + t)) || "null") || { closes: {} };
    const first = Object.keys(stored.closes || {}).sort()[0] || "9999";
    if (first <= want || stored.nasdaqAt) continue;
    await new Promise((r) => setTimeout(r, 1200));
    const old = await nasdaq(t, want).catch((e) => ({ error: e.message }));
    if (old.error) { console.log("  " + t + ": " + old.error); continue; }
    let n = 0;
    const closes = { ...stored.closes };
    for (const [d, v] of Object.entries(old.closes)) if (!closes[d]) { closes[d] = v; n++; }
    await kvPut("prices:" + t, JSON.stringify({ ...stored, nasdaqAt: new Date().toISOString(), source: "Alpha Vantage TIME_SERIES_DAILY; earlier days Nasdaq.com", closes: Object.fromEntries(Object.entries(closes).sort()) }));
    console.log("  " + t + ": " + n + " earlier days from Nasdaq.com");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
