# THE PRODUCT STRUCTURE (set by Zahoor, 17 Oct 2026 - never change it)

1. **Signup**: one sample company, one email per product - three emails at most. Then everything runs in the
   background.
2. **Earnings dates** are found and stored for every followed company, so we know who reports when.
3. **One day before** a company reports: the Guidance email (the preview: guide in force and its record). A company
   with no guidance, after every source is tried, gets an email saying so, at the same time.
4. **Seconds after the release**: the earnings email (Release Watch).
5. **When the 10-Q / 10-K reaches SEC**: the filings email (Filing Watch).

The preview workflow was DISABLED on 17 Oct: it sent on a date estimated from last year, 1-3 days early
(NFLX, PM, RTX on a Saturday). It stays off until stored earnings dates exist and it sends exactly one day before.

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

## Oct 15 2026 (afternoon): UNH fixed; product direction

- UNH: parts named by their table row are scoped (`rowLabelPart`): Optum Health / Insight / Rx and Community & State
  rows were stored as the company's revenue and operating earnings. Company revenue guide >$439bn now captured.
  Lines of several guides separated by ";" or bullets are now judged clause by clause for the second look.
  Full rebuild: only CCL, DAL, UNH, WFC changed; checked.
- DAL Q3 2024 revenue guide is now "Up 2% - 4%" (was read as 0); WFC's 3Q26 dividend guide ($0.50) is now scored.

**Product direction (Zahoor, 15 Oct):** one subscription, three emails a quarter per company -
(1) a PREVIEW before the report: guide in force, record against own guides, how much it usually beats by
(sandbagging) and what the rest of the year needs; (2) Release Watch minutes after the 8-K; (3) Filing Watch when the
10-Q lands. The preview is the piece still to build; report dates to be estimated from the web.

## Oct 15 2026 (evening): accuracy batch 3 and the PREVIEW email

Accuracy (all live, all 40 rebuilt, diffed against the previous build):
- Guides stated against the previous quarter ("improve 1 to 2 points sequentially", Delta) are kept as events, not
  scored. "Compared to the third quarter of 2024" is year-on-year and still scored (a first version dropped
  Carnival's cost guides; caught in the diff and fixed before any send).
- "Low twenties" (20-23%) read; words after "up from our prior guide" ignored. GE CES 2025 had been scored against
  the OLD guide (17-19%, "5pp above"); now 20-23%, 1pp above. "High-teens to low-twenties" = 17-23% (Elevance
  Carelon Services had been scored against 17-19%).
- A dollar guide that "equates to two to four percent growth" also yields the growth guide (`rateFromEquates`).
  P&G FY2025 core EPS growth is still unscored: the July 2025 release was not asked for it - open.
- Capex as a share of sales computed from the two printed amounts (`ratioFromAmounts`, actuals.js), marked
  "(calc.)" in the email: P&G FY2023-25 (3.73%, 3.95%, 4.48%), Walmart FY2026 (3.77%).

PREVIEW (src/preview.js, scripts/preview.mjs, .github/workflows/preview.yml):
- Daily 02:30 UTC. For each company a Guidance subscriber follows: next report = the release four back plus 364
  days (same weekday); sent when that is 1-3 days ahead, once (KV `preview:<T>:<date>`), skipped if the company
  filed in the last 30 days. Companies that guide only the year get it at interim reports ("its next quarter").
- Content: guides in force for the coming quarter and the year; per measure, how results landed against the
  guide's midpoint (above/within/below, median and range of the gap; flagged rows left out); and, with 4+ scored
  periods, that record applied to today's guide - labelled as arithmetic, not a forecast.
- Manual: Actions -> preview -> tickers, "test" ticked sends to TEST_EMAIL only; "dry" lists who is due.
- Tested 15 Oct: DAL, PG, MU, NFLX to TEST_EMAIL.

**Open for the preview:** report dates are estimates from last year (Zahoor wanted dates from the web - no free,
licensed calendar API is wired; a company's own "will report on" 8-K could confirm the date); "what the rest of the
year needs" (FY guide minus year to date) is not built; Abbott's estimate (14 Oct) passed before the job existed.

## Oct 15 2026 (night): Prologis email review - STATE AT HANDOVER

Zahoor got Prologis's live email (15 Oct). Checked line by line against the release: every figure shown was right, but:
- Acquisitions was RAISED ($1.5-2.0bn -> $2.1-2.3bn) and left out of the email: called a "scope change" because the
  low end moved 40%. Fixed: scale changes are judged on midpoints (revisions.js).
- "Core FFO excluding Net Promote Income" (same $6.25-6.29 as Core FFO) was dropped as a duplicate. Fixed in
  dedupeGuides: an "excluding ..." twin is kept only when its label is the other label plus that clause. (A first
  version keyed on the whole "excluding" phrase and un-folded Carnival's table columns; replaced.)
- The "[Check] PLD" email's two "guidance not read" lines were definitions/headings: definition lines are now skipped.

**A full rebuild (run 38749981107) was started with commit e7d75fd and NOT yet checked.** First thing next chat:
1. Confirm it succeeded; diff every record against the previous build (pairs scored, currentGuidance, revisions).
2. Check specifically: PLD (Acquisitions raised; Core FFO excl. promote present), CCL (2026 Q4/FY cost guides back to
   one per period: current $ 1.9%/3.5%, constant currency 1.7%/2.2% - no false "cut"), DAL Q3 2024 revenue guide
   (should be up 2%-4%, not 0), MKC 2025/2026 revisions (adjusted EPS 2025 cut and gross margin 2026 should be present).
3. Re-send PLD with send.yml test ticked and read it.

Report dates for the preview: Zahoor decided to wait for real subscribers (or use the signup page) before adding a
date source.

## Oct 15 2026 (late night): rebuild checked, five capture fixes - STATE AT HANDOVER

The e7d75fd rebuild was checked: PLD right (acquisitions raise, Core FFO excl. promote), CCL back to normal, but it
had lost MKC's 2026 gross margin guide (+100-120bp) and Oct 2025 EPS-growth cut, and DAL Q3 2024 revenue was 0%.
Fixed, all general (commits b8ff961 .. a42e77e), all 40 rebuilt (run 38774934430) and diffed against e7d75fd:
- Definitions: only the definition's sentence is set aside, not its line (MKC's table shared a 2,500-char line with
  "is defined as"). Basis-point guides count as guide-shaped.
- De-dup: guides with no named class merge only when their labels name the same measure (CCL Q4 cost per ALBD cc
  1.7% was dropped as a repeat of net yields cc 1.7%).
- "Flat - Up 1%" = 0 to 1 (DAL Sep 2024 update; also mis-signed low ends like -1 or -2.5). DAL Q3 2024 now within.
- Current-dollar / constant-currency table columns: the later figure is labelled "(in constant currency)" (CCL;
  also fixed CCL Mar 2026 and 2023 labels, which had cc figures under the plain label). Same unit and each figure
  once in the row required.
- columnOrder reads a "Current Guide ... Prior Guide" heading inside a long line: MKC Oct 2025 opinc stays a cut.
- Second look: a money figure more than a third from the first reading of the same measure/period is set aside as a
  part's (UNH UnitedHealthcare $9.0-9.3bn, WFC Markets NII); a figure from the previous column of a
  "Previous | Revised" table is set aside (PLD Jul 2025 same-store NOI 4-5%, LW capex). Logged in backfill.
- Tried and withdrawn: limiting the second look to measures the first reading missed (blocked better figures).
- Net change vs e7d75fd: CCL, DAL, MKC, PLD, UAL, UNH only; each checked against the filings. MKC Mar 2026 "raise"
  of adjusted opinc was false (Jan guide was already 16-20%) and is now "unchanged".
- PLD re-sent as test and read: correct.

**Pending, by priority:**
1. Ask Zahoor: the PLD headline counts only the guides shown ("1 raised, 1 cut, 2 narrowed") while the line below
   lists 5 more raised and 4 more cut. Count all, or keep?
2. MKC Oct 2025 four-column table (current/prior x reported/cc): net sales shows a false "raise" 0-2% -> 1-3% (the
   cc column under the plain label). Needs a proper table reader; do alone.
3. UNH July 2025 parts: scoping does not know UnitedHealthcare/Optum when the verb is "are expected"; guarded now,
   not fixed (scopeByPlace verb list, partsNamed).
4. The older list above (Carnival 2023 cost basis - now labels right, recheck the pair; prose guides missed; ratio
   actuals; investor-site slides; preview "rest of year").
Filing Watch: no new briefings since CHRN (14 Oct); its HANDOVER open items unchanged.

## Oct 17 2026: subscriber clean-up and fixes 1-3, 5 - STATE AT HANDOVER

Zahoor unsubscribed from everything and will sign up again once fixes are in. Nothing is sent to him meanwhile.
- **Filing Watch's old list** (`filing-agent/config/subscribers.json`, not touched by the unsubscribe page): his three
  addresses (zahoorbhatdotcom@, zahoorf6@, zahoor.bhat@icloud) set `active: false`. Two other people's stay active.
- **Shared list (KV `subscribers`)**: one address left, za***@gmail.com - DAL, MU, MSFT (Guidance), MSFT (Release
  Watch), MSFT (Filing Watch). Not TEST_EMAIL; probably zahoorf6@. Asked him whether to remove it.
- New: `whois.yml` / `scripts/whois.mjs` - read-only, prints the shared list with addresses masked.

Fixed (each rebuilt and diffed against the build before it):
1. **Email** (email.js): headline counts every guide in the release; every guide not shown in full gets a was/now
   line, largest move first; the two lines under the headline are the two largest moves. PLD now "6 raised, 5 cut,
   2 narrowed, 2 held", net earnings cut listed with figures. Render-only, no rebuild needed.
2. **Four-column tables** (fourColumnTables, guidance.js): current/prior x reported/constant currency. MKC Oct 2025
   net sales now held 0-2% (not raised), cc guides scored. Constant-currency relabels use the company's own wording
   (ccLabel).
3. **Passive segment guides**: "revenues for UnitedHealthcare are expected" names a part (PASSIVE_PART); the previous
   sentence scopes only when directly before. UNH Jul 2025 UnitedHealthcare revenue now a segment guide. A first
   version gave UNH Jan 2026 company table rows to Optum - caught in the diff and fixed before any send.
5. **Signup** refuses companies filing abroad (6-K/20-F, e.g. TSM) and shows what was not added.
- **Send**: a sent mark per release (`sent:<T>:<acc>`), so a rebuild can no longer swallow an email (JNJ 13 Oct).
- **Check**: "expected credit losses" / "better than expected" are not guidance words (TRV false alarms).

**Pending, by priority:**
1. Investor-site transcripts/slides (TRV, MSFT, C, CSX) - companies that guide on the call. Biggest piece; alone.
2. metricKey drops "constant currency" (metrics.js baseKey), so a plain and a cc guide of one measure share a key.
   Deliberate in the code; changing it touches every company - do alone with a full diff. (CCL 2023 cost item.)
3. UNH Jul 2025 UnitedHealthcare earnings from operations $9.0-9.3bn is set aside, not captured as the segment's.
4. Release Watch has never sent live (he never signed up for it); TSM 6-K support if wanted.

## Oct 17 2026 (later): fresh start
Zahoor asked to start from fresh. Both subscriber lists are EMPTY: the shared KV `subscribers` (Guidance, Release
Watch, Filing Watch) was cleared with `whois.yml` (input CLEAR), and filing-agent `config/subscribers.json` has
`"subscribers": []` (his three addresses and two other people removed, his decision). Company records (40) were kept.
Everyone, including him, signs up again at zahoorbhat.com/subscribe.

## Oct 17 2026 (after re-signup)
Zahoor signed up again: FITB, STLD, GE, NFLX, RTX, TSLA, LRCX, PM on all three products. New records built for
FITB, STLD, RTX, TSLA, LRCX, PM (FITB, STLD, TSLA not publishable - they guide on the call or in separate filings).
Fixed, each rebuilt (46 companies) and diffed:
- **Periods**: "June 2026 quarter" and a bare "March 2026" column (not the year-end month) are quarters, not years
  (period.js). Lam Research went from 3 to 31 scored pairs. June-quarter answers at Lam stay refused (could be the year).
- **Pairing basis** (pairing.js forPeriod): two results for one period are settled by the guide's basis; none if
  neither matches. MU EPS now scored against non-GAAP, as guided (was GAAP - FQ4 2024 had shown "below", is "above").
- **Gap format** (format.js formatGap): money gaps as $93m / $1.18bn, not $92.757m / $0.1bn.
- **Signup**: banks/insurers (SIC 6000-6499) kept off Release Watch only, with a note (subscribers.js `skip`).
- Filing Watch: an empty subscriber list made the Heartbeat report "watcher stopped" - fixed in filing-agent.
- Release Watch: the guide comparison borrowed from this record now uses only pairs the briefed release answered
  (GE's July email had shown Q1 2024 "revenue growth 11% vs 7-9%"). In release-watch src/scorecard.mjs.

## Oct 17 2026 (afternoon)
- **Samples**: one company per signup, one email per product (3 at most), picked for the most products it can show
  (Guidance record ready + Release Watch covered + Filing Watch). index.js confirm.
- **Constant currency** is now part of the measure key (metrics.js baseKey: "cc" at the end). Rebuild diff: only
  additions - CCL +14 pairs (current-dollar and cc guides no longer merged; e.g. Q3 2025 cost 8.9% current $ vs
  7.7% result), PEP +2 core EPS.
- **Second look**: a figure far from the company's own is kept when scopeByPlace places it in a part, dropped
  otherwise. UNH UnitedHealthcare 2025 earnings from operations $9.0-9.3bn now captured; result $9.4bn (verified).
- Release Watch (its repo): segment quotes labelled ("Company, on CES:"); a tied growth figure claims no record (RTX
  would have been held); borrowed guide comparison only from this release's pairs. TSLA's release is pictures of pages:
  Release Watch cannot read it.

**Pending:** investor-site transcripts/slides for call-guiders (TRV, MSFT, C, CSX; also FITB, STLD, TSLA) - a new
data source, needs a decision; Lam June-quarter answers (year-end month) still refused.
