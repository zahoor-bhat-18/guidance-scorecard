/**
 * Who is on the shared subscriber list - read only.
 *
 * The run log of this public repository is public, so no address is printed
 * whole: each shows its first two characters and its domain, with the number
 * of companies per product. Nothing is written.
 *
 * Usage: node scripts/whois.mjs           (list)
 *        FOLLOW="V,GOOGL" node scripts/whois.mjs (the owner follows these on every product)
 *        KEEP="V,GOOGL" node scripts/whois.mjs   (the owner follows only these on the US products)
 *        CLEAR=CLEAR node scripts/whois.mjs (empty the list - every product, every address)
 */

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.KV_NAMESPACE_ID;
const OWNER = String(process.env.TEST_EMAIL || "").toLowerCase();

const url = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
  + "/storage/kv/namespaces/" + KV_ID + "/values/" + encodeURIComponent("subscribers");
const r = await fetch(url, { headers: { Authorization: "Bearer " + CF_TOKEN } });
if (!r.ok && r.status !== 404) throw new Error("KV read failed: " + r.status);
const list = r.status === 404 ? {} : JSON.parse(await r.text());

// FOLLOW="V,GOOGL": the owner's address (TEST_EMAIL) follows these on every product, as a confirmed signup would.
if (process.env.FOLLOW) {
  if (!OWNER) throw new Error("TEST_EMAIL is not set: FOLLOW only ever changes the owner's own address.");
  const add = String(process.env.FOLLOW).toUpperCase().split(/[\s,]+/).filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
  const key = Object.keys(list).find((e) => e.toLowerCase() === OWNER) || OWNER;
  const rec = { ...(list[key] || { confirmedAt: new Date().toISOString() }) };
  for (const f of ["tickers", "earnings", "filings"]) rec[f] = Array.from(new Set([...(rec[f] || []), ...add]));
  rec.updatedAt = new Date().toISOString();
  list[key] = rec;
  const w = await fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body: JSON.stringify(list) });
  if (!w.ok) throw new Error("KV write failed: " + w.status);
  console.log("Owner now follows " + rec.tickers.length + " companies on every product; added: " + add.join(","));
}

// KEEP="V,GOOGL": the owner's address follows only these on the three US products (the rest are dropped; GCC is untouched).
if (process.env.KEEP) {
  if (!OWNER) throw new Error("TEST_EMAIL is not set: KEEP only ever changes the owner's own address.");
  const keep = String(process.env.KEEP).toUpperCase().split(/[\s,]+/).filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t));
  const key = Object.keys(list).find((e) => e.toLowerCase() === OWNER);
  if (!key) throw new Error("The owner's address is not on the list.");
  if (!keep.length) throw new Error("KEEP names no tickers: nothing changed.");
  const rec = { ...list[key] };
  for (const f of ["tickers", "earnings", "filings"]) rec[f] = (rec[f] || []).filter((t) => keep.includes(t));
  rec.updatedAt = new Date().toISOString();
  list[key] = rec;
  const w = await fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body: JSON.stringify(list) });
  if (!w.ok) throw new Error("KV write failed: " + w.status);
  console.log("Owner now follows " + rec.tickers.length + " companies on the US products: " + rec.tickers.join(","));
}

if (process.env.CLEAR === "CLEAR") {
  const w = await fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body: "{}" });
  if (!w.ok) throw new Error("KV write failed: " + w.status);
  console.log("Cleared: " + Object.keys(list).length + " address(es) removed from the shared list.");
  process.exit(0);
}

// The log is public: two letters of the name, and the domain only if it is a public mail service.
const PUBLIC_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|proton|protonmail|aol)\./i;
const mask = (e) => { const [u, d] = String(e).split("@"); return u.slice(0, 2) + "***@" + (d && PUBLIC_MAIL.test(d) ? d : "(work domain)"); };
const rows = Object.entries(list);
console.log("Addresses on the shared list: " + rows.length);
const by = (k) => rows.filter(([, v]) => Array.isArray(v[k]) && v[k].length).length;
console.log("By product: Guidance Scorecard " + by("tickers") + ", Release Watch " + by("earnings") + ", Filing Watch " + by("filings") + ", GCC Watch " + by("gcc"));
for (const [email, v] of rows) {
  const n = (k) => (Array.isArray(v[k]) ? v[k].length : 0);
  console.log("  " + mask(email) + (email.toLowerCase() === OWNER ? "  (owner)" : "")
    + " | since " + String(v.confirmedAt || "?").slice(0, 10)
    + " | guidance " + n("tickers") + ", earnings " + n("earnings") + ", filings " + n("filings") + ", gcc " + n("gcc")
    + (v.confirmed === false ? " | unconfirmed" : "")
    + " | " + ["tickers", "earnings", "filings", "gcc"].map((k) => k + ": " + (v[k] || []).join(",")).join("; ")
    + " | owner match: " + (OWNER ? String(email).toLowerCase() === OWNER : "no TEST_EMAIL set"));
}

/* UNSUBSCRIBE CHECK (18 Oct 2026). Builds the link each email carries, with
   this repository's UNSUB_SECRET, and opens it on the live site. Nothing is
   removed: the made-up address is on no list, so a working link answers
   "Already gone" and a broken one "not valid". The owner's own link is only
   opened (GET), which shows the confirm page and changes nothing. */
if (process.env.UNSUB_SECRET) {
  const SITE = (process.env.SITE_URL || "https://zahoorbhat.com").replace(/\/$/, "");
  const sign = async (value) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  };
  const link = async (email, p) => SITE + "/unsubscribe?e=" + encodeURIComponent(email) + "&s=" + (await sign(email)) + (p ? "&p=" + p : "");
  const verdict = (html) => /not valid/i.test(html) ? "LINK NOT VALID" : /Already gone/i.test(html) ? "valid (address not on list)" : /<h1>Leave/i.test(html) ? "valid (confirm page shown)" : /Removed/i.test(html) ? "REMOVED?!" : "unexpected: " + html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120);
  const fake = "unsub-check@zahoorbhat.com";
  console.log("\nUnsubscribe links, signed with this repository's secret:");
  for (const p of ["guidance", "earnings", "filings", ""]) {
    const u = await link(fake, p);
    const g = await (await fetch(u)).text();
    const post = await (await fetch(u, { method: "POST" })).text();
    console.log("  " + (p || "all").padEnd(9) + " GET: " + verdict(g) + " | POST: " + verdict(post));
  }
  const bad = SITE + "/unsubscribe?e=" + encodeURIComponent(fake) + "&s=00000000000000000000000000000000&p=guidance";
  console.log("  forged    GET: " + verdict(await (await fetch(bad)).text()) + " (should be LINK NOT VALID)");
  if (OWNER && list[OWNER]) for (const p of ["guidance", "earnings", "filings"]) {
    const html = await (await fetch(await link(OWNER, p))).text();
    console.log("  owner " + p.padEnd(9) + " GET: " + verdict(html) + " - " + ((/where it follows ([^.<]*)/.exec(html) || [])[1] || ""));
  }
}
