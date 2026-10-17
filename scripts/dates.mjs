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

/* THE COMPANY'S OWN DATE COMES FIRST (17 Oct 2026). The calendars are third
   parties and can be wrong (Alpha Vantage had Philip Morris a day early). So
   for each company the script first reads the company's own investor site and
   looks for the date it announced; the calendars are the fallback.

   SEC does not record companies' websites, so the investor site is found from
   the company's own last earnings release on EDGAR (every release names its
   investor site or webcast page). Found once, kept in KV as ir:<TICKER>.
   On the site, the investor page and its event / earnings / webcast pages are
   read, and a date counts only when it sits next to words about quarterly
   results, is in the next 45 days, and is within 14 days of the calendars
   (a guard against reading some other date on the page). */
const UA = process.env.SEC_USER_AGENT || "guidance-scorecard (zahoorbhat.com)";
const BROWSER = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", Accept: "text/html,application/json;q=0.9,*/*;q=0.8" };
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
let cikMap = null;
async function cikOf(t) {
  if (!cikMap) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": UA } });
    cikMap = new Map(Object.values(await r.json()).map((x) => [String(x.ticker).toUpperCase(), String(x.cik_str)]));
  }
  return cikMap.get(t) || null;
}
const plain = (html) => String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/\s+/g, " ");

/* The company's investor pages. SEC does not record websites, so the official
   website comes from Wikidata (looked up by SEC CIK, property P5531; official
   website P856), and the investor site is the link on it named "Investors".
   Kept in KV as ir:<TICKER> once found. */
async function officialSite(t) {
  const cik = await cikOf(t);
  if (!cik) return null;
  const pad = cik.padStart(10, "0");
  const q = 'SELECT ?site WHERE { VALUES ?k { "' + pad + '" "' + cik + '" } ?c wdt:P5531 ?k ; wdt:P856 ?site . }';
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q),
    { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const rows = (((await r.json()) || {}).results || {}).bindings || [];
  return rows.map((x) => x.site.value)[0] || null;
}
async function irPages(t) {
  const site = await officialSite(t);
  if (!site) return { site: null, urls: [] };
  const home = await getPage(site);
  const urls = new Set();
  if (home) {
    for (const m of home.html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
      let u; try { u = new URL(m[1], home.url); } catch { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      const label = plain(m[2]).trim();
      if (/investor/i.test(label) || /investor|^ir\./i.test(u.hostname) || /\/investors?(?:-relations)?\/?$|\/ir\/?$/i.test(u.pathname)) urls.add(u.origin + u.pathname);
    }
  }
  // Common investor hosts and paths on the company's own domain.
  let host = ""; try { host = new URL(site).hostname.replace(/^(?:www|ir|investors?)\./, ""); } catch { host = ""; }
  if (host) for (const g of ["https://ir." + host + "/", "https://investor." + host + "/", "https://investors." + host + "/", "https://www." + host + "/investors", "https://www." + host + "/investor-relations"]) urls.add(g);
  return { site, urls: [...urls].slice(0, 9) };
}

/* Investor hosts the company's last earnings release names (Netflix's
   ir.netflix.net is not on netflix.com). Investor / IR hosts only. */
async function irFromRelease(t, rec) {
  const acc = (((rec && rec.releasesRead) || []).slice().sort((a, b) => String(b.filed).localeCompare(String(a.filed)))[0] || {}).accession;
  const cik = await cikOf(t);
  if (!cik || !acc) return [];
  const base = "https://www.sec.gov/Archives/edgar/data/" + cik + "/" + acc.replace(/-/g, "") + "/";
  const idx = await fetch(base + "index.json", { headers: { "User-Agent": UA } });
  if (!idx.ok) return [];
  const names = ((((await idx.json()) || {}).directory || {}).item || []).map((i) => i.name).filter((n) => /\.htm$/i.test(n) && /99/.test(n));
  const out = new Set();
  for (const n of names.slice(0, 2)) {
    const r = await fetch(base + n, { headers: { "User-Agent": UA } });
    if (!r.ok) continue;
    for (const m of (await r.text()).matchAll(/https?:\/\/[^\s"'<>)&]+|\bwww\.[a-z0-9-]+\.[a-z.]+[^\s"'<>)&]*/gi)) {
      let u; try { u = new URL(/^https?:/i.test(m[0]) ? m[0].replace(/[.,;]+$/, "") : "https://" + m[0].replace(/[.,;]+$/, "")); } catch { continue; }
      if (/^(ir|investors?)\./i.test(u.hostname)) out.add(u.origin + "/");
      else if (/investor/i.test(u.pathname) && !/sec\.gov/i.test(u.hostname)) out.add(u.origin + u.pathname);
    }
  }
  return [...out].slice(0, 3);
}

const DEBUG = process.argv.includes("--dry");
async function getPage(url) {
  try {
    const r = await fetch(url, { headers: BROWSER, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) { if (DEBUG) console.log("         " + r.status + " " + url); return null; }
    const type = r.headers.get("content-type") || "";
    if (!/html|json|xml|text\/plain/i.test(type)) { if (DEBUG) console.log("         skip " + type + " " + url); return null; }
    const html = await r.text();
    if (DEBUG) {
      const t = plain(html);
      const ds = [...t.matchAll(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+2026/gi)].map((m) => m[0]).slice(-4);
      console.log("         200 " + url + " -> " + (r.url !== url ? r.url + " " : "") + t.length + " chars; dates: " + (ds.join(" | ") || "none"));
      if (t.length < 3000) console.log("           scripts: " + [...html.matchAll(/<script[^>]*src=["']([^"']+)/gi)].map((m) => m[1]).slice(0, 6).join(" ") + " | " + (html.match(/apiKey[^,;]{0,60}/i) || [""])[0]);
    }
    return { url: r.url || url, html };
  } catch (e) { if (DEBUG) console.log("         ERR " + url + " " + e.message); return null; }
}

/* Dates the company itself shows for its coming results. */
function datesOnPage(text, today, horizon) {
  const out = [];
  const re = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/gi;
  for (const m of text.matchAll(re)) {
    const mon = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    const d = m[3] + "-" + String(mon).padStart(2, "0") + "-" + String(m[2]).padStart(2, "0");
    if (d < today || d > horizon) continue;
    const ctx = text.slice(Math.max(0, m.index - 250), m.index + 250);
    if (!/quarter|\bQ[1-4]\b|[1-4]Q\d\d|earnings|financial results|results|webcast|conference call/i.test(ctx)) continue;
    if (/dividend|annual (?:general |shareholders' |stockholders' )?meeting|record date|payable|investor day|conference\b(?! call)/i.test(ctx) && !/earnings|results/i.test(ctx)) continue;
    const after = text.slice(m.index, m.index + 160);
    const tm = after.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
    let time = "";
    if (tm) { let h = Number(tm[1]) % 12; if (/p/i.test(tm[3])) h += 12; time = h < 12 ? "pre-market" : h >= 16 ? "post-market" : ""; }
    out.push({ date: d, time, quote: ctx.replace(/\s+/g, " ").trim().slice(150, 400) });
  }
  return out;
}

/* Many investor sites run on the Q4 platform, which loads events with
   JavaScript from a public feed on the same host. Read the feed directly. */
async function q4Events(host) {
  const out = [];
  for (const path of ["/feed/Event.svc/GetEventList?LanguageId=1&eventSelection=1&eventDateFilter=1&includeFeedContent=true&pageSize=10&pageNumber=0&sortOperator=1",
                      "/feed/PressRelease.svc/GetPressReleaseList?LanguageId=1&bodyType=3&pressReleaseDateFilter=3&categoryId=1cb807d2-208f-4bc3-9133-6a9ad45ac3b0&pageSize=10&pageNumber=0&tagList=&includeTags=true&year=-1&excludeSelection=1"]) {
    for (const key of ["BF185719B0464B3CB809D23926182246", ""]) {
      const p = await getPage("https://" + host + path + (key ? "&apiKey=" + key : ""));
      if (!p || !/^\s*[\[{]/.test(p.html)) continue;
      out.push({ url: "https://" + host + path.split("?")[0], text: plain(p.html.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">")).replace(/"(\d{1,2})\/(\d{1,2})\/(20\d\d)/g, (m, mo, d, y) => " " + MONTHS[Number(mo) - 1] + " " + d + ", " + y) });
      break;
    }
  }
  return out;
}

async function companyDate(t, rec, today, horizon) {
  let ir = null;
  try { ir = JSON.parse((await kvGet("ir:" + t)) || "null"); } catch { ir = null; }
  if (!ir || !(ir.urls || []).length) {
    const fromSite = await irPages(t);
    let fromRel = []; try { fromRel = await irFromRelease(t, rec); } catch { fromRel = []; }
    ir = { site: fromSite.site, urls: Array.from(new Set([...fromSite.urls, ...fromRel])), at: new Date().toISOString() };
    if (ir.urls.length && !process.argv.includes("--dry")) { try { await kvPut("ir:" + t, JSON.stringify(ir)); } catch { /* kept next time */ } }
  }
  const seen = new Set(), hits = [], read = [];
  const queue = [...ir.urls];
  while (queue.length && read.length < 16) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    const p = await getPage(u);
    if (!p) continue;
    read.push(u);
    const text = plain(p.html);
    for (const h of datesOnPage(text, today, horizon)) hits.push({ ...h, url: p.url });
    if (text.length < 3000) {
      let hh = ""; try { hh = new URL(p.url).host; } catch { hh = ""; }
      if (hh && !seen.has("q4:" + hh)) {
        seen.add("q4:" + hh);
        for (const f of await q4Events(hh)) for (const h of datesOnPage(f.text, today, horizon)) hits.push({ ...h, url: f.url });
      }
    }
    // One level down: the site's own event, earnings and webcast pages.
    let host; try { host = new URL(p.url).host; } catch { continue; }
    for (const m of p.html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
      let next; try { next = new URL(m[1], p.url); } catch { continue; }
      if (next.host !== host) continue;
      if (/\.(?:pdf|mp3|mp4|xlsx?|docx?|pptx?|zip|jpe?g|png|gif|svg)$/i.test(next.pathname)) continue;
      const label = plain(m[2]);
      if (!/event|calendar|earnings|quarter|webcast|results|conference call|press|news/i.test(next.pathname + " " + label)) continue;
      const key = next.origin + next.pathname;
      if (seen.has(key) || queue.length >= 40) continue;
      // Announcements of the call itself go to the front of the queue.
      if (/conference call|webcast|announces? (?:date|timing)|to (?:report|release|announce|host)|(?:earnings|results) (?:date|call)/i.test(label)) queue.unshift(key); else queue.push(key);
    }
  }
  return { hits, read, urls: ir.urls };
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
  console.log("Alpha Vantage: " + next.size + " companies with a report date in the next three months.");

  /* A SECOND CALENDAR. Alpha Vantage put Philip Morris on 20 Oct 2026; the
     company had announced 21 Oct, and Nasdaq's calendar had 21 Oct. One
     calendar alone can be wrong in either direction. Nasdaq's is read for the
     next 21 days; where the two disagree, the EARLIER date is kept, so a
     preview can come a day early but never after the release. */
  const nasdaq = new Map();
  for (let i = 0; i <= 21; i++) {
    const d = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
    try {
      const rr = await fetch("https://api.nasdaq.com/api/calendar/earnings?date=" + d, { headers: { "User-Agent": "Mozilla/5.0 (compatible; zahoorbhat.com earnings calendar)", Accept: "application/json" } });
      if (!rr.ok) continue;
      const rows = (((await rr.json()) || {}).data || {}).rows || [];
      for (const row of rows) {
        const sym = String(row.symbol || "").toUpperCase();
        if (!sym || nasdaq.has(sym)) continue;
        const tm = /pre/i.test(row.time || "") ? "pre-market" : /after|post/i.test(row.time || "") ? "post-market" : "";
        nasdaq.set(sym, { date: d, time: tm });
      }
    } catch { /* one day missing is not a stop */ }
  }
  console.log("Nasdaq: " + nasdaq.size + " companies in the next 21 days.");

  const subs = JSON.parse((await kvGet("subscribers")) || "{}");
  const followed = Array.from(new Set(Object.values(subs).flatMap((v) => [...(v.tickers || []), ...(v.earnings || []), ...(v.filings || [])]))).sort();
  console.log("Followed: " + followed.length + " companies.");
  let stored = 0;
  for (const t of followed) {
    const av = next.get(t), nq = nasdaq.get(t);
    let rec = null;
    try { rec = JSON.parse((await kvGet("record:" + t)) || "null"); } catch { rec = null; }
    const cal = !av && !nq ? null : !av ? nq : !nq ? av : (nq.date <= av.date ? nq : av);
    // The company's own site first.
    let co = null;
    try {
      const horizon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
      const found = await companyDate(t, rec, today, horizon);
      const near = found.hits.filter((h) => !cal || Math.abs(days(cal.date, h.date)) <= 14);
      const dates = Array.from(new Set(near.map((h) => h.date))).sort();
      if (dates.length) {
        const best = cal ? dates.slice().sort((a, b) => Math.abs(days(cal.date, a)) - Math.abs(days(cal.date, b)))[0] : dates[0];
        co = near.find((h) => h.date === best && h.time) || near.find((h) => h.date === best);
        if (dates.length > 1) console.log("  " + t.padEnd(6) + " company pages show several dates: " + dates.join(", ") + "; kept " + best);
      } else {
        console.log("  " + t.padEnd(6) + " company site: no date found (read " + found.read.length + " pages from " + (found.urls.join(" ") || "no investor page found") + ")" + (process.argv.includes("--dry") && found.read.length ? "\n         read: " + found.read.join(" ") : "")
          + (found.hits.length ? "; dates far from the calendars ignored: " + Array.from(new Set(found.hits.map((h) => h.date))).join(", ") : ""));
      }
    } catch (e) { console.log("  " + t.padEnd(6) + " company site check failed: " + e.message); }
    if (!co && !cal) { console.log("  " + t.padEnd(6) + " no date from the company or either calendar"); continue; }
    const pick = co ? { date: co.date, time: co.time || (cal && cal.date === co.date ? cal.time : "") } : cal;
    const d = { ...(av || {}), ...pick, alphavantage: av ? av.date : null, nasdaq: nq ? nq.date : null, agree: Boolean(av && nq && av.date === nq.date),
      company: co ? { date: co.date, url: co.url, quote: co.quote } : null };
    // Last year's same-quarter date, from the record, as a check.
    let warn = "";
    try {
      const rel = ((rec && rec.releasesRead) || []).map((x) => x.filed).sort().reverse();
      const lastYear = rel.find((f) => Math.abs(days(f, d.date) - 364) <= 45);
      if (lastYear && Math.abs(days(lastYear, d.date) - 364) > 14) warn = " - WARNING: " + days(lastYear, d.date) + " days after last year's " + lastYear;
    } catch { /* the check is a check, never a stop */ }
    const cals = "Nasdaq " + (d.nasdaq || "-") + ", Alpha Vantage " + (d.alphavantage || "-");
    const source = co ? "company's own site (" + co.url + ")" : d.agree ? "Nasdaq and Alpha Vantage calendars" : "earlier of Nasdaq and Alpha Vantage calendars";
    console.log("  " + t.padEnd(6) + " " + d.date + (d.time ? " " + d.time : "") + " from " + source + " [" + cals + "]" + warn
      + (co ? "\n         \"" + co.quote.slice(0, 160) + "\"" : ""));
    if (!dry) { await kvPut("date:" + t, JSON.stringify({ ...d, source, at: new Date().toISOString() })); stored++; }
  }
  console.log("Stored: " + stored + ".");
}

main().catch((e) => { console.error(e); process.exit(1); });
