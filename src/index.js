/**
 * Worker entry point.
 *
 * Static files in ./public are served by Cloudflare directly. Only the routes
 * below reach this code.
 *
 * /api/facts?ticker=M       every XBRL fact this tool can use, for one company
 * /api/releases?ticker=M    the earnings 8-Ks, newest first, no model called
 * /api/guidance?ticker=M    guidance read out of ONE release
 * /api/actuals?ticker=M     the pairing: guides from the PREVIOUS release, and
 *                           the figures this release reports against them
 * /sec?url=...              host-locked EDGAR proxy, for the browser
 *
 * /api/actuals is the shape the product runs on. A release carries the result
 * for the period ending and the guide for the period starting, so scoring one
 * release against the one before it needs nothing else - which is what lets
 * the email go out when the 8-K lands rather than weeks later when the 10-Q
 * is filed.
 *
 * Nothing is matched, scored or stored yet.
 */

import { proxy, json } from "./sec.js";
import { factsFor, resolveCik } from "./xbrl.js";
import { earningsReleases, guidanceFrom } from "./guidance.js";
import { requestsFrom, actualsFrom } from "./actuals.js";

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

    return env.ASSETS.fetch(request);
  },
};
