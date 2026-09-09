/**
 * Worker entry point.
 *
 * Static files in ./public are served by Cloudflare directly. Only the routes
 * below reach this code.
 *
 * /api/facts?ticker=M   every XBRL fact this tool can use, for one company
 * /sec?url=...          host-locked EDGAR proxy, for the browser
 *
 * Nothing here reads a filing or calls a model yet. That is deliberate: the
 * XBRL half has to be proven to line up with how companies label their own
 * quarters before anything is built on top of it.
 */

import { proxy, json } from "./sec.js";
import { factsFor, resolveCik } from "./xbrl.js";

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

    return env.ASSETS.fetch(request);
  },
};
