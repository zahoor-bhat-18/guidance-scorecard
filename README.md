# Guidance Scorecard

Eight quarters of what management promised, against what the company filed.

Guidance is read from the 8-K. Actuals come from XBRL. A row exists only when
both halves are present.

---

## How we work

1. **Whole files, never patches.** Everything is pasted into GitHub's web
   editor from a phone. A partial edit goes wrong.
2. **Only the files that changed.** Not the whole set every time.
3. **Questions before building, not after.**
4. **Say what is verified and what is a guess.** Every time.
5. **One thing at a time.** Bundled changes cannot be attributed when something
   breaks.
6. **Say when an idea is bad.** Especially mine.
7. **Prefer code to prompts.** Everything reliable in the filing agent is
   deterministic. Every prompt-based fix there was unstable.
8. **Never judge a change on one run.** The model varies. Test offline against
   saved fixtures where possible.

## Versioning

`VERSION` is one constant, in `public/index.html`, printed in the page footer.

- Bump the **minor** on any change that alters behaviour: `v0.1` to `v0.2`.
- Bump the **major** when the scorecard changes shape.
- Bump it **in the same commit as the change**, never afterwards.

The footer is how we know which version is live. If the footer and the repo
disagree, the deploy did not happen.

Tag a release in GitHub whenever something works, so it can be rolled back.

## Deploying

Cloudflare Workers, connected to this repo. Check the build went green before
concluding anything about a change — a red build serves the previous version
silently.

`wrangler.jsonc` carries `keep_vars: true`. Without it a deploy deletes every
secret and variable set in the dashboard.

---

## Status

### Done

_Nothing yet._

### In progress

| | task |
|---|---|
| 1 | **Matching test, by hand.** Type Macy's guidance in manually, match against XBRL `companyfacts`, check the deltas against the release. No model, no deployment. If matching is clean without a model in the loop, everything after is plumbing. |

### Pending, in priority order

| | task |
|---|---|
| 2 | Repo skeleton: `wrangler.jsonc`, `src/index.js`, `src/sec.js` carried over from the old repo |
| 3 | XBRL client: fetch `companyfacts`, map concepts to metrics with ordered fallbacks, align fiscal periods |
| 4 | Guidance extraction: one model call per release, guidance only, GAAP only |
| 5 | Matcher: deterministic pairing of a guide to its XBRL fact |
| 6 | Scoring: beat / met / missed, inverted for capex and tax rate |
| 7 | Precompute job: read the universe into KV on a schedule |
| 8 | The page: the record, the outlook, coverage stated |
| 9 | Pick the universe and measure coverage per company |
| 10 | PDF presentations (v0.2) |

### Blockers

| | blocker | what unblocks it |
|---|---|---|
| A | Unknown whether XBRL fiscal periods align with company-labelled quarters without per-filer work | task 1 |
| B | Unknown how many companies guide GAAP at all. Most decline to, in the release, in those words. The universe may be much smaller than 19 | task 9 |
| C | Concept mapping is unproven. The same measure appears as `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `SalesRevenueNet` across filers | task 3 |

---

## Scope

**In.** GAAP guidance, from the 8-K and its HTML exhibits, against XBRL.

**Out of v0.1.** Presentations and PDFs. Hardest part of the job; adding it
first blocks everything simple behind it.

**Out entirely.** Earnings-call transcripts. Paid, and redistribution carries
licensing exposure.

## Rules the page enforces

- A guide with no actual is **not shown**. Not greyed out, not "not reported".
  It does not exist.
- A metric needs **three matched pairs** across the eight quarters to earn a
  block. One pair is not a track record.
- A company with **fewer than two qualifying metrics is not published**.
- Coverage is **stated, not hidden**. "This company does not guide GAAP
  figures" is a finding, printed plainly.

## Not built again

Things the old version had that are deliberately absent:

- Drivers, flow-through ratios, cosmetic-raise detection, anomaly cards
- The quiz
- On-demand computation. Everything is precomputed; nobody waits.
