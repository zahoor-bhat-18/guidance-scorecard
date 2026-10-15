# Guidance Scorecard: handover (14 Oct 2026)

For the next chat. Read this first, then ARCHITECTURE.md if you need the code layout.

## The product
- Live at zahoorbhat.com/guidance; signup for all three products at zahoorbhat.com/subscribe (this Worker). The guidance subdomain is gone. Repo: zahoor-bhat-18/guidance-scorecard (Cloudflare deploys `main` on every push).
- When a followed company files its earnings 8-K, each subscriber gets an email that scores results against the company's own guidance, shows how the guidance changed, and shows the track record ("Do they hit their guide?"). The reader is a PM. The product never predicts.
- Owner: Zahoor. A finance professional, not a developer, who works from his phone.
- His rules:
  - Keep it brief and plain.
  - Say what is verified and what is a guess.
  - Fixes are general and permanent (they work for every company).
  - Ask before visible or difficult changes.
  - Say when an idea is bad.
  - Start each chat with the pending list, ordered by priority.
  - **Numbers must be accurate, and nothing may be missed.**

## How Claude works on it (agreed)
- **Repo:** Claude commits and pushes straight to `main`, as author "Claude <noreply@anthropic.com>".
- **Before every push:** run `node --check` on each changed file, then an esbuild bundle of `src/index.js`, `scripts/backfill.mjs`, `scripts/send.mjs` and `scripts/notify.mjs`.
- **Rebuilds:** Claude runs backfill rebuilds himself. Rebuild only the tickers a fix touches, and never between a company's 8-K and its email. Trigger a rebuild with:
  `gh api -X POST repos/zahoor-bhat-18/guidance-scorecard/actions/workflows/backfill.yml/dispatches -f ref=main -f 'inputs[tickers]=X,Y' -f 'inputs[rebuild]=true'`
- **Sends:** a send can be run by hand with `send.yml` and `inputs[tickers]=X`.
- **Inspect live data:** `/api/record?ticker=X&full=1&n=RANDOM`, `/api/preview?ticker=X`, `/api/records` (lists all 39 records) and `/api/summary`.
- **Gmail access** to zahoorbhatdotcom@gmail.com:
  - Read every Guidance Scorecard email (from guidance@zahoorbhat.com) right after it is sent, and check it line by line against the filing.
  - "[Check] TICKER" emails list what the pre-send check held back.
  - Filing Watch emails (from filings@) are a separate product. Leave them alone unless asked.
- **SEC from the shell:** EDGAR is reachable with `curl -A "zahoor research zahoorf6@gmail.com"`.

## What changed on 13 Oct (all live, all companies rebuilt except where noted)
1. **Check before every send** (`src/check.js`). The number checks trace each result, and each new, raised, cut or held guide, to its quote and the filing. Anything that can't be confirmed is withheld: that line is taken out of the email and the record. The email still goes on time, and every finding is emailed to the owner (TEST_EMAIL) as "[Check] TICKER". The missed-guidance check also runs: lines that look like guidance but weren't read are reported (alert only).
2. **One email for companies whose outlook is filed later the same day** (JPMorgan).
   - The first pass holds the email. The outlook filing then sends one complete email; if it hasn't come within 6 hours, the email goes with the results only.
   - The poller re-checks a held company every 10 minutes (`src/index.js`).
3. **Deep look** (`src/actuals.js`):
   - **What it does:** a result still missing is searched for in the WHOLE filing, past the 80k-character budget. The lines carrying the measure's words, with their column headings, go to the model.
   - **Guards:** the answer must be on the same basis side (`sameSide`) and be the same measure (`sameMeasure`).
   - **Found so far:** JPMorgan's card charge-off rate for 2023–25, and P&G's dividends and buybacks.
4. **Full-year "implied" column** of a quarter's outlook table is read (JPMorgan FY26).
5. **Accuracy rules in pairing** (`src/pairing.js`):
   - A figure not in its own quoted line is never scored (`traceable`).
   - The bracket rule now applies to outflows only, so losses keep their minus sign.
   - A label naming both bases ("reported and comparable") is not scored.
   - Operating cash flow is never answered with free cash flow.
   - A guide restated "excluding" an item replaces the plain one.
6. **Guides:**
   - "at least" and "under" stay with the figure.
   - "+/- $50 billion" is read as "about $50bn".
   - "(NII)"-style abbreviations match the full name.
   - EPS worded two ways matches.
   - Medium- and long-term targets are not scored as one year's guide.
7. **Results:**
   - Dividends, buybacks, capex and interest expense are asked for as printed.
   - A plainly GAAP label (diluted / net income) is asked for as GAAP.
   - A rebuild never restores an answer from the other basis side.
8. **Email:** "about 20%" when the company wrote "Approx.". Scored-day emails get a line under the score for every full-year guide raised or cut.
9. **Send:** one run at a time per ticker set, which fixed the PepsiCo double email.
- **Audit after the rebuild:** all 813 scored results trace to their quoted line, and all 775 scored guide figures appear in their quotes.

## Emails sent with known mistakes (cannot be recalled)
- **13 Oct JPMorgan "Update" email:** showed only the Q4 outlook. It missed the full-year raises: net interest income ~$106.2bn (was $105.5bn), net interest income excluding Markets ~$97.2bn (was $96.5bn) and adjusted expense ~$108.6bn (was $107.5bn). The record is fixed.
- **13 Oct UnitedHealth and Wells Fargo emails:** UNH showed "new $20.50" for a raise to at least $20.50, and WFC left out the FY NII guide (held at ~$50bn). Both are fixed in the code and the records.

## Pending, by priority
1. **Check today's emails: JNJ and Citi (C) report 14 Oct.** Read each in Gmail, check every line against the release, and check any "[Check]" email. These are the first sends under the new check.
2. **Carnival 2023 cost per ALBD:** the guide looks like constant currency (9.5%), but the result scored is current dollars (11%). Read the 2023 releases and fix it in general (the label lacks "constant currency" while the guidance table's column says it).
3. **Watch the deep look for wrong picks.** It is new; check its "USED" lines in each backfill log against the filing for a while.
4. **Coca-Cola 2024/2025 "cash flow from operations excluding …":** now not scored, because no such figure is found. Check whether the release prints it.
5. **Results the releases don't print:** Prologis (acquisitions, occupancy, development), P&G (core tax rate, and capital spending as % of sales, which needs computing). These are left unscored on purpose; decide whether computing ratios is wanted.
6. **Lamb Weston:** two capex figures (cash vs accrual), which show in the also-line only.
7. **JPMorgan 2023 adjusted expense:** the guide was "~$84bn excluding FDIC special assessment", against 85.7 reported. The basis is not confirmed.
8. **Clean-up:** remove the old long email layout in `src/email.js` (it is dead code, used only with `opts.longLayout`).

## The owner's open question
On 13 Oct he asked whether PMs would pay for this. The honest answer given: probably not as a standalone product (Bloomberg/FactSet already carry guidance, consensus matters more on the day, and the email lands after the price move). The track-record angle is the distinctive part. Suggested: test demand with 5–10 buyers (small funds, independents, family offices), and bundle it with Filing Watch and Release Watch. He then chose to keep fixing accuracy first.


## Oct 14 2026: shared watcher and signup

This Worker is now the 8-K watcher and the signup for all three products (Guidance Scorecard, Release Watch,
Filing Watch). See release-watch HANDOVER.md section 6f for the whole set-up. In this repo:
- `src/subscribers.js`: products per record (`tickers`, `earnings`, `filings`), per-product unsubscribe (`&p=`).
- `src/index.js`: poll dispatches `release-watch` for earnings tickers; confirm requests samples; old host answers 404.
- `.github/workflows/release-watch.yml` and `sample.yml` check out the private release-watch / filing-agent repos with RW_READ_TOKEN.
- `public/subscribe.html`: the shared signup; `public/guidance.html`: the Scorecard page at zahoorbhat.com/guidance.

## Oct 14 2026 (evening): direction and capture batch 1

**Direction agreed with Zahoor.** Guidance Scorecard stays a separate product from Release Watch. It is rebuilt
around complete data: capture every guide and every actual, then (1) a pre-earnings preview email (guide in force,
the record, the adjusted guide, what the rest of the year needs; report dates estimated from the web) and (3) a
company-record-adjusted guide shown with its working. The day-of email goes only when guidance changes. Free and
legal sources only: filings, then company investor-site slides/transcripts, then webcast audio transcription.

**Audit (40 companies, latest release).** 34 put guidance in the filed 8-K (4 in a second exhibit); MSFT (investor
site transcript + outlook slides) and C (investor-site presentation) are verified to guide outside SEC; CSX and TRV
are thought to guide on the call; GS and KMX give no numeric guidance in filings. 1,137 of 1,280 captured past guides
(89%) have a matched actual. Capture faults found by pattern are listed below; batch 1 fixed the first four.

**Batch 1 (this commit):**
- Numbers written in words are read ("one to three percent", "four and a half", "in-line to three percent" = 0 to 3).
  P&G lost 5 of 8 FY27 guides to this. `spelledFigures` in guidance.js; only where a unit follows.
- Words ranges: the measure's word is found without the part's name and colon (GE "DPT: revenue growth").
- A change in money guided as "Increase approximately $200M to $300M" is a change, not a level (`asChange`).
- "next year" / "this year" resolve for guidance (period.js).
- Email: a guide given in words shows a star; a footnote names the words and the fixed rule (approved by Zahoor:
  low 1-3, mid 4-6, high 7-9).

**Found in the P&G test email after the rebuild (pre-existing, not from batch 1):** the email groups a GAAP guide and its
core twin under one heading - "Core net earnings per share growth" listed diluted (GAAP) EPS growth rows, FY2024 twice,
and the FY2027 core EPS level ($6.89-$7.11) as "growth". The record itself is right; the grouping in email.js is not.
P&G's core EPS growth has no actual (the release prints core EPS, not its growth): compute it from the two levels.
Delta's "non-fuel unit cost growth improve 1 to 2 points sequentially" is stored as 1-2% growth: a misread.
History is a rolling 14 releases (~3.5 years); older guides fall out as new releases arrive.

**Still open from the audit, in order:**
1. Prose guides missed: Netflix ads revenue ~$3bn and content amortization ~+10%, McCormick adjusted gross margin
   +100-120bp, Intuitive 1% tariff impact. Needs an extractor change; do alone.
2. Ratio guides with no actual: capex as % of net sales (WMT, PG, PEP). Compute capex / net sales from the release.
3. Half-year guides (Honeywell "second half") are refused by design; score H2 as Q3+Q4.
4. Investor-site slides and transcripts (MSFT, C, CSX, TRV), then webcast transcription.
5. Widen coverage beyond 40; then the preview email, the adjusted guide, report dates.

## Oct 15 2026: batch 2 (accuracy and email grouping)

- **GAAP and adjusted kept apart in the email** (`emailSide` in metrics.js; records.js; email.js). P&G's GAAP EPS growth
  had been shown under "Core net earnings per share growth" with FY2024 twice. The outlook now groups on the same
  key as the tables (measure + unit kind + side). Within one measure the adjusted table is chosen before the GAAP one,
  then the one with more history. Effect: P&G and UNH now lead with core/adjusted EPS.
- **Past-year column of an outlook table** (`pastYearColumn`, guidance.js). GE's July 2026 "Adjusted Revenue Growth
  21%" was the 2025 RESULT; the guide was "High-teens" (17-19%). Emails since July carried 21% as the guide. Street
  abbreviations LSD/MSD/HSD/LDD are read.
- **Words guides scoped to their part**: "Commercial Engines & Services (CES): ... revenue growth in the mid-teens" is
  CES, not GE (scopeByName, prefixPart).
- **Spelled-out results pass the trace check** (pairing.js `traceable`): P&G "increased two percent".
- **"Was" figures from words carry the star** (`before_words` on revisions).
- **A measure with its own record table is never cut from "What they guide now"** (GE free cash flow raise).

**Found, not fixed (in priority order):**
1. UNH Feb 2026: rows of the Optum outlook table (Optum Health revenue >$91bn, Optum Rx >$150.5bn, Optum Rx
   operating earnings >$6.25bn) are stored as the COMPANY's revenue/operating earnings; the company's own revenue
   guide (>$439bn) is missing. Would be scored as a huge beat in Jan 2027. A table with parts as rows and measures as
   columns needs scoping by row label.
2. Delta "improve 1 to 2 points sequentially" stored as 1-2% growth.
3. Ratio actuals to compute: capex % of sales (WMT, PG, PEP); EPS growth from two levels (P&G core).
4. Prose guides missed (Netflix ads ~$3bn, content amortization ~+10%; McCormick gross margin +100-120bp).
5. Investor-site slides/transcripts (MSFT, C, CSX, TRV); widen coverage; preview email; adjusted guide.

**Filing Watch (CHRN 10-Q, 14 Oct) - verified accurate, but:** (a) going-concern doubt now raised-then-alleviated
(10-K said "not raised") sits in "Also noted"; $2.7bn contracts at #6; $328.2m prepayments only a related link;
(b) Parker note x3, Ekso sale x3, Grid Note x3; (c) #10 pairs the 10-K's Microsoft "two-year partnership" sentence
with the 10-Q's Baseten sentence as one changed sentence - two different deals. (c) first; it implies a falsehood.

## Oct 15 2026: after batch 2 (rebuilt and checked)

- Hang fix: a model call during rebuilds is cut off at 3 minutes and logged (scripts/answers.mjs); a failed actuals
  question is asked again in halves (actuals.js). GE had failed the rebuild twice on one question.
- Revisions treat a rate and an amount of one measure as two guides (unitKind in revisions.js). Recovered guides that
  had been silently dropped: P&G core EPS growth path, J&J adjusted operational sales %, Carnival net income %,
  McCormick EPS growth, Netflix quarterly revenue in dollars, FactSet's 2024 EPS path.
- All 40 rebuilt 15 Oct 05:02 UTC, no failures; 1,741 answers, 1 paid. Test emails for PG, GE, RPM checked against
  the releases: correct.

**Open, found while checking (add to the list above):**
- P&G FY2025 core EPS growth (guided 5-7%, then cut) has no scored row; the dollar table has it.
- GE 2025 adjusted revenue growth (LDD, later raised) has no scored row: the guide is not carried to the Jan 2026 release.
- GE 2023 "Free cash flow* Flat to slightly improved" stored as 0% (a dollar measure guided in words).
- GE 2024 CES guides labelled "Commercial Engines & Services: ..." while 2025-26 say "CES: ..." (two tables, one part).
