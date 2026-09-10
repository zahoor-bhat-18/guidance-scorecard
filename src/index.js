/**
 * Worker entry point.
 *
 * Static files in ./public are served by Cloudflare directly. Only the routes
 * below reach this code.
 *
 * /api/facts?ticker=M       every XBRL fact this tool can use, for one company
 * /api/releases?ticker=M    the earnings 8-Ks, newest first, no model called
 * /api/guidance?ticker=M    guidance read out of ONE release
 * /api/actuals?ticker=M     guides from the PREVIOUS release, and the figures
 *                           this release reports against them
 * /api/period?ticker=M      the period normaliser, run over the phrasings this
 *                           product has actually met. No model, no cost.
 * /api/text?ticker=M        the release as the extractor sees it. No model.
 * /sec?url=...              host-locked EDGAR proxy, for the browser
 *
 * Nothing is matched, scored or stored yet.
 */

import { proxy, json } from "./sec.js";
import { factsFor, resolveCik, companyCalendar } from "./xbrl.js";
import { earningsReleases, guidanceFrom } from "./guidance.js";
import { requestsFrom, actualsFrom } from "./actuals.js";
import { resolvePeriod } from "./period.js";
import { releaseText } from "./text.js";

/**
 * The period phrasings seen so far, kept as a fixture.
 *
 * Every one of these is real - copied from output this product has already
 * produced for Macy's, Broadcom, Walmart, Delta, United and Honeywell. Keeping
 * them here means the normaliser can be re-checked against the whole set after
 * any change, in one request, without spending a model call.
 *
 * direction matters: an actual reports a period that has ended, a guide
 * describes one that has not, and the same words resolve differently.
 */
const PERIOD_FIXTURES = [
  // From guidance - forward looking.
  { text: "full year 2026", direction: "future" },
  { text: "Fiscal 2026", direction: "future" },
  { text: "full-year 2026", direction: "future" },
  { text: "FY 2026", direction: "future" },
  { text: "FY27", direction: "future" },
  { text: "Q3 FY27", direction: "future" },
  { text: "3Q26", direction: "future" },
  { text: "fourth quarter of fiscal year 2026", direction: "future" },
  { text: "third quarter", direction: "future" },
  { text: "full year", direction: "future" },

  // From actuals - backward looking.
  { text: "13 Weeks Ended May 2, 2026", direction: "past" },
  { text: "first quarter 2026", direction: "past" },
  { text: "three months ended June 30, 2026", direction: "past" },
  { text: "second quarter", direction: "past" },

  // Should all decline, and say why.
  { text: "26 Weeks Ended August 1, 2026", direction: "past" },
  { text: "six months ended June 30, 2026", direction: "past" },
  { text: "second half", direction: "future" },
  { text: "May 2, 2026", direction: "past" },
  { text: "$21.5 billion to $21.75 billion", direction: "future" },
];

export default {
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

        // Grouped by metric and sorted newest first, because the question this
        // answers is "did the periods line up", and a flat list of 400 facts
        // does not answer it.
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
          counts: Object.fromEntries(
            Object.entries(byMetric).map(([k, v]) => [k, v.length])
          ),
          facts: byMetric,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // The release list on its own, so the 8-K filter can be checked without
    // spending a model call. If this returns the wrong filings, nothing built
    // on top of it can be right.
    if (url.pathname === "/api/releases") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);
      try {
        const { cik, name } = await resolveCik(env, ticker);
        const releases = await earningsReleases(env, cik, 12);
        return json({ ticker: ticker.toUpperCase(), company: name, cik, count: releases.length, releases });
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
        const releases = await earningsReleases(env, cik, 12);
        if (!releases.length) throw new Error("No 8-K carrying item 2.02 found for " + ticker + ".");

        const release = wanted
          ? releases.find((r) => r.accession === wanted)
          : releases[0];
        if (!release) throw new Error("Accession " + wanted + " is not among the recent earnings releases.");

        const result = await guidanceFrom(env, cik, release);
        return json({ ticker: ticker.toUpperCase(), company: name, cik, ...result });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * The pairing, end to end, for one pair of releases.
     *
     * Guides are read from the PREVIOUS release, the actuals from the current
     * one. Two model calls, deliberately: guidance extraction already works
     * and asking one call to do both jobs is how the first version of this
     * product ended up slow and wrong.
     *
     * ?accession= picks the current release, ?prior= picks the one it is
     * scored against. Both default to the two most recent, and both are
     * reported back, because "which two filings was this built from" is the
     * first question to ask of any row that looks wrong.
     */
    if (url.pathname === "/api/actuals") {
      const ticker = url.searchParams.get("ticker");
      const wantedCurrent = url.searchParams.get("accession");
      const wantedPrior = url.searchParams.get("prior");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const releases = await earningsReleases(env, cik, 12);
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

        // Step one: what did they say they would do?
        const priorGuidance = await guidanceFrom(env, cik, prior);
        const requests = requestsFrom(priorGuidance.guides);

        // No numeric guide in the previous release means there is nothing to
        // look for, and a second model call would be spent finding nothing.
        if (!requests.length) {
          return json({
            ticker: ticker.toUpperCase(),
            company: name,
            cik,
            current: { accession: current.accession, filed: current.filed },
            prior: priorGuidance.release,
            note: "The previous release carried no numeric guidance, so there is nothing to look for in this one.",
            guides: priorGuidance.guides,
            requested: 0,
            found: 0,
            actuals: [],
          });
        }

        // Step two: what did they actually do?
        const result = await actualsFrom(env, cik, current, requests);

        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          prior: priorGuidance.release,
          guides: priorGuidance.guides,
          ...result,
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * The period normaliser, on its own.
     *
     * Deterministic, so it can be checked exhaustively and for nothing. Every
     * fixture is a phrasing this product has already met in a real release,
     * and each answer says HOW it was reached - because a period that is right
     * for the wrong reason will be wrong on the next company.
     *
     * ?ticker= supplies the fiscal calendar; the labels are only meaningful
     * against a company. ?text= checks one string instead of the fixtures, and
     * ?direction=past|future says whether to read it as an actual or a guide.
     */
    if (url.pathname === "/api/period") {
      const ticker = url.searchParams.get("ticker");
      const text = url.searchParams.get("text");
      const direction = url.searchParams.get("direction") || "past";
      const asOf = url.searchParams.get("asof");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const cal = await companyCalendar(env, cik);

        // Anchored on a real filing date by default, so "third quarter" with no
        // year resolves the way it would in production.
        let referenceDate = asOf;
        if (!referenceDate) {
          const releases = await earningsReleases(env, cik, 1);
          referenceDate = releases.length ? releases[0].filed : null;
        }

        const cases = text
          ? [{ text, direction }]
          : PERIOD_FIXTURES;

        const results = cases.map((c) => {
          const r = resolvePeriod(c.text, cal, {
            referenceDate,
            direction: c.direction,
          });
          return {
            text: c.text,
            direction: c.direction,
            period: r.period,
            how: r.how || null,
            why: r.why || null,
          };
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

    /**
     * The release, as the extractor sees it.
     *
     * No model, no cost. Same fetch, same stripping, same truncation point, so
     * what this shows is what the model was given - which is the only way to
     * tell a company that did not guide from a document we failed to read.
     *
     * ?grep=expect        lines containing a word, case-insensitive
     * ?from=1&to=80       a range of lines when not grepping
     * ?accession=         a specific release; defaults to the most recent
     *
     * Written after a Delta guide reported a number that appears nowhere in
     * the sentence it quoted, and the only way to be certain was to read the
     * filing by hand.
     */
    if (url.pathname === "/api/text") {
      const ticker = url.searchParams.get("ticker");
      const wanted = url.searchParams.get("accession");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const releases = await earningsReleases(env, cik, 12);
        if (!releases.length) throw new Error("No 8-K carrying item 2.02 found for " + ticker + ".");

        const release = wanted
          ? releases.find((r) => r.accession === wanted)
          : releases[0];
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

    return env.ASSETS.fetch(request);
  },
};
