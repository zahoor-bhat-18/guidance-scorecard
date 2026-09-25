/**
 * Worker entry point.
 *
 * /api/facts?ticker=M       every XBRL fact this tool can use, for one company
 * /api/releases?ticker=M    the earnings 8-Ks, newest first, no model called
 * /api/guidance?ticker=M    guidance read out of ONE release
 * /api/actuals?ticker=M     guides from the PREVIOUS release, the figures this
 *                           release reports against them, and which of those
 *                           pairs refer to the same period
 * /api/period?ticker=M      the period normaliser, over phrasings this product
 *                           has actually met. No model, no cost.
 * /api/text?ticker=M        the release as the extractor sees it. No model.
 * /api/records              every stored record, and when each was built
 * /api/record?ticker=M      one stored record, as a subscriber would see it
 * /api/preview?ticker=M     the email itself, rendered. Nothing is sent.
 * /api/signup               POST an address and tickers; sends a confirmation link
 * /confirm?t=               the click that actually subscribes someone
 * /unsubscribe?e=&s=        a signed link, confirmed on a page before removing
 * /__health?key=             what the Worker can see, for when it goes quiet
 * /api/check?tickers=M,WMT  the whole battery across several companies at once
 * /sec?url=...              host-locked EDGAR proxy, for the browser
 *
 * Nothing is scored or stored yet.
 */

import { proxy, json } from "./sec.js";
import { factsFor, resolveCik, companyCalendar } from "./xbrl.js";
import { earningsReleases, guidanceFrom, readFiling, refineCalendar } from "./guidance.js";
import { requestsFrom, actualsFrom } from "./actuals.js";
import { resolvePeriod, samePeriod } from "./period.js";
import { scoreAll } from "./score.js";
import { pairUp } from "./pairing.js";
import { revisionsBetween } from "./revisions.js";
import { releaseText } from "./text.js";
import { readRecord, listRecords, forEmail, headline } from "./records.js";
import { renderEmail } from "./email.js";
import {
  cleanEmail, cleanTickers, hold, confirm, remove, readList, watchedTickers,
  confirmUrl, unsubscribeUrl, send, confirmationEmail, signatureValid, page,
} from "./subscribers.js";

/**
 * Period phrasings seen so far, kept as a fixture.
 *
 * Every one is real, copied from output this product has produced for Macy's,
 * Broadcom, Walmart, Delta, United and Honeywell. Keeping them here means the
 * normaliser can be re-checked against the whole set after any change, in one
 * request, without spending a model call.
 */
const PERIOD_FIXTURES = [
  { text: "full year 2026", direction: "future" },
  { text: "Fiscal 2026", direction: "future" },
  { text: "FY27", direction: "future" },
  { text: "Q3 FY27", direction: "future" },
  { text: "3Q26", direction: "future" },
  { text: "fourth quarter of fiscal year 2026", direction: "future" },
  { text: "third quarter", direction: "future" },
  { text: "full year", direction: "future" },
  { text: "second quarter fiscal 2027", direction: "future" },
  { text: "the June quarter", direction: "future" },

  { text: "13 Weeks Ended May 2, 2026", direction: "past" },
  { text: "first quarter 2026", direction: "past" },
  { text: "three months ended June 30, 2026", direction: "past" },
  { text: "second quarter", direction: "past" },
  { text: "Three Months Ended July 31, 2026", direction: "past" },
  { text: "June quarter 2026", direction: "past" },
  { text: "March quarter", direction: "past" },

  // Should all decline, and say why.
  { text: "26 Weeks Ended August 1, 2026", direction: "past" },
  { text: "six months ended June 30, 2026", direction: "past" },
  { text: "second half", direction: "future" },
  { text: "May 2, 2026", direction: "past" },
  { text: "$21.5 billion to $21.75 billion", direction: "future" },
];

/* pairUp lives in src/pairing.js and is imported. This file carried its own
   copy, matching a guide to an actual by name alone, and every pairing fix
   made in the shared file stopped at the boundary. One definition. */

/** One company, end to end, reduced to what is worth reading. */
async function checkOne(env, ticker, full) {
  const { cik, name } = await resolveCik(env, ticker);
  const releases = await earningsReleases(env, cik, 12);
  if (releases.length < 2) {
    return { ticker, company: name, error: "Fewer than two earnings releases found." };
  }

  const current = releases[0];
  const prior = releases[1];

  const startingCalendar = await companyCalendar(env, cik);

  // Free part: which exhibits, which convention, and whether the text is clean.
  const filing = await readFiling(env, cik, current.accession);
  const calendar = refineCalendar(startingCalendar, filing.text);
  const mojibake = /[\u00C2\u00C3][\u0080-\u00BF\u2019\u201C\u201D\u2022\u2014\u2122]/.test(filing.text);

  const summary = {
    ticker,
    company: name,
    fiscalYearEnd: calendar.meta.fiscalYearEnd,
    convention: calendar.meta.labelConvention,
    conventionFrom: calendar.meta.conventionFrom,
    conventionChangedByText: Boolean(calendar.meta.conventionWas),
    exhibitsRead: filing.files.map((f) => f.file),
    textChars: filing.chars,
    mojibakeDetected: mojibake,
    releases: releases.length,
    mergedAsOneEvent: (releases.mergedFilings || []).length,
  };

  if (!full) return summary;

  const priorGuidance = await guidanceFrom(env, cik, prior, startingCalendar);
  // The calendar goes with the guides, as it does in the backfill and the live
  // send. Without it the request never learns that Delta calls its second
  // quarter the June quarter, and this diagnostic shows a request the backfill
  // no longer sends - which is worse than no diagnostic.
  const requests = requestsFrom(priorGuidance.guides, calendar);

  if (!requests.length) {
    const onlyNew = await guidanceFrom(env, cik, current, calendar);
    const firstMoved = revisionsBetween(priorGuidance.guides, onlyNew.guides);
    return {
      ...summary,
      guides: priorGuidance.guides.length,
      requested: 0,
      comparable: 0,
      rejections: {},
      moved: firstMoved.tally,
      revisions: firstMoved.revisions.map((r) => r.summary),
    };
  }

  const result = await actualsFrom(env, cik, current, requests, priorGuidance.calendar || calendar);
  const scored = scoreAll(pairUp(priorGuidance.guides, result.actuals));
  const pairs = scored.pairs;

  const currentGuidance = await guidanceFrom(env, cik, current, priorGuidance.calendar || calendar);
  const moved = revisionsBetween(priorGuidance.guides, currentGuidance.guides, {
    reportedPeriods: result.actuals.map((a) => a.period).filter(Boolean),
  });

  const rejections = {};
  for (const p of pairs) {
    if (p.comparable) continue;
    const reason = String(p.why || "unknown").replace(/\b20\d\d(FY|Q[1-4])\b/g, "<period>");
    rejections[reason] = (rejections[reason] || 0) + 1;
  }

  return {
    ...summary,
    guides: priorGuidance.guides.length,
    guarded: priorGuidance.guarded,
    unresolvedGuidePeriods: priorGuidance.unresolvedPeriods,
    requested: result.requested,
    found: result.found,
    basisMismatches: result.basisMismatches,
    comparable: pairs.filter((p) => p.comparable).length,
    landed: scored.tally,
    rejections,
    comparablePairs: pairs.filter((p) => p.comparable).map((p) => ({
      metric: p.metric_as_written,
      period: p.guide_period,
      guide: p.guide,
      actual: p.actual,
      unit: p.unit,
      position: p.score ? p.score.position : null,
      summary: p.score ? p.score.summary : null,
    })),
    moved: moved.tally,
    revisions: moved.revisions.map((r) => r.summary),
  };
}

/**
 * The poll.
 *
 * EDGAR's "current filings" feed, every minute, filtered to 8-Ks. Anything
 * from a ticker somebody follows fires a repository_dispatch, and GitHub
 * Actions does the reading and sending - the same split as the other product,
 * because the Worker cannot do twenty model calls and Actions cannot poll
 * every minute for free.
 *
 * A filing stays in the feed for hours, so each accession is remembered for an
 * hour after dispatch. Without that guard the other product billed a full
 * minute of Actions every minute to rediscover nothing.
 */
async function poll(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;

  const watching = await watchedTickers(env);
  if (!watching.length) return;

  const feed = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K"
    + "&company=&dateb=&owner=include&count=100&output=atom&t=" + Date.now();

  const r = await fetch(feed, {
    headers: { "User-Agent": env.SEC_USER_AGENT, Accept: "application/atom+xml" },
    cf: { cacheTtl: 0 },
  });
  if (!r.ok) return;

  const xml = await r.text();

  // Map the tickers being watched to the CIKs the feed carries.
  const tickers = await env.CACHE.get("tickers:cik", "json");
  if (!tickers) return;

  const wanted = new Map();
  for (const t of watching) if (tickers[t]) wanted.set(String(Number(tickers[t])), t);

  const hits = new Set();
  for (const m of xml.matchAll(/CIK=(\d+)/g)) {
    const t = wanted.get(String(Number(m[1])));
    if (t) hits.add(t);
  }
  if (!hits.size) return;

  const fresh = [];
  for (const ticker of hits) {
    const seen = await env.CACHE.get("dispatched:" + ticker);
    if (seen) continue;
    await env.CACHE.put("dispatched:" + ticker, "1", { expirationTtl: 3600 });
    fresh.push(ticker);
  }
  if (!fresh.length) return;

  await fetch("https://api.github.com/repos/" + env.GITHUB_REPO + "/dispatches", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "guidance-scorecard",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "earnings-release", client_payload: { tickers: fresh.join(",") } }),
  });

  await env.CACHE.put("poll:last", new Date().toISOString() + " dispatched " + fresh.join(","));
}

/* ------------------------------------------------------------------
 * New companies on request
 *
 * Someone signs up for a ticker nobody has asked for before. Once they
 * confirm, the backfill is started for it in GitHub Actions, and when it
 * finishes scripts/notify.mjs tells everyone following it whether the company
 * puts enough numeric guidance in its releases to score.
 *
 * Started on CONFIRMATION, not signup, so a typo or a bot costs nothing.
 * Capped, because each new company costs model calls: five tickers per
 * signup, ten new companies a day across everyone.
 * ------------------------------------------------------------------ */

const MAX_TICKERS_PER_SIGNUP = 5;
const NEW_COMPANIES_PER_DAY = 10;
// How long a request blocks another for the same ticker. Long enough to
// cover a backfill that is queued or running; a finished one leaves a record,
// and a ticker with a record is never requested again.
const REQUEST_HOLD = 6 * 60 * 60;

async function requestBackfill(env, tickers) {
  const out = { started: [], alreadyUnderway: [], overLimit: [], failed: [] };
  if (!tickers.length) return out;

  const day = "backfills:" + new Date().toISOString().slice(0, 10);
  const used = parseInt((await env.CACHE.get(day)) || "0", 10) || 0;

  const go = [];
  for (const t of tickers) {
    if (await env.CACHE.get("requested:" + t)) out.alreadyUnderway.push(t);
    else if (used + go.length >= NEW_COMPANIES_PER_DAY) out.overLimit.push(t);
    else go.push(t);
  }
  if (!go.length) return out;

  const r = await fetch("https://api.github.com/repos/" + env.GITHUB_REPO + "/dispatches", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "guidance-scorecard",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "backfill-request", client_payload: { tickers: go.join(",") } }),
  });

  if (!r.ok) {
    out.failed = go;
    return out;
  }

  for (const t of go) await env.CACHE.put("requested:" + t, new Date().toISOString(), { expirationTtl: REQUEST_HOLD });
  await env.CACHE.put(day, String(used + go.length), { expirationTtl: 2 * 24 * 60 * 60 });
  out.started = go;
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/sec") {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      return proxy(request, env);
    }

    if (url.pathname === "/api/facts") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);
      try {
        const { cik, name } = await resolveCik(env, ticker);
        const { facts, meta } = await factsFor(env, cik);

        const byMetric = {};
        for (const rec of Object.values(facts)) {
          (byMetric[rec.metric] = byMetric[rec.metric] || []).push(rec);
        }
        for (const list of Object.values(byMetric)) {
          list.sort((a, b) => (a.period < b.period ? 1 : -1));
        }

        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          meta,
          metrics: Object.keys(byMetric).sort(),
          counts: Object.fromEntries(Object.entries(byMetric).map(([k, v]) => [k, v.length])),
          facts: byMetric,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (url.pathname === "/api/releases") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);
      try {
        const { cik, name } = await resolveCik(env, ticker);
        const releases = await earningsReleases(env, cik, 12);
        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          count: releases.length,
          mergedAsOneEvent: releases.mergedFilings || [],
          releases,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (url.pathname === "/api/guidance") {
      const ticker = url.searchParams.get("ticker");
      const wanted = url.searchParams.get("accession");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);
      try {
        const { cik, name } = await resolveCik(env, ticker);
        const [releases, cal] = await Promise.all([
          earningsReleases(env, cik, 12),
          companyCalendar(env, cik),
        ]);
        if (!releases.length) throw new Error("No 8-K carrying item 2.02 found for " + ticker + ".");

        const release = wanted ? releases.find((r) => r.accession === wanted) : releases[0];
        if (!release) throw new Error("Accession " + wanted + " is not among the recent earnings releases.");

        const result = await guidanceFrom(env, cik, release, cal);
        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          calendar: (result.calendar || cal).meta,
          ...result,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (url.pathname === "/api/actuals") {
      const ticker = url.searchParams.get("ticker");
      const wantedCurrent = url.searchParams.get("accession");
      const wantedPrior = url.searchParams.get("prior");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const [releases, startingCalendar] = await Promise.all([
          earningsReleases(env, cik, 12),
          companyCalendar(env, cik),
        ]);
        if (releases.length < 2) {
          throw new Error("Fewer than two earnings releases found for " + ticker + ", so there is nothing to pair.");
        }

        const currentIndex = wantedCurrent
          ? releases.findIndex((r) => r.accession === wantedCurrent)
          : 0;
        if (currentIndex < 0) {
          throw new Error("Accession " + wantedCurrent + " is not among the recent earnings releases.");
        }

        let prior;
        if (wantedPrior) {
          prior = releases.find((r) => r.accession === wantedPrior);
          if (!prior) throw new Error("Prior accession " + wantedPrior + " is not among the recent earnings releases.");
        } else {
          prior = releases[currentIndex + 1];
          if (!prior) throw new Error("No earlier release to score against.");
        }

        const current = releases[currentIndex];

        // Step one: what did they say they would do? This also settles the
        // fiscal convention from the release text, and the settled calendar is
        // what step two uses - both sides must label periods the same way.
        const priorGuidance = await guidanceFrom(env, cik, prior, startingCalendar);
        const calendar = priorGuidance.calendar || startingCalendar;
        const requests = requestsFrom(priorGuidance.guides, calendar);

        if (!requests.length) {
          return json({
            ticker: ticker.toUpperCase(),
            company: name,
            cik,
            calendar: calendar.meta,
            current: { accession: current.accession, filed: current.filed },
            prior: priorGuidance.release,
            note: "The previous release carried no numeric guidance, so there is nothing to look for in this one.",
            guides: priorGuidance.guides,
            requested: 0,
            found: 0,
            pairs: [],
            actuals: [],
          });
        }

        // Step two: what did they actually do?
        //
        // ?model=gemini reads this one release with Gemini instead of the
        // default, and changes nothing else - no setting, no stored record. It
        // exists so two models can be compared on the same filing, which is
        // the only comparison worth making.
        const modelParam = String(url.searchParams.get("model") || "").toLowerCase();
        const runEnv = modelParam ? { ...env, ACTUALS_MODEL: modelParam } : env;
        const result = await actualsFrom(runEnv, cik, current, requests, calendar);
        const scored = scoreAll(pairUp(priorGuidance.guides, result.actuals));
        const pairs = scored.pairs;

        // The current release's own guidance, which the live engine needs
        // anyway - the email carries what they guided next - and which is what
        // makes the revision path possible. For a full-year guider this is the
        // only finding available for three quarters out of four.
        const currentGuidance = await guidanceFrom(env, cik, current, calendar);
        const moved = revisionsBetween(priorGuidance.guides, currentGuidance.guides, {
          reportedPeriods: result.actuals.map((a) => a.period).filter(Boolean),
        });

        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          calendar: calendar.meta,
          prior: priorGuidance.release,
          guides: priorGuidance.guides,
          newGuides: currentGuidance.guides,
          comparable: pairs.filter((p) => p.comparable).length,
          notComparable: pairs.filter((p) => !p.comparable).length,
          landed: scored.tally,
          moved: moved.tally,
          revisions: moved.revisions,
          pairs,
          ...result,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (url.pathname === "/api/period") {
      const ticker = url.searchParams.get("ticker");
      const text = url.searchParams.get("text");
      const direction = url.searchParams.get("direction") || "past";
      const asOf = url.searchParams.get("asof");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const startingCalendar = await companyCalendar(env, cik);
        const releases = await earningsReleases(env, cik, 1);
        const referenceDate = asOf || (releases.length ? releases[0].filed : null);

        // The convention is settled against the latest release, the same way
        // the extractors settle it, so this reports what they would use.
        let cal = startingCalendar;
        if (releases.length) {
          const filing = await readFiling(env, cik, releases[0].accession);
          cal = refineCalendar(startingCalendar, filing.text);
        }

        const cases = text ? [{ text, direction }] : PERIOD_FIXTURES;
        const results = cases.map((c) => {
          const r = resolvePeriod(c.text, cal, { referenceDate, direction: c.direction });
          return { text: c.text, direction: c.direction, period: r.period, how: r.how || null, why: r.why || null };
        });

        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          calendar: cal.meta,
          referenceDate,
          resolved: results.filter((r) => r.period).length,
          declined: results.filter((r) => !r.period).length,
          results,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (url.pathname === "/api/text") {
      const ticker = url.searchParams.get("ticker");
      const wanted = url.searchParams.get("accession");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const releases = await earningsReleases(env, cik, 12);
        if (!releases.length) throw new Error("No 8-K carrying item 2.02 found for " + ticker + ".");

        const release = wanted ? releases.find((r) => r.accession === wanted) : releases[0];
        if (!release) throw new Error("Accession " + wanted + " is not among the recent earnings releases.");

        const result = await releaseText(env, cik, release.accession, {
          grep: url.searchParams.get("grep"),
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
        });

        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          release: { accession: release.accession, filed: release.filed, items: release.items },
          ...result,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * Several companies, one request.
     *
     * Built because each round of fixing was costing six separate URLs and six
     * pastes, and a round that only covers three companies hides whatever the
     * other three would have shown.
     *
     * Free by default: exhibits, fiscal convention, encoding. Add &full=1 to
     * run the extractions too - two model calls per company, so keep the list
     * short. Rejection reasons are grouped with the period labels removed, so
     * ten different pairs failing for one reason read as one line.
     */
    if (url.pathname === "/api/check") {
      const list = String(url.searchParams.get("tickers") || "")
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 6);

      if (!list.length) return json({ error: "Add ?tickers=M,WMT,AVGO" }, 400);

      const full = url.searchParams.get("full") === "1";
      const results = [];

      for (const ticker of list) {
        try {
          results.push(await checkOne(env, ticker, full));
        } catch (e) {
          results.push({ ticker, error: e.message });
        }
      }

      return json({
        checked: results.length,
        mode: full ? "full - extractions run, two model calls per company" : "free - no model calls",
        results,
      });
    }

    /**
     * What has been stored, and when.
     *
     * The first thing to check after a backfill. A KV upload that silently did
     * nothing looks exactly like one that worked, and that question has cost
     * hours on the other product.
     */
    /**
     * The last backfill's summary, as plain text.
     *
     * Copying the job summary off a phone screen took several messages a run,
     * and the "Copy the whole summary" button did not work there. The backfill
     * now stores the same text in KV; this returns it, with a no-store header
     * so nothing in between serves yesterday's run. Nothing private in it:
     * company names, pair counts and the scored lines the emails show anyway.
     */
    /**
     * Every SEC ticker with its company name, for search-as-you-type on the
     * signup form. Read once per visitor and filtered in the browser, so typing
     * costs nothing. Written monthly by scripts/tickers.mjs.
     */
    if (url.pathname === "/api/tickers") {
      const list = await env.CACHE.get("tickers:names", { cacheTtl: 3600 });
      return new Response(list || "[]", {
        status: list ? 200 : 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": list ? "public, max-age=86400" : "no-store",
        },
      });
    }

    if (url.pathname === "/api/summary") {
      const text = await env.CACHE.get("summary:latest");
      return new Response(text || "No summary stored yet. Run the backfill once.", {
        status: text ? 200 : 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/records") {
      try {
        return json(await listRecords(env));
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * One company's record, as a subscriber would see it.
     *
     * A single KV read. Nothing is extracted, nothing is scored, no filing is
     * fetched - all of that happened in Actions, which is the whole reason the
     * old version's five-minute wait is gone.
     *
     * ?full=1 returns the stored record untouched, including the pairs held
     * back for review and the reasons every refused pair was refused. That is
     * the version for looking into something, not the version to send.
     */
    if (url.pathname === "/api/record") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const record = await readRecord(env, ticker);
        if (!record) {
          return json({
            error: "No record stored for " + ticker.toUpperCase() + "."
              + " Run the backfill workflow for it.",
          }, 404);
        }

        if (url.searchParams.get("full") === "1") return json(record);

        const shown = forEmail(record);
        return json({ ...shown, headline: headline(shown.landed) });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * The email, rendered but not sent.
     *
     * Opens in a browser as the subscriber would see it. &format=text returns
     * the plain-text half, which is what most mail clients on a phone will
     * actually show and is the version worth reading critically.
     *
     * Nothing is sent from here and no address is involved. Sending waits
     * until this has been read and judged right.
     */
    if (url.pathname === "/api/preview") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const record = await readRecord(env, ticker);
        if (!record) {
          return json({ error: "No record stored for " + ticker.toUpperCase() + "." }, 404);
        }

        const shown = forEmail(record);
        const mail = renderEmail(
          { ...shown, headline: headline(shown.landed) },
          { unsubscribeUrl: "https://example.invalid/unsubscribe", postalAddress: env.POSTAL_ADDRESS }
        );

        if (url.searchParams.get("format") === "text") {
          return new Response(mail.subject + "\n\n" + mail.text, {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        if (url.searchParams.get("format") === "json") {
          return json(mail);
        }

        return new Response(mail.html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * Signing up.
     *
     * Nothing is stored against the address here beyond a pending record that
     * expires by itself in 48 hours. An address that has not clicked a link
     * sent to it is a claim, not a subscriber - anyone can type anyone's
     * address into a form.
     *
     * Tickers with no published record are NAMED BACK rather than quietly
     * accepted. The other product does the same for foreign filers, and it was
     * the right call: silently taking an address and never sending anything is
     * worse than saying no.
     */
    if (url.pathname === "/api/signup") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);

      try {
        const body = await request.json().catch(() => ({}));
        const email = cleanEmail(body.email);
        if (!email) return json({ error: "That does not look like an email address." }, 400);

        const asked = cleanTickers(body.tickers);
        if (!asked.length) return json({ error: "Name at least one ticker." }, 400);
        if (asked.length > MAX_TICKERS_PER_SIGNUP) {
          return json({ error: "Up to " + MAX_TICKERS_PER_SIGNUP + " tickers at a time." }, 400);
        }

        // Any company registered with the SEC can be followed. One without a
        // record is built after the address is confirmed.
        const secTickers = (await env.CACHE.get("tickers:cik", "json")) || {};
        const known = asked.filter((t) => secTickers[t]);
        const unknown = asked.filter((t) => !secTickers[t]);

        if (!known.length) {
          return json({ error: "EDGAR has no company under " + unknown.join(", ") + "." }, 400);
        }

        const token = await hold(env, email, known);
        const site = env.SITE_URL || url.origin;
        const mail = confirmationEmail(known, confirmUrl(site, token), env.POSTAL_ADDRESS);

        await send(env, { to: email, ...mail });

        return json({
          ok: true,
          following: known,
          notCovered: unknown,
          message: unknown.length
            ? "Check your inbox. EDGAR has no company under " + unknown.join(", ") + "."
            : "Check your inbox and click the link to confirm.",
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /* The click that actually subscribes someone. */
    if (url.pathname === "/confirm") {
      const token = url.searchParams.get("t");
      if (!token) return page("Confirm", "<h1>Something is missing</h1><p>That link is incomplete.</p>");

      try {
        const done = await confirm(env, token);
        if (!done) {
          return page("Confirm",
            "<h1>That link has expired</h1><p>Confirmation links last 48 hours. "
            + '<a href="' + (env.SITE_URL || "/") + '">Sign up again</a> and we will send a fresh one.</p>');
        }

        const newly = done.added.filter((t) => !done.alreadyHad.includes(t));

        // Where each ticker in THIS signup stands - not only the new ones.
        // Someone told "today's limit is reached, sign up again tomorrow" is
        // already following the ticker when they come back, and still needs
        // the backfill started.
        const stored = await listRecords(env);
        const recorded = new Map((stored.records || []).map((r) => [r.ticker, r]));
        const covered = done.added.filter((t) => recorded.has(t) && recorded.get(t).publishable);
        const thin = done.added.filter((t) => recorded.has(t) && !recorded.get(t).publishable);
        const fresh = done.added.filter((t) => !recorded.has(t));
        const req = await requestBackfill(env, fresh);

        const para = (text) => "<p>" + text + "</p>";
        const names = (list) => "<b>" + list.join(", ") + "</b>";

        return page("Confirmed",
          "<h1>Confirmed</h1><p>You are following " + names(done.tickers) + ".</p>"
          + (newly.length !== done.added.length
              ? para("You were already following " + done.added.filter((t) => done.alreadyHad.includes(t)).join(", ") + ".")
              : "")
          + (covered.length
              ? para(names(covered) + ": covered. An email arrives when " + (covered.length > 1 ? "each" : "it") + " next reports.")
              : "")
          + (req.started.length
              ? para(names(req.started) + ": new here, so we are reading "
                + (req.started.length > 1 ? "their" : "its") + " last fourteen earnings releases now. Within about"
                + " fifteen minutes you will get an email saying whether there is guidance to score.")
              : "")
          + (req.alreadyUnderway.length
              ? para(names(req.alreadyUnderway) + ": already being set up. You will get the same email when it is done.")
              : "")
          + (thin.length
              ? para(names(thin) + ": on your list, but "
                + (thin.length > 1 ? "their" : "its") + " earnings releases carry too little numeric guidance to"
                + " score. You will only hear from us if that changes.")
              : "")
          + (req.overLimit.length
              ? para(names(req.overLimit) + ": today's limit for new companies is reached. Sign up for "
                + (req.overLimit.length > 1 ? "them" : "it") + " again tomorrow and we will set "
                + (req.overLimit.length > 1 ? "them" : "it") + " up then.")
              : "")
          + (req.failed.length
              ? para(names(req.failed) + ": we could not start the setup just now. Sign up again in a few"
                + " minutes, or write to hello@zahoorbhat.com.")
              : "")
          + para("Every email carries a link to leave."));
      } catch (e) {
        return page("Confirm", "<h1>That did not work</h1><p>" + e.message + "</p>");
      }
    }

    /**
     * Leaving.
     *
     * The link is signed, so it works for one address and cannot be guessed.
     * The GET shows a page naming the address and what it follows; the POST
     * does the removing. A one-click GET that removes on sight gets triggered
     * by link scanners and mail previewers, and the subscriber never knows.
     */
    if (url.pathname === "/unsubscribe") {
      const email = String(url.searchParams.get("e") || "").toLowerCase();
      const sig = url.searchParams.get("s");

      try {
        if (!email || !(await signatureValid(env.UNSUB_SECRET, email, sig))) {
          return page("Unsubscribe", "<h1>That link is not valid</h1><p>Use the link in a recent email.</p>");
        }

        if (request.method === "POST") {
          const gone = await remove(env, email);
          return page("Unsubscribed",
            gone
              ? "<h1>Removed</h1><p>Nothing further will be sent to " + email + ".</p>"
              : "<h1>Already gone</h1><p>" + email + " was not on the list.</p>");
        }

        const list = await readList(env);
        const record = list[email];
        if (!record) {
          return page("Unsubscribe", "<h1>Already gone</h1><p>" + email + " is not on the list.</p>");
        }

        return page("Unsubscribe",
          "<h1>Leave the Guidance Scorecard?</h1>"
          + "<p>This removes <b>" + email + "</b>, which follows "
          + record.tickers.join(", ") + ".</p>"
          + '<form method="POST"><button type="submit">Unsubscribe</button></form>');
      } catch (e) {
        return page("Unsubscribe", "<h1>That did not work</h1><p>" + e.message + "</p>");
      }
    }

    /**
     * What the Worker can see.
     *
     * Behind the poll key. On the other product an endpoint reporting which
     * variables were visible ended an hour of guesswork in five seconds, and
     * it is the single cheapest thing in either codebase.
     */
    if (url.pathname === "/__health") {
      if (!env.POLL_KEY || url.searchParams.get("key") !== env.POLL_KEY) {
        return json({ error: "No." }, 403);
      }
      let subscribers = 0, watching = [];
      try {
        subscribers = Object.keys(await readList(env)).length;
        watching = await watchedTickers(env);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
      return json({
        ok: true,
        now: new Date().toISOString(),
        sees: {
          CACHE: Boolean(env.CACHE),
          DEEPSEEK_API_KEY: Boolean(env.DEEPSEEK_API_KEY),
          RESEND_API_KEY: Boolean(env.RESEND_API_KEY),
          UNSUB_SECRET: Boolean(env.UNSUB_SECRET),
          GITHUB_TOKEN: Boolean(env.GITHUB_TOKEN),
          POLL_KEY: true,
          GITHUB_REPO: env.GITHUB_REPO || null,
          SITE_URL: env.SITE_URL || null,
        },
        subscribers,
        watching,
        lastDispatch: await env.CACHE.get("poll:last"),
      });
    }

    return env.ASSETS.fetch(request);
  },
};
