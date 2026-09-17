/**
 * The revision sentence.
 *
 * This is here rather than in revisions.js because of what KV holds.
 *
 * revisionsBetween runs once, at backfill or at send, and its output is
 * written to the record. It used to write the finished sentence. So when the
 * wording was fixed - the label still carrying "Fourth quarter" and the word
 * "guidance", the period printed as "2026Q4" instead of "Q4 2026" - nothing
 * changed in any email, because every sentence in KV had already been built by
 * the old code. Six backfills would have been needed to see a wording fix, at
 * twenty-seven model calls each, and re-running a backfill rewrites history a
 * subscriber has already read.
 *
 * Stored output goes stale. Stored inputs do not. The record already carries
 * every part of the sentence - the label as written, the period, the unit, the
 * figures before and after, the direction - so the sentence is built when the
 * email is rendered, from those.
 *
 * A wording change now takes effect on the next send, for every company, with
 * no backfill.
 *
 * The record keeps a stored summary as well, because a field this needs could
 * be missing from an old record, and a stale sentence beats a broken one. The
 * caller falls back to it when this returns null.
 */

import { formatFigure, periodLabel } from "./format.js";
import { displayLabel } from "./metrics.js";

function hasFigure(g) {
  return Boolean(g) && (
    typeof g.low === "number" || typeof g.high === "number" || typeof g.value === "number"
  );
}

/* Appended, not woven in, so it reads the same whether the taint was decided
   in the same pass that built the sentence or on a record read back later. */
const TAINT = " Another metric in this release changed scale, so some of this"
  + " move may be the same change in what is being counted rather than a revision.";

/**
 * One revision, as a sentence.
 *
 * Returns null when the stored revision does not carry what the sentence
 * needs. Null means "use what was stored", never "print something partial" -
 * a sentence with a gap in it is the one thing worse than an out-of-date one.
 */
export function revisionSentence(r) {
  if (!r || !r.direction || !r.period) return null;

  const written = r.metric_as_written || r.metric;
  if (!written) return null;

  const label = displayLabel(written);
  const when = periodLabel(r.period);
  const unit = r.unit;
  const dir = r.direction;

  // A guide for a period that had none before.
  //
  // It said "is guided for the first time at", which was both longer than it
  // needed to be and a slightly bigger claim than the record supports: the
  // first time IN THE FOURTEEN RELEASES READ is not the first time ever, and
  // an extraction that missed the earlier one would make the sentence false.
  // "Guided at" says what is known.
  if (dir === "new") {
    if (!hasFigure(r.after)) return null;
    return label + " for " + when + " guided at " + formatFigure(r.after, unit) + ".";
  }

  // A guide that stopped appearing. Reported as an absence, never as a
  // withdrawal - a company that did not repeat a figure has not retracted it,
  // and saying it did would be an accusation.
  if (dir === "not repeated") {
    if (!hasFigure(r.before)) return null;
    return label + " for " + when + " was guided at " + formatFigure(r.before, unit)
      + " in the previous release and does not appear in this one."
      + " That is not necessarily a withdrawal.";
  }

  if (!hasFigure(r.before) || !hasFigure(r.after)) return null;

  let sentence;

  if (dir === "scope change") {
    sentence = label + " for " + when + " changed scale. Was "
      + formatFigure(r.before, unit) + ", now " + formatFigure(r.after, unit)
      + ". A move that large is not a revision - it usually means a spin-off, a"
      + " disposal or a restatement has changed what is being counted. Not reported"
      + " as a raise or a cut.";
  } else if (dir === "unchanged") {
    sentence = label + " for " + when + " held at " + formatFigure(r.after, unit) + ".";
  } else {
    // Two short sentences rather than one long one. A reader takes in "they
    // raised" and then the figures, which is the order the information matters
    // in.
    sentence = label + " for " + when + " " + dir + ". Was "
      + formatFigure(r.before, unit) + ", now " + formatFigure(r.after, unit) + ".";
  }

  if (r.possibleScopeChange && dir !== "scope change") sentence += TAINT;

  return sentence;
}
