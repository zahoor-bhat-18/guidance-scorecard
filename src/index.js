/**
 * Worker entry point.
 *
 * Static files in ./public are served by Cloudflare directly. Only the routes
 * below reach this code.
 *
 * /api/facts?ticker=M       every XBRL fact this tool can use, for one company
 * /api/releases?ticker=M    the earnings 8-Ks, newest first, no model called
 * /api/guidance?ticker=M    guidance read out of ONE release
 * /api/actuals?ticker=M     guides from the PREVIOUS release, the figures this
 *                           release reports against them, and which of those
 *                           pairs actually refer to the same period
 * /api/period?ticker=M      the period normaliser, over phrasings this product
 *                           has actually met. No model, no cost.
 * /api/text?ticker=M        the release as the extractor sees it. No model.
 * /sec?url=...              host-locked EDGAR proxy, for the browser
 *
 * Nothing is scored or stored yet.
 */

import { proxy, json } from "./sec.js";
import { factsFor, resolveCik, companyCalendar } from "./xbrl.js";
import { earningsReleases, guidanceFrom } from "./guidance.js";
import { requestsFrom, actualsFrom } from "./actuals.js";
import { resolvePeriod, samePeriod } from "./period.js";
import { releaseText } from "./text.js";

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
  { text: "full-year 2026", direction: "future" },
  { text: "FY 2026", direction: "future" },
  { text: "FY27", direction: "future" },
  { text: "Q3 FY27", direction: "future" },
  { text: "3Q26", direction: "future" },
  { text: "fourth quarter of fiscal year 2026", direction: "future" },
  { text: "third quarter", direction: "future" },
  { text: "full year", direction: "future" },
  { text: "second quarter fiscal 2027", direction: "future" },
  { text: "third quarter of 2026", direction: "future" },

  { text: "13 Weeks Ended May 2, 2026", direction: "past" },
  { text: "first quarter 2026", direction: "past" },
  { text: "three months ended June 30, 2026", direction: "past" },
  { text: "second quarter", direction: "past" },
  { text: "Three Months Ended July 31, 2026", direction: "past" },
  { text: "June quarter 2026", direction: "past" },

  // Should all decline, and say why.
  { text: "26 Weeks Ended August 1, 2026", direction: "past" },
  { text: "six months ended June 30, 2026", direction: "past" },
  { text: "second half", direction: "future" },
  { text: "May 2, 2026", direction: "past" },
  { text: "$21.5 billion to $21.75 billion", direction: "future" },
];

/**
 * A guide and its actual, paired only when they mean the same period.
 *
 * The rule the whole product turns on, and the one that was missing while
 * every test looked fine. Macy's guides the full year and reports a quarter:
 * its adjusted EBITDA margin guide of 7.7-7.9% sat next to a first-quarter
 * 5.9% and would have been published as a two-point miss ten months before the
 * year ended. Walmart reaffirmed 6-8% full-year operating income growth and
 * delivered 17.4% in one quarter.
 *
 * Neither is a beat or a miss. Neither period is over.
 *
 * So identical or nothing. There is no tolerance, no nearest match, no
 * "probably the same quarter". A pair that cannot be shown to refer to one
 * period is reported with the reason and left unscored - which is the rule
 * that was written down at the start: a guide with no actual is not shown.
 */
function pairUp(guides, actuals) {
  const byName = new Map();
  for (const a of actuals) byName.set(String(a.metric_as_written || "").toLowerCase(), a);

  const pairs = [];
  for (const g of guides) {
    const hasNumber =
      typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number";
    if (!hasNumber) continue;

    const a = byName.get(String(g.metric_as_written || "").toLowerCase());

    const base = {
      metric: g.metric,
      metric_as_written: g.metric_as_written,
      basis: g.basis,
      unit: g.unit,
      shape: g.shape,
      guide: { low: g.low ?? null, high: g.high ?? null, value: g.value ?? null },
      guide_period: g.period,
      guide_period_text: g.period_text,
    };

    if (!a) {
      pairs.push({ ...base, comparable: false, why: "No actual was looked for under this metric." });
      continue;
    }

    base.actual = a.value;
    base.actual_unit = a.unit;
    base.actual_period = a.period;
    base.actual_period_text = a.period_text;
    base.quote = a.quote;

    if (a.value === null) {
      pairs.push({ ...base, comparable: false, why: "The release does not report this figure." });
      continue;
    }
    if (!g.period) {
      pairs.push({ ...base, comparable: false, why: "The guide's period could not be read: " + (g.period_why || "unknown") });
      continue;
    }
    if (!a.period) {
      pairs.push({ ...base, comparable: false, why: "The actual's period could not be read: " + (a.period_why || "unknown") });
      continue;
    }
    if (!samePeriod(g.period, a.period)) {
      pairs.push({
        ...base,
        comparable: false,
        why: "Different periods: the guide is for " + g.period + " and the figure reported is for " + a.period + ".",
      });
      continue;
    }
    if (a.unit_mismatch) {
      pairs.push({ ...base, comparable: false, why: "The figure reported is not the kind of number that was guided." });
      continue;
    }

    pairs.push({ ...base, comparable: true });
  }
  return pairs;
}

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

    // The release list on its own, so the 8-K filter can be checked without
    // spending a model call. If this returns the wrong filings, nothing built
    // on top of it can be right.
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
        return json({ ticker: ticker.toUpperCase(), company: name, cik, calendar: cal.meta, ...result });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    /**
     * The pairing, end to end, for one pair of releases.
     *
     * Guides from the PREVIOUS release, actuals from the current one. Two model
     * calls, deliberately: guidance extraction already works, and asking one
     * call to do both jobs is how the first version of this product ended up
     * slow and wrong.
     *
     * ?accession= picks the current release, ?prior= the one it is scored
     * against. Both default to the two most recent and both are reported back,
     * because "which two filings was this built from" is the first question to
     * ask of any row that looks wrong.
     */
    if (url.pathname === "/api/actuals") {
      const ticker = url.searchParams.get("ticker");
      const wantedCurrent = url.searchParams.get("accession");
      const wantedPrior = url.searchParams.get("prior");
      if (!ticker) return json({ error: "Add ?ticker=M" }, 400);

      try {
        const { cik, name } = await resolveCik(env, ticker);
        const [releases, cal] = await Promise.all([
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

        // Step one: what did they say they would do?
        const priorGuidance = await guidanceFrom(env, cik, prior, cal);
        const requests = requestsFrom(priorGuidance.guides);

        if (!requests.length) {
          return json({
            ticker: ticker.toUpperCase(),
            company: name,
            cik,
            calendar: cal.meta,
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
        const result = await actualsFrom(env, cik, current, requests, cal);
        const pairs = pairUp(priorGuidance.guides, result.actuals);

        return json({
          ticker: ticker.toUpperCase(),
          company: name,
          cik,
          calendar: cal.meta,
          prior: priorGuidance.release,
          guides: priorGuidance.guides,
          comparable: pairs.filter((p) => p.comparable).length,
          notComparable: pairs.filter((p) => !p.comparable).length,
          pairs,
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
     * fixture is a phrasing this product has already met in a real release, and
     * each answer says HOW it was reached - because a period that is right for
     * the wrong reason will be wrong on the next company.
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

        let referenceDate = asOf;
        if (!referenceDate) {
          const releases = await earningsReleases(env, cik, 1);
          referenceDate = releases.length ? releases[0].filed : null;
        }

        const cases = text ? [{ text, direction }] : PERIOD_FIXTURES;

        const results = cases.map((c) => {
          const r = resolvePeriod(c.text, cal, { referenceDate, direction: c.direction });
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
     * No model, no cost. Same exhibits, same stripping, same budget, so what
     * this shows is what the model was given - the only way to tell a company
     * that did not guide from a document we failed to read.
     */
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

    return env.ASSETS.fetch(request);
  },
};
