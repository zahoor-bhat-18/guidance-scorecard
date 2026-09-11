/**
 * /sec?url=<encoded EDGAR url>
 *
 * A thin, host-locked proxy to SEC EDGAR. Carried over from the old project
 * unchanged, because it was hard won.
 *
 * Two reasons it exists:
 *   1. EDGAR sends no CORS headers, so the browser cannot call it directly.
 *   2. SEC requires a real contact address in the User-Agent and refuses
 *      requests without one. A browser cannot set User-Agent.
 *
 * Nothing is parsed here. Workers Free allows 10ms of CPU per request, and
 * walking a multi-megabyte inline-XBRL document is far past that.
 */

const ALLOWED_HOSTS = new Set(["www.sec.gov", "data.sec.gov"]);

export async function proxy(request, env) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return json({ error: "Missing url parameter." }, 400);

  let parsed;
  try { parsed = new URL(target); } catch {
    return json({ error: "That url is not a valid address." }, 400);
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return json({ error: "This proxy only reaches sec.gov over https." }, 403);
  }
  if (!env.SEC_USER_AGENT) {
    return json({ error: "SEC_USER_AGENT is not set on the Worker." }, 500);
  }

  const isIndex = /\.json$/i.test(parsed.pathname);

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      // Accept-Encoding is deliberately NOT set. Setting it makes the runtime
      // hand back a body that may still be compressed while the fresh headers
      // below drop the Content-Encoding that would say so. The browser then
      // receives gzip bytes labelled text/html and kills the transfer, which
      // surfaces as "Load failed" with no status code.
      headers: { "User-Agent": env.SEC_USER_AGENT, Accept: "application/json, text/html, */*" },
      cf: isIndex ? { cacheTtl: 86400, cacheEverything: true } : { cacheTtl: 86400 },
    });
  } catch (e) {
    return json({ error: "Could not reach EDGAR: " + e.message }, 502);
  }

  if (!upstream.ok) {
    return json({ error: "EDGAR returned " + upstream.status + " for " + parsed.pathname },
      upstream.status === 404 ? 404 : 502);
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
  // Content-Encoding is deliberately NOT forwarded; the runtime already
  // decompressed the body on our behalf.
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, { status: 200, headers });
}

/** Server-side fetch of an EDGAR JSON document, for use inside the Worker. */
export async function secJson(env, url) {
  const r = await fetch(url, {
    headers: { "User-Agent": env.SEC_USER_AGENT, Accept: "application/json" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!r.ok) throw new Error("EDGAR " + r.status + " for " + url);
  return r.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bytes to text, decided here rather than by the response header.
 *
 * The symptom was quotes and bullets arriving as "Companyâ€™s" and "â€¢", and
 * a cent sign as "Â¢". That is the signature of UTF-8 bytes read through a
 * single-byte decoder: SEC sends many exhibits with a legacy charset declared
 * in the Content-Type, response.text() believes the header, and every
 * non-ASCII character is mangled.
 *
 * It was patched twice at the wrong end - first by decoding more entities,
 * which only exposed more of it, then by rewriting the broken sequences after
 * the fact, which did not fire. The cause is the decoder, so the decoder is
 * what gets fixed.
 *
 * UTF-8 first, because in practice that is what SEC sends whatever the header
 * says. A document that genuinely is single-byte produces replacement
 * characters when read as UTF-8, and a scattering of those is the signal to
 * decode it the other way instead. The threshold is deliberately low: one bad
 * character per two thousand is already far more than a real UTF-8 document
 * produces.
 */
function decodeBody(buffer) {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const bad = (utf8.match(/\uFFFD/g) || []).length;

  if (bad === 0 || bad < utf8.length / 2000) return utf8;

  try {
    return new TextDecoder("windows-1252").decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * Server-side fetch of an EDGAR HTML document.
 *
 * Written after a Delta exhibit read successfully minutes earlier started
 * returning 403 and kept returning it. Two candidates - SEC throttling, or a
 * 403 stored in the edge cache for a day - and no way to tell them apart,
 * because the old code threw the status and discarded the body.
 *
 * SEC says which it is. A throttled request comes back with a page explaining
 * the request-rate threshold; a rejected one explains that the tool is
 * undeclared. That explanation was arriving on every failure and being thrown
 * away, and two rounds were spent guessing at something the server had already
 * answered.
 *
 * The retry handles the other half. The first attempt may be served from
 * cache, and a cached failure does not improve with waiting - in production it
 * would take a company offline for a day. Later attempts bypass the cache, so
 * a stored 403 is stepped over rather than waited out, and the error says
 * whether the bypass ran. Slow retries, because the likeliest cause of a 403
 * is asking too often.
 *
 * It turned out to be the cache, in a single call.
 */
export async function fetchDoc(env, url) {
  if (!env.SEC_USER_AGENT) throw new Error("SEC_USER_AGENT is not set on the Worker.");

  const name = url.split("/").pop();
  let last = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const bypass = attempt > 0;

    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": env.SEC_USER_AGENT, Accept: "text/html, */*" },
        cf: bypass ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 86400 },
      });
    } catch (e) {
      last = new Error("Could not reach EDGAR for " + name + ": " + e.message);
      await sleep(500 * (attempt + 1));
      continue;
    }

    if (res.ok) return decodeBody(await res.arrayBuffer());

    // What EDGAR actually said, tags stripped, first 300 characters.
    let explain = "";
    try {
      explain = (await res.text())
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    } catch {
      explain = "(no body)";
    }

    last = new Error(
      "EDGAR " + res.status + " for " + name
      + (bypass ? " [cache bypassed]" : " [cache allowed]")
      + ": " + (explain || "(empty body)")
    );

    // A missing document will not appear by asking again. Throttling and
    // server errors might.
    const worthRetrying = res.status === 403 || res.status === 429 || res.status >= 500;
    if (!worthRetrying) throw last;

    await sleep(600 * (attempt + 1));
  }

  throw last;
}

export function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
