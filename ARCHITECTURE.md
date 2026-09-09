# Guidance Scorecard — architecture

Status: design agreed, not yet built. Extraction is proven on six companies.
Everything below the "Build order" heading is unbuilt.

---

## What it is

A record of how a company's management guidance has compared to what they
actually delivered, delivered to a portfolio manager at the two moments it is
worth money: the day before they report, and the minute the release lands.

The email states the record. It does not predict, rank, score out of ten, or
tell the reader what to think. The reader is a PM; the inference is his job.
This is the same discipline as Filing Watch — quote verbatim, let the fact do
the work.

---

## Why it is built this way

The first version read the earnings release for both the guidance and the
actuals, with one model call doing everything. It was slow, and it was wrong
often enough not to be trusted.

The rebuild started from the opposite position: take actuals from XBRL, where
they are exact, and use the model only for guidance, which is prose and cannot
come from anywhere else.

Testing on six large caps showed that position is too narrow to be a product.
Across Macy's, United, Delta, Broadcom, Walmart and Honeywell, the latest
release produced four GAAP-scoreable guides in total. Five of the six would
not clear a two-metric publication rule. Management guides non-GAAP because
non-GAAP is what they want to be judged on, and it is what the market judges
them on. A GAAP-only scorecard scores the thing nobody guides.

So the architecture is hybrid, and the model is back in the actuals path —
deliberately, and with a guard.

---

## Where each number comes from

| | source | exact? |
|---|---|---|
| Guidance, all metrics | earnings release, model | no — extracted |
| GAAP actuals | XBRL companyfacts | yes |
| Non-GAAP actuals | earnings release, model | no — extracted |
| Prior-year base for growth guides | XBRL companyfacts | yes |
| Fiscal period and label | XBRL, already built and verified | yes |

The email labels the source of every figure. "Revenue, from the filed
accounts" is a different claim from "adjusted EPS, as the company reported
it", and the reader is entitled to know which he is looking at.

### The guard

A wrong guide is a bad row. A wrong actual is a confident false accusation —
the product telling a PM a company missed when it did not. That is the failure
that ends the product, so it gets a check in code:

On every run, the revenue the model read out of the release is compared to the
revenue XBRL holds for the same period. A material mismatch stops the email
and raises an alert. It does not send a hedged version.

This is the Filing Watch rule: fail loudly, never send something that might be
wrong.

---

## What the release-driven design fixes

Taking actuals from the release, rather than only from XBRL, removes the
timing problem that shaped the earlier design.

XBRL does not carry a quarter until the 10-Q is filed, weeks after the
earnings release. That meant an email sent at 8-K time could show the historic
record and the new guide, but could not say whether the quarter just reported
hit its own guide — the single most interesting line.

The release contains both: the actual for the period ending, and the guide for
the period starting. Score release N's actual against release N-1's guide and
the whole thing is self-contained. The email at 8-K time is complete.

XBRL is still doing real work: exact revenue, the prior-year base that turns
a growth-rate guide into a level, the period and fiscal-label logic already
verified, and the cross-check above.

---

## Two emails

**Pre-earnings.** Sent the day before the company reports. Contains only the
existing record — no model call, no race against the tape, nothing that can
fail at the last minute. Earnings dates are published, so this is schedulable.

This is positioning information. The record is knowable in advance and is
worth more before the print than after it.

**On release.** Sent when the 8-K carrying item 2.02 lands. Contains what they
just delivered against what they guided, and the new forward guidance.

Nothing is sent when the 10-Q later lands. The XBRL actual arrives, updates
the stored record silently, and is used to check what the model read.

---

## Engines

**1. Historical (offline).** Per company, once, then incrementally. Walks back
through item-2.02 8-Ks, extracts guidance and actuals from each, pairs them,
scores them, stores the result. Roughly ten to eleven releases per company to
cover eight quarters, because a guide for a period is issued in the release
before it.

**2. Live (on filing).** 8-K lands, one release read, scored against the stored
record, email out. Everything else is a KV read.

**3. Refresh (scheduled).** XBRL re-fetch as 10-Qs land. Updates GAAP actuals
to filed figures and runs the revenue cross-check. Sends nothing.

**4. Pre-earnings (scheduled).** Reads the stored record, sends. No extraction.

Note on the runtime: Workers Free allows 10ms CPU per request. Engine 2 should
fit. Engine 1 — ten releases per company across a universe — will not, and
should run in GitHub Actions like Filing Watch. The modules are written as
plain ES modules with no Worker-specific code so they can move unchanged.
This is a guess until measured.

---

## Rules

- A guide with no matched actual is not shown. Not greyed out, not "not
  reported".
- A metric needs three matched pairs across eight quarters to earn a block.
- A company with fewer than two qualifying metrics is not published.
- Coverage is stated, not hidden.
- Everything precomputed. Nobody waits.
- The earliest filed XBRL figure wins, not the restated one. Management was
  judged on what they filed at the time.
- Qualitative guides ("up mid-teens") are recorded as guidance events with no
  score.
- Reaffirmations and withdrawals are recorded as events with no numbers.

---

## Full-year guides

A full-year guide is not one number, it is a path. It is issued, then revised
across the year, then settled by the annual actual. The record shows the
revisions in sequence and the final outcome. The revision path is the finding.

---

## Open questions

1. **Which guide is scored?** A quarterly guide has one answer. A full-year
   guide has up to four. Scoring against the first measures forecasting;
   against the last measures very little. Current thinking is to score the
   full-year outcome against the ORIGINAL guide, and show the revisions
   separately as the path — but this is not settled.

2. **Growth-rate and percentage-of-sales guides.** Walmart guides constant
   currency; Honeywell guides organic. The XBRL base can turn a growth rate
   into a level, but constant currency and organic are not the same as
   reported, so the comparison is not clean. Possibly recorded as events
   without scores in v1.

3. **Comparable sales.** Pervasive in retail, absent from XBRL entirely, and
   only in the release. If non-GAAP actuals come from the release anyway, this
   may be scoreable after all. Worth testing before excluding.

4. **Multiple releases per period.** Macy's filed two item-2.02 8-Ks for one
   quarter (25 Nov and 11 Dec 2024) during its accounting investigation.
   Releases need deduping to one per period, and the rule for which one wins
   is not decided.

5. **Universe.** Should be chosen by what is actually scoreable, not by market
   cap. That means running extraction across candidates and measuring, not
   picking names first.

6. **Beat / met / missed thresholds.** Delivering at the bottom of a guided
   range is not a beat and is not a miss. Where the boundaries sit, and
   whether "met" is a band or a point, is undecided.

---

## Known extraction issues

Found in the six-company test. None are blocking; all need handling.

- The model returns metric names outside the requested list — `net_sales`,
  `sales`, `interest_net`. Needs normalising in code, not by adding
  instructions to the prompt.
- Derivative guides come through as noise: organic growth alongside the sales
  guide it derives from, margin expansion in basis points alongside the margin
  itself, earnings growth percentage alongside the EPS range.
- Table-sourced guides risk grabbing the adjacent column. Walmart's capex
  quote pulled text spanning the prior guidance and current guidance columns.
- Basis labelling is mostly right but not always. Comparable sales came back
  labelled GAAP.
- Three of six exhibits were selected by the largest-HTML fallback rather than
  the 99.1 filename, and all three were correct. Encouraging, not proven.

---

## Build order

1. Actuals extraction from the release, alongside the existing guidance
   extraction. Same call or a second one — to be decided by testing.
2. The revenue cross-check against XBRL.
3. Metric normalisation and derivative-guide suppression.
4. The matcher: pair a guide to its actual, deterministically.
5. Scoring, once thresholds are decided.
6. Release deduping per period.
7. Coverage measurement across candidate companies. Universe chosen from the
   result.
8. Storage into KV.
9. The on-release email.
10. The pre-earnings email.
11. Subscription, confirmation and unsubscribe — the Filing Watch pattern,
    already proven.

One at a time. Nothing bundled.
