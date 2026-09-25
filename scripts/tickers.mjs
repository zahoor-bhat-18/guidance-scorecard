/**
 * The ticker to CIK map, refreshed into KV.
 *
 * The poller reads EDGAR's current-filings feed, which names companies by CIK
 * and never by ticker. Subscribers name companies by ticker and never by CIK.
 * Something has to hold the bridge, and it cannot be a lookup per poll - the
 * feed runs every minute and SEC's list is a megabyte.
 *
 * So it is fetched once a month into one KV key, and the poller reads that.
 * The other product does the same and for the same reason.
 *
 * Only the tickers anyone could plausibly follow are worth keeping, but the
 * whole list is small enough once reduced to a flat object that filtering adds
 * a failure mode for nothing.
 */

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.KV_NAMESPACE_ID;
const UA = process.env.SEC_USER_AGENT;

async function main() {
  for (const [name, value] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
    KV_NAMESPACE_ID: KV_ID,
    SEC_USER_AGENT: UA,
  })) {
    if (!value) throw new Error(name + " is not set.");
  }

  const r = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("SEC returned " + r.status + " for the ticker list.");

  const raw = await r.json();
  const map = {};
  // Ticker and company name, for the search box on the site: typing "M" lists
  // Meta, Macy's, Microsoft. Kept apart from the map because the poller reads
  // the map every minute and has no use for names.
  const names = [];
  for (const row of Object.values(raw)) {
    if (!row || !row.ticker || !row.cik_str) continue;
    const t = String(row.ticker).toUpperCase();
    if (!(t in map)) names.push([t, String(row.title || "").trim()]);
    map[t] = String(row.cik_str).padStart(10, "0");
  }

  const count = Object.keys(map).length;
  // A list this much smaller than expected means SEC served something else -
  // an error page, a redirect - and writing it would leave the poller matching
  // nothing, silently, until someone noticed the emails had stopped.
  if (count < 5000) throw new Error("Only " + count + " tickers parsed. Not overwriting the map.");

  const body = new FormData();
  body.set("value", JSON.stringify(map));
  body.set("metadata", "{}");

  const put = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
    + "/storage/kv/namespaces/" + KV_ID + "/values/tickers%3Acik",
    { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body }
  );
  if (!put.ok) throw new Error("KV write failed: " + put.status + " " + (await put.text()).slice(0, 200));

  const namesBody = new FormData();
  namesBody.set("value", JSON.stringify(names));
  namesBody.set("metadata", "{}");
  const putNames = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
    + "/storage/kv/namespaces/" + KV_ID + "/values/tickers%3Anames",
    { method: "PUT", headers: { Authorization: "Bearer " + CF_TOKEN }, body: namesBody }
  );
  if (!putNames.ok) throw new Error("KV write failed for names: " + putNames.status + " " + (await putNames.text()).slice(0, 200));

  const line = count + " tickers written to tickers:cik, and " + names.length + " names to tickers:names.";
  console.log(line);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, "## Ticker map\n\n" + line + "\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
