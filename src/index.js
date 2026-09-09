/**
 * Worker entry point.
 *
 * Static files in ./public are served by Cloudflare directly. Only the routes
 * below reach this code.
 *
 * /api/facts?ticker=M       every XBRL fact this tool can use, for one company
 * /api/releases?ticker=M    the earnings 8-Ks, newest first, no model called
 * /api/guidance?ticker=M    guidance read out of ONE release
 * /sec?url=...              host-locked EDGAR proxy, for the browser
 *
 * /api/guidance reads the most recent release by default. Pass &accession= to
 * read an older one - which is how the eight-quarter history gets checked by
 * hand before anything automates it.
 *
 * Nothing is matched, scored or stored yet. Extraction has to be shown to work
 * on one release before a pipeline is built on top of it.
 */

import { proxy, json } from "./sec.js";
import { factsFor, resolveCik } from "./xbrl.js";
import { earningsReleases, guidanceFrom } from "./guidance.js";

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

    return env.ASSETS.fetch(request);
  },
};
