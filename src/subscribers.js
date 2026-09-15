/**
 * Subscribers.
 *
 * IN KV, NOT IN THE REPOSITORY, and that is the whole reason this repository
 * can be public and its Actions minutes free. The other product keeps its list
 * in a committed JSON file, which is why it must stay private - and why a
 * rebase conflict in that file once produced duplicate briefings and a day of
 * debugging.
 *
 * DOUBLE OPT-IN, always. An address that has not clicked a link in an email
 * sent to it is not a subscriber, it is a claim. Anyone can type anyone's
 * address into a form.
 *
 * Two kinds of key:
 *   pending:<token>   an unconfirmed signup, expiring by itself after 48 hours
 *   subscribers       one key holding every confirmed address and its tickers
 *
 * The confirmed list is ONE key rather than a key per address, because the
 * poller reads it every minute. A key per address would mean a list operation
 * per poll, and the other product went through the KV free tier in a day doing
 * something very like that.
 */

const LIST_KEY = "subscribers";
const PENDING_PREFIX = "pending:";
const PENDING_TTL = 48 * 60 * 60;

/* ------------------------------------------------------------------ *
 * Signing
 * ------------------------------------------------------------------ */

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A link nobody can forge.
 *
 * An unsubscribe link that is only an address in a query string means anyone
 * who guesses an address can remove someone else. The signature is over the
 * address itself, so a link works for exactly one person.
 */
export async function sign(secret, value) {
  if (!secret) throw new Error("UNSUB_SECRET is not set on the Worker.");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToHex(mac).slice(0, 32);
}

/* Compared character by character to the end regardless, so the time taken
   says nothing about how much of the signature was right. */
export async function signatureValid(secret, value, given) {
  const want = await sign(secret, value);
  if (!given || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export function cleanEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  // Deliberately loose. Address syntax is far stranger than most patterns
  // allow, and the confirmation link is what actually proves an address works.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return null;
  if (email.length > 254) return null;
  return email;
}

export function cleanTickers(raw) {
  const list = String(raw || "")
    .toUpperCase()
    .split(/[^A-Z.\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1 && t.length <= 6);
  return Array.from(new Set(list)).slice(0, 25);
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

export async function readList(env) {
  const raw = await env.CACHE.get(LIST_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Refusing is right. Overwriting a list that will not parse would silently
    // unsubscribe everyone on it.
    throw new Error("The subscriber list is not readable JSON. Not touching it.");
  }
}

async function writeList(env, list) {
  await env.CACHE.put(LIST_KEY, JSON.stringify(list));
}

/**
 * A signup, held until the address proves itself.
 *
 * Returns the token for the confirmation link. Nothing is added to the
 * subscriber list here.
 */
export async function hold(env, email, tickers) {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  await env.CACHE.put(
    PENDING_PREFIX + token,
    JSON.stringify({ email, tickers, at: new Date().toISOString() }),
    { expirationTtl: PENDING_TTL }
  );
  return token;
}

/**
 * The click on the link.
 *
 * Tickers are MERGED rather than replaced. Someone who signs up for DAL and
 * later for WMT wants both - the other product overwrote the first list and it
 * was a real bug, not a theoretical one.
 */
export async function confirm(env, token) {
  const raw = await env.CACHE.get(PENDING_PREFIX + token);
  if (!raw) return null;

  const pending = JSON.parse(raw);
  const list = await readList(env);
  const existing = list[pending.email];

  const tickers = Array.from(new Set([...(existing ? existing.tickers : []), ...pending.tickers]));

  list[pending.email] = {
    tickers,
    confirmedAt: existing ? existing.confirmedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await writeList(env, list);
  await env.CACHE.delete(PENDING_PREFIX + token);

  return { email: pending.email, tickers, added: pending.tickers, alreadyHad: existing ? existing.tickers : [] };
}

export async function remove(env, email) {
  const list = await readList(env);
  if (!list[email]) return false;
  delete list[email];
  await writeList(env, list);
  return true;
}

/** Everyone who should get an email about this ticker. */
export async function followersOf(env, ticker) {
  const list = await readList(env);
  const want = String(ticker || "").toUpperCase();
  return Object.entries(list)
    .filter(([, v]) => (v.tickers || []).includes(want))
    .map(([email]) => email);
}

/** Every ticker anyone follows, which is what the poller watches for. */
export async function watchedTickers(env) {
  const list = await readList(env);
  const all = new Set();
  for (const v of Object.values(list)) for (const t of v.tickers || []) all.add(t);
  return Array.from(all);
}

export function confirmUrl(site, token) {
  return site.replace(/\/$/, "") + "/confirm?t=" + encodeURIComponent(token);
}

export async function unsubscribeUrl(env, site, email) {
  const sig = await sign(env.UNSUB_SECRET, email);
  return site.replace(/\/$/, "") + "/unsubscribe?e=" + encodeURIComponent(email) + "&s=" + sig;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

export async function send(env, { to, subject, html, text, unsubscribeUrl: unsub }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set on the Worker.");

  const headers = {};
  // List-Unsubscribe WITHOUT List-Unsubscribe-Post, deliberately. With the
  // Post header the mail client removes the address silently on its own; the
  // other product chose the same, so the control opens a page that says which
  // address is going and what it was following.
  if (unsub) headers["List-Unsubscribe"] = "<" + unsub + ">";

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.RESEND_API_KEY,
    },
    body: JSON.stringify({
      from: "Guidance Scorecard <" + (env.EMAIL_FROM || "guidance@zahoorbhat.com") + ">",
      // Replies go to the address that already routes to a real inbox.
      //
      // Cloudflare Email Routing needs a rule per address and a verified
      // destination for each, and hello@ already has both. Sending from
      // guidance@ and replying to hello@ needs no new routing at all - and it
      // fixes the same silent hole in the other product, where a reply to
      // filings@ goes nowhere and nobody finds out.
      //
      // A research product where replies vanish is a bad look, and replies are
      // also what builds sending reputation fastest.
      reply_to: [env.REPLY_TO || "hello@zahoorbhat.com"],
      to: [to],
      subject,
      html,
      text,
      headers,
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error("Resend returned " + r.status + ": " + body.slice(0, 300));
  }
  return r.json();
}

/**
 * The confirmation email.
 *
 * Short, and it says what was asked for. An email that only says "click here"
 * gives someone whose address was typed in by a stranger nothing to judge.
 */
export function confirmationEmail(tickers, link, postal) {
  const list = tickers.join(", ");

  const text = [
    "Someone asked to follow " + list + " on the Guidance Scorecard using this address.",
    "",
    "If that was you, confirm here:",
    link,
    "",
    "You will get one email per company per quarter, when it reports: how its guidance",
    "has compared to what it delivered, and what it has just guided for next.",
    "",
    "If it was not you, ignore this. Nothing is stored until the link is clicked, and",
    "this one expires in 48 hours.",
    "",
    "Questions: just reply, or write to hello@zahoorbhat.com.",
    postal ? "\n" + postal : "",
  ].join("\n");

  const html = [
    '<div style="background:#F1F0EA;padding:26px 0;">',
    '<div style="max-width:520px;margin:0 auto;padding:0 20px;font-family:Georgia,serif;color:#16281F;font-size:16px;line-height:1.6;">',
    '<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#5B7166;">Guidance Scorecard</div>',
    '<p style="margin:18px 0 0;">Someone asked to follow <b>' + list + '</b> using this address.</p>',
    '<p style="margin:18px 0 0;"><a href="' + link + '" style="background:#16281F;color:#F1F0EA;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;">Confirm</a></p>',
    '<p style="margin:20px 0 0;color:#3E5248;font-size:15px;">You will get one email per company per quarter, when it reports: how its guidance has compared to what it delivered, and what it has just guided for next.</p>',
    '<p style="margin:18px 0 0;color:#5B7166;font-size:13px;">If it was not you, ignore this. Nothing is stored until the link is clicked, and this one expires in 48 hours.</p>',
    '<p style="margin:18px 0 0;color:#5B7166;font-size:13px;">Questions: just reply, or write to <a href="mailto:hello@zahoorbhat.com" style="color:#5B7166;">hello@zahoorbhat.com</a>.</p>',
    postal ? '<p style="margin:16px 0 0;color:#5B7166;font-size:12px;">' + postal + '</p>' : "",
    "</div></div>",
  ].join("\n");

  return { subject: "Confirm: " + list + " on the Guidance Scorecard", html, text };
}

/* A page, not JSON. These links are clicked in a mail client. */
export function page(title, body) {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + "<title>" + title + "</title>"
    + '<style>body{background:#F1F0EA;color:#16281F;font-family:system-ui,-apple-system,sans-serif;'
    + "margin:0;padding:15vh 24px;line-height:1.6}main{max-width:460px;margin:0 auto}"
    + "h1{font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 12px}"
    + "p{color:#3E5248}a{color:#1F8A5C}"
    + "button{font-family:inherit;font-size:15px;padding:12px 22px;background:#16281F;color:#F1F0EA;"
    + "border:0;border-radius:8px;cursor:pointer}</style></head><body><main>"
    + body + "</main></body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}
