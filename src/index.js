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
import { revisionsBetween } from "./revisions.js";
import { releaseText } from "./text.js";
import { readRecord, listRecords, forEmail, headline } from "./records.js";
import { renderEmail } from "./email.js";

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

/**
 * A guide and its actual, paired only when they mean the same period.
 *
 * The rule the whole product turns on, and the one that was missing while
 * every test looked fine. Macy's guides the full year and reports a quarter:
 * an adjusted EBITDA margin guide of 7.7-7.9% sat next to a first-quarter 5.9%
 * and would have published as a two-point miss ten months before the year
 * ended. Walmart reaffirmed 6-8% full-year operating income growth and
 * delivered 17.4% in one quarter.
 *
 * Neither is a beat or a miss. Neither period is over.
 *
 * So identical or nothing. No tolerance, no nearest match. A pair that cannot
 * be shown to refer to one period is reported with the reason and left
 * unscored.
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
    base.actual_found_as = a.found_as;
    base.expected_basis = a.expected_basis;
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
    if (a.basis_mismatch) {
      pairs.push({ ...base, comparable: false, why: a.basis_mismatch });
      continue;
    }

    pairs.push({ ...base, comparable: true });
  }
  return pairs;
}

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
  const requests = requestsFrom(priorGuidance.guides);

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
        const requests = requestsFrom(priorGuidance.guides);

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
        const result = await actualsFrom(env, cik, current, requests, calendar);
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

    return env.ASSETS.fetch(request);
  },
};
