/**
 * Periods, from how the company writes them.
 *
 * A guide and an actual can only be compared when they refer to the same
 * period, and the release writes that period in prose. One Macy's release
 * called the same fiscal year "Fiscal 2026" in the outlook table and
 * "13 Weeks Ended May 2, 2026" in the statements, and called the quarter
 * "first quarter 2026" in the narrative. Broadcom writes "fourth quarter of
 * fiscal year 2026". Walmart writes "Q3 FY27". Delta writes "3Q26".
 *
 * All of those have to become the same labels xbrl.js already produces -
 * 2026Q1, 2026FY - or nothing can be matched.
 *
 * Why this is code and not a model:
 *
 * Pairing the wrong periods is the failure that ends the product. Macy's guides
 * the full year and reports a quarter, and a matcher that shrugged and paired
 * them would have said the company missed its adjusted EBITDA margin by two
 * points ten months before the year finished. That has to fail the same way
 * every time, be inspectable when it is wrong, and never improvise.
 *
 * So this returns a period or it returns null with a reason. It never guesses,
 * and an unresolved period is not an error - it is a fact about the text,
 * and the caller declines to score that row.
 */

/* Month names as EDGAR and press releases write them. Built by hand rather
   than left to Date.parse, whose behaviour on partial dates is not specified
   and differs between runtimes. */
const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const ORDINALS = {
  first: 1, "1st": 1,
  second: 2, "2nd": 2,
  third: 3, "3rd": 3,
  fourth: 4, "4th": 4,
};

/**
 * Which fiscal year does a date fall in, and which quarter of it?
 *
 * Deliberately identical to the function of the same name in xbrl.js, and it
 * must stay that way: the two produce the labels that get compared to each
 * other, so a divergence here is a silent mismatch rather than a visible
 * error. It is duplicated rather than imported only because xbrl.js is proven
 * and is not being edited in the same change that introduces this file.
 */
function fiscalPosition(endDate, fye) {
  const d = new Date(endDate + "T00:00:00Z");
  const y = d.getUTCFullYear();

  let endsIn = y;
  const thisYearEnd = Date.UTC(y, fye.month - 1, fye.day);
  // A week either side, because a 52/53-week filer's year end moves.
  if (d.getTime() > thisYearEnd + 8 * 86400000) endsIn = y + 1;

  const yearEnd = Date.UTC(endsIn, fye.month - 1, fye.day);
  const yearStart = Date.UTC(endsIn - 1, fye.month - 1, fye.day);
  const through = (d.getTime() - yearStart) / (yearEnd - yearStart);
  const quarter = Math.min(4, Math.max(1, Math.round(through * 4)));

  return { endsIn, quarter };
}

/** The company's own label for the fiscal year a date falls in. */
function labelOf(dateISO, cal) {
  return fiscalPosition(dateISO, cal.fye).endsIn - cal.labelOffset;
}

/** When a given fiscal quarter ends, near enough to order them by. */
function quarterEndMs(label, quarter, cal) {
  const endsIn = label + cal.labelOffset;
  const yearEnd = Date.UTC(endsIn, cal.fye.month - 1, cal.fye.day);
  const yearStart = Date.UTC(endsIn - 1, cal.fye.month - 1, cal.fye.day);
  return yearStart + ((yearEnd - yearStart) * quarter) / 4;
}

/** When a given fiscal year ends. */
function yearEndMs(label, cal) {
  return Date.UTC(label + cal.labelOffset, cal.fye.month - 1, cal.fye.day);
}

/* Four digits stand as written. Two digits are this century - "FY27" has meant
   2027 in every release since the ones nobody is reading any more. */
function expandYear(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (raw.length === 4) return n;
  if (raw.length === 2) return 2000 + n;
  return null;
}

/**
 * Turn a period as the company wrote it into a label.
 *
 * cal is { fye: { month, day }, labelOffset }, from companyCalendar() in
 * xbrl.js - the same values the facts were labelled with.
 *
 * referenceDate anchors text that names no year: "third quarter" on its own.
 * The release's filing date is the right anchor.
 *
 * direction says which way to look when the year is missing. Actuals report a
 * period that has ended, so "past". Guidance describes one that has not, so
 * "future". Getting this wrong moves a period by one, which is exactly the
 * class of error that is invisible in a spot check and wrong in every row.
 */
export function resolvePeriod(text, cal, opts) {
  const options = opts || {};
  const direction = options.direction === "future" ? "future" : "past";
  const reference = options.referenceDate
    ? Date.parse(options.referenceDate + "T00:00:00Z")
    : Date.now();

  if (!text || typeof text !== "string") {
    return { period: null, why: "No period text was given." };
  }
  if (!cal || !cal.fye || typeof cal.labelOffset !== "number") {
    return { period: null, why: "No fiscal calendar was given for this company." };
  }

  const t = text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  /* ---- 1. A period stated with its end date ----
     "13 Weeks Ended May 2, 2026", "three months ended June 30, 2026". The most
     reliable form there is: the date fixes everything, and the duration says
     whether it is a quarter or a year. */

  const ended = t.match(
    /(?:ended|ending)\s+([a-z]+)\.?\s+(\d{1,2})\s*,?\s*(\d{4})/
  );
  if (ended) {
    const month = MONTHS[ended[1]];
    const day = parseInt(ended[2], 10);
    const year = parseInt(ended[3], 10);

    if (month && day >= 1 && day <= 31) {
      const iso =
        year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");

      const span = classifySpan(t);
      if (span === "ytd") {
        return {
          period: null,
          why: "This is a year-to-date or half-year figure, which is not comparable with a quarterly or annual guide.",
        };
      }

      const pos = fiscalPosition(iso, cal.fye);
      const label = pos.endsIn - cal.labelOffset;

      if (span === "year") {
        return { period: label + "FY", how: "fiscal year ended " + iso };
      }
      if (span === "quarter") {
        return { period: label + "Q" + pos.quarter, how: "quarter ended " + iso };
      }
      // A date with no stated duration. The date alone cannot say whether the
      // figure covers the quarter or the year that ends on it, and guessing
      // is how a full year gets scored as a fourth quarter.
      return {
        period: null,
        why: "An end date was given without a length, so this could be the quarter or the year ending " + iso + ".",
      };
    }
  }

  /* ---- 2. A quarter, named or numbered ----
     "first quarter", "fourth quarter of fiscal year 2026", "Q3 FY27", "3Q26". */

  let quarter = null;
  let yearFromQuarterToken = null;

  const ordinal = t.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b/);
  if (ordinal) quarter = ORDINALS[ordinal[1]];

  if (!quarter) {
    // "q3", "q3 fy27", "q3 2026"
    const qFirst = t.match(/\bq([1-4])\b/);
    if (qFirst) quarter = parseInt(qFirst[1], 10);
  }
  if (!quarter) {
    // "3q26", "3q 2026" - the year, when present, is welded to the token.
    const qLast = t.match(/\b([1-4])q\s?(\d{2}|\d{4})?\b/);
    if (qLast) {
      quarter = parseInt(qLast[1], 10);
      if (qLast[2]) yearFromQuarterToken = expandYear(qLast[2]);
    }
  }

  /* ---- 3. The year ----
     "fiscal 2026", "fiscal year 2026", "full year 2026", "fy27", or a bare
     four-digit year. Taken as the company's OWN label, because that is what a
     release prints - and the labels produced here are the company's own too. */

  let year = yearFromQuarterToken;

  if (year === null) {
    const fiscal = t.match(/\b(?:fiscal(?:\s+year)?|fy|full[-\s]?year)\s*(\d{4}|\d{2})\b/);
    if (fiscal) year = expandYear(fiscal[1]);
  }
  if (year === null) {
    const fyGlued = t.match(/\bfy(\d{2}|\d{4})\b/);
    if (fyGlued) year = expandYear(fyGlued[1]);
  }
  if (year === null) {
    const bare = t.match(/\b(19|20)\d{2}\b/);
    if (bare) year = parseInt(bare[0], 10);
  }

  // A year far from the filing is not a period, it is a stray number that
  // matched - a footnote marker, a figure, a comparative from years back.
  if (year !== null) {
    const refYear = new Date(reference).getUTCFullYear();
    if (Math.abs(year - refYear) > 3) {
      return {
        period: null,
        why: "The year read from this text (" + year + ") is too far from the filing date to be the period it describes.",
      };
    }
  }

  const saysFullYear = /\b(full[-\s]?year|fiscal year|for the year|annual)\b/.test(t)
    || (/\bfiscal\s*\d/.test(t) && quarter === null)
    || (/\bfy\s?\d/.test(t) && quarter === null);

  /* ---- 4. Halves and other spans we do not score ---- */
  if (!quarter && /\b(first|second|1st|2nd)\s+half\b|\bh[12]\b|\b[12]h\b/.test(t)) {
    return { period: null, why: "A half-year is not a period this scores." };
  }

  /* ---- 5. Put it together ---- */

  if (quarter && year !== null) {
    return { period: year + "Q" + quarter, how: "quarter and year both stated" };
  }

  if (quarter && year === null) {
    // "third quarter", no year. Anchored on the filing date and the direction
    // of travel: an actual looks back, a guide looks forward.
    const label = nearestQuarterLabel(quarter, cal, reference, direction);
    if (label === null) {
      return { period: null, why: "A quarter was named with no year, and no filing date was available to anchor it." };
    }
    return {
      period: label + "Q" + quarter,
      how: "quarter stated, year inferred from the filing date looking " + direction,
    };
  }

  if (!quarter && year !== null && saysFullYear) {
    return { period: year + "FY", how: "full year stated" };
  }

  if (!quarter && year !== null) {
    // A year and nothing else. Common in outlook tables headed only "2026".
    return { period: year + "FY", how: "year stated with no quarter, read as the full year" };
  }

  if (!quarter && year === null && saysFullYear) {
    const label = nearestYearLabel(cal, reference, direction);
    return {
      period: label + "FY",
      how: "full year stated, year inferred from the filing date looking " + direction,
    };
  }

  return { period: null, why: "No period could be read from: " + text };
}

/* How long is the period? Companies state it either in months or in weeks, and
   52/53-week filers use weeks because their year is not twelve months. */
function classifySpan(t) {
  if (/\b(13|12|14)\s*weeks?\b/.test(t)) return "quarter";
  if (/\b(three|3)\s*months?\b/.test(t)) return "quarter";
  if (/\b(52|53)\s*weeks?\b/.test(t)) return "year";
  if (/\b(twelve|12)\s*months?\b/.test(t)) return "year";
  if (/\bfiscal year (ended|ending)\b/.test(t)) return "year";
  if (/\b(26|39)\s*weeks?\b/.test(t)) return "ytd";
  if (/\b(six|6|nine|9)\s*months?\b/.test(t)) return "ytd";
  if (/\byear[-\s]to[-\s]date\b/.test(t)) return "ytd";
  return null;
}

/**
 * "Third quarter" with no year, resolved against the filing date.
 *
 * Looking back: the most recent third quarter that has ended. Looking forward:
 * the next one that has not.
 */
function nearestQuarterLabel(quarter, cal, referenceMs, direction) {
  if (!Number.isFinite(referenceMs)) return null;
  const centre = labelOf(new Date(referenceMs).toISOString().slice(0, 10), cal);

  const candidates = [centre - 1, centre, centre + 1];
  if (direction === "past") {
    let best = null;
    for (const label of candidates) {
      const end = quarterEndMs(label, quarter, cal);
      if (end <= referenceMs && (best === null || end > quarterEndMs(best, quarter, cal))) best = label;
    }
    return best;
  }

  let best = null;
  for (const label of candidates) {
    const end = quarterEndMs(label, quarter, cal);
    if (end > referenceMs && (best === null || end < quarterEndMs(best, quarter, cal))) best = label;
  }
  return best;
}

/** "Full year" with no year, resolved the same way. */
function nearestYearLabel(cal, referenceMs, direction) {
  const centre = labelOf(new Date(referenceMs).toISOString().slice(0, 10), cal);
  if (direction === "past") {
    return yearEndMs(centre, cal) <= referenceMs ? centre : centre - 1;
  }
  return yearEndMs(centre, cal) > referenceMs ? centre : centre + 1;
}

/**
 * Two periods, compared.
 *
 * The only comparison the matcher is allowed to make. Identical or not - there
 * is no "close enough", because the near misses are exactly the dangerous
 * ones: a full-year guide against a first-quarter actual looks plausible and
 * is nonsense.
 */
export function samePeriod(a, b) {
  return Boolean(a) && Boolean(b) && a === b;
}
