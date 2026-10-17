/**
 * Who is on the shared subscriber list - read only.
 *
 * The run log of this public repository is public, so no address is printed
 * whole: each shows its first two characters and its domain, with the number
 * of companies per product. Nothing is written.
 *
 * Usage: node scripts/whois.mjs           (list)
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

if (process.env.CLEAR === "CLEAR") {
  const w = await fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body: "{}" });
  if (!w.ok) throw new Error("KV write failed: " + w.status);
  console.log("Cleared: " + Object.keys(list).length + " address(es) removed from the shared list.");
  process.exit(0);
}

const mask = (e) => { const [u, d] = String(e).split("@"); return u.slice(0, 2) + "***@" + (d || "?"); };
const rows = Object.entries(list);
console.log("Addresses on the shared list: " + rows.length);
for (const [email, v] of rows) {
  const n = (k) => (Array.isArray(v[k]) ? v[k].length : 0);
  console.log("  " + mask(email) + (email.toLowerCase() === OWNER ? "  (owner)" : "")
    + " | guidance " + n("tickers") + ", earnings " + n("earnings") + ", filings " + n("filings")
    + (v.confirmed === false ? " | unconfirmed" : "")
    + " | " + ["tickers", "earnings", "filings"].map((k) => k + ": " + (v[k] || []).join(",")).join("; ")
    + " | owner match: " + (OWNER ? String(email).toLowerCase() === OWNER : "no TEST_EMAIL set"));
}
