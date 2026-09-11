/**
 * Periods, from how the company writes them.
 *
 * A guide and an actual can only be compared when they refer to the same
 * period, and the release writes that period in prose. One Macy's release
 * called the same fiscal year "Fiscal 2026" in the outlook table and
 * "13 Weeks Ended May 2, 2026" in the statements, and the quarter "first
 * quarter 2026" in the narrative. Broadcom writes "fourth quarter of fiscal
 * year 2026". Walmart writes "Q3 FY27". Delta writes "3Q26" and "the June
 * quarter".
 *
 * All of those have to become the same labels xbrl.js produces - 2026Q1,
 * 2026FY - or nothing can be matched.
 *
 * Why this is code and not a model:
 *
 * Pairing the wrong periods is the failure that ends the product. Macy's
 * guides the full year and reports a quarter: an adjusted EBITDA margin guide
 * of 7.7-7.9% sat beside a first-quarter 5.9% and would have published as a
 * two-point miss ten months before the year ended.
 *
 * So this returns a period or it returns null with a reason. It never guesses,
 * and an unresolved period is not an error - it is a fact about the text, and
 * the caller declines to score that row.
 */

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

const MONTH_WORDS = Object.keys(MONTHS).join("|");
const DATE_RE = new RegExp("\\b(" + MONTH_WORDS + ")\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})\\b");

/* Airlines name a quarter by the month it ends in - "the June quarter", "the
   March quarter". Standard usage at Delta and United, and it resolved to a
   full year until this was added. */
const MONTH_QUARTER_RE = new RegExp("\\b(" + MONTH_WORDS + ")\\s+quarter\\b");

function lastDayOf(month, year) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Which fiscal year does a date fall in, and which quarter of it?
 *
 * Deliberately identical to the function of the same name in xbrl.js, and it
 * must stay that way: the two produce the labels that get compared to each
 * other, so a divergence here is a silent mismatch rather than a visible
 * error.
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

function labelOf(dateISO, cal) {
  return fiscalPosition(dateISO, cal.fye).endsIn - cal.labelOffset;
}

function quarterEndMs(label, quarter, cal) {
  const endsIn = label + cal.labelOffset;
  const yearEnd = Date.UTC(endsIn, cal.fye.month - 1, cal.fye.day);
  const yearStart = Date.UTC(endsIn - 1, cal.fye.month - 1, cal.fye.day);
  return yearStart + ((yearEnd - yearStart) * quarter) / 4;
}

function yearEndMs(label, cal) {
  return Date.UTC(label + cal.labelOffset, cal.fye.month - 1, cal.fye.day);
}

function expandYear(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (raw.length === 4) return n;
  if (raw.length === 2) return 2000 + n;
  return null;
}

/**
 * Does this filer label a fiscal year by the year it starts or the year it
 * ends, learned from the company's own release?
 *
 * The detector this replaces read dei.DocumentFiscalYearFocus out of
 * companyfacts. It never worked: that tag is not in the companyfacts payload
 * at all, for any filer tested, so every company fell through to guessing from
 * the year-end month - and the month carries no information. Macy's, Walmart
 * and Autodesk all close in late January. Macy's year ending January 2026 is
 * its fiscal 2025. Walmart's year ending January 2027 is its fiscal 2027.
 *
 * That guess cost real pairs: Walmart guided net sales up 4.0-5.0% for
 * "second quarter fiscal 2027" and delivered 5.0%, a scoreable top-of-range
 * result, and the two sides were labelled a year apart so it was thrown away.
 *
 * The company states the answer in the document. A release that says "second
 * quarter fiscal 2027" also says "Three Months Ended July 31, 2026". Put those
 * side by side and the offset falls out with nothing inferred.
 *
 * Only pairings found CLOSE TOGETHER are used - within about a hundred
 * characters, on the same line. A release also mentions the last 10-K's year
 * end, and pairing that with an outlook year would produce a confident wrong
 * answer. Majority wins across everything found, and every candidate is
 * reported.
 */
export function conventionFromText(text, fye) {
  if (!text) return null;

  const votes = { 0: 0, 1: 0 };
  const seen = [];

  const near = new RegExp(
    "(?:fiscal(?:\\s+year)?|fy)\\s*(\\d{4}|\\d{2})[^\\n]{0,100}?end(?:ed|ing)\\s+(" + MONTH_WORDS + ")\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})"
    + "|end(?:ed|ing)\\s+(" + MONTH_WORDS + ")\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})[^\\n]{0,100}?(?:fiscal(?:\\s+year)?|fy)\\s*(\\d{4}|\\d{2})",
    "gi"
  );

  let m;
  while ((m = near.exec(text)) !== null) {
    const label = expandYear(m[1] || m[8]);
    const monthName = (m[2] || m[5] || "").toLowerCase();
    const day = parseInt(m[3] || m[6], 10);
    const year = parseInt(m[4] || m[7], 10);
    const month = MONTHS[monthName];

    if (!label || !month || !day || !year) continue;

    const iso = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    const { endsIn } = fiscalPosition(iso, fye);
    const offset = endsIn - label;

    const row = { label, periodEnd: iso, impliedOffset: offset };
    if (offset === 0 || offset === 1) votes[offset] += 1;
    else row.rejected = "implied offset of " + offset + " is not 0 or 1";
    seen.push(row);

    if (seen.length >= 12) break;
  }

  if (votes[0] === 0 && votes[1] === 0) return null;

  const offset = votes[0] >= votes[1] ? 0 : 1;
  return {
    offset,
    source: "the release text, pairing a stated fiscal year with a stated period end",
    evidence: seen,
    votes,
  };
}

/**
 * Turn a period as the company wrote it into a label.
 *
 * cal is { fye: { month, day }, labelOffset } - the same values the XBRL facts
 * were labelled with.
 *
 * referenceDate anchors text that names no year. The filing date is the right
 * anchor. direction says which way to look: actuals report a period that has
 * ended, guidance describes one that has not. Getting that wrong moves a
 * period by one, which is invisible in a spot check and wrong in every row.
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

  /* ---- 1. A period stated with its end date ---- */

  const hasEnded = /\b(ended|ending)\b/.test(t);
  const dateMatch = t.match(DATE_RE);

  if (hasEnded && dateMatch) {
    const month = MONTHS[dateMatch[1]];
    const day = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);

    if (month && day >= 1 && day <= 31) {
      const iso = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
      const span = classifySpan(t);

      if (span === "ytd") {
        return {
          period: null,
          why: "This is a year-to-date or half-year figure, which is not comparable with a quarterly or annual guide.",
        };
      }

      const pos = fiscalPosition(iso, cal.fye);
      const label = pos.endsIn - cal.labelOffset;

      if (span === "year") return { period: label + "FY", how: "fiscal year ended " + iso };
      if (span === "quarter") return { period: label + "Q" + pos.quarter, how: "quarter ended " + iso };

      return {
        period: null,
        why: "An end date was given without a length, so this could be the quarter or the year ending " + iso + ".",
      };
    }
  }

  /* ---- 2. A quarter, named or numbered ---- */

  let quarter = null;
  let yearFromQuarterToken = null;

  const ordinal = t.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b/);
  if (ordinal) quarter = ORDINALS[ordinal[1]];

  if (!quarter) {
    const qFirst = t.match(/\bq([1-4])\b/);
    if (qFirst) quarter = parseInt(qFirst[1], 10);
  }
  if (!quarter) {
    const qLast = t.match(/\b([1-4])q\s?(\d{2}|\d{4})?\b/);
    if (qLast) {
      quarter = parseInt(qLast[1], 10);
      if (qLast[2]) yearFromQuarterToken = expandYear(qLast[2]);
    }
  }

  /* ---- 3. A quarter named by the month it ends in ----
     "the June quarter". Delta and United both use it as their ordinary way of
     naming a quarter, and it resolved to a full year before this existed.
     The month fixes the quarter through the same fiscal arithmetic as a date
     does - which quarter contains the end of that month. */

  let monthQuarter = null;
  const mq = t.match(MONTH_QUARTER_RE);
  if (!quarter && mq) {
    monthQuarter = MONTHS[mq[1]];
  }

  const saysFullYear = /\b(full[-\s]?year|fiscal year|for the year|annual)\b/.test(t)
    || (/\bfiscal\s*\d/.test(t) && quarter === null && monthQuarter === null)
    || (/\bfy\s?\d/.test(t) && quarter === null && monthQuarter === null);

  /* ---- 4. A bare date is not a period ----
     Added after "May 2, 2026" resolved to a full year: the four digits at the
     end are a year, the year-only rule claimed it, and a stray date lifted out
     of a statement heading became an annual label. A date names a day. Only
     "ended" turns it into a period, and that is handled above. */

  if (dateMatch && !quarter && !monthQuarter && !saysFullYear) {
    return {
      period: null,
      why: "This is a date, not a period. A date only names a period when the text says what ended on it.",
    };
  }

  /* ---- 5. The year ---- */

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

  if (year !== null) {
    const refYear = new Date(reference).getUTCFullYear();
    if (Math.abs(year - refYear) > 3) {
      return {
        period: null,
        why: "The year read from this text (" + year + ") is too far from the filing date to be the period it describes.",
      };
    }
  }

  /* ---- 6. Halves and other spans we do not score ---- */
  if (!quarter && !monthQuarter && /\b(first|second|1st|2nd)\s+half\b|\bh[12]\b|\b[12]h\b/.test(t)) {
    return { period: null, why: "A half-year is not a period this scores." };
  }

  /* ---- 7. Put it together ---- */

  if (monthQuarter) {
    // The calendar year the named month falls in. Stated if present, otherwise
    // the nearest one in the direction of travel.
    const calYear = year !== null
      ? year
      : nearestMonthYear(monthQuarter, reference, direction);

    const iso = calYear + "-" + String(monthQuarter).padStart(2, "0")
      + "-" + String(lastDayOf(monthQuarter, calYear)).padStart(2, "0");
    const pos = fiscalPosition(iso, cal.fye);
    return {
      period: (pos.endsIn - cal.labelOffset) + "Q" + pos.quarter,
      how: "quarter named by the month it ends in (" + iso + ")",
    };
  }

  if (quarter && year !== null) {
    return { period: year + "Q" + quarter, how: "quarter and year both stated" };
  }

  if (quarter && year === null) {
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

/* How long is the period? Companies state it in months or in weeks, and
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

/** The calendar year of the nearest named month, looking back or forward. */
function nearestMonthYear(month, referenceMs, direction) {
  const refYear = new Date(referenceMs).getUTCFullYear();
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const end = Date.UTC(y, month - 1, lastDayOf(month, y));
    if (direction === "past" && end <= referenceMs) {
      const next = Date.UTC(y + 1, month - 1, lastDayOf(month, y + 1));
      if (next > referenceMs) return y;
    }
    if (direction === "future" && end > referenceMs) return y;
  }
  return refYear;
}

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
 * The only comparison the matcher is allowed to make. Identical or nothing -
 * no tolerance, no nearest match. The near misses are exactly the dangerous
 * ones: a full-year guide against a first-quarter actual looks plausible and
 * is nonsense.
 */
export function samePeriod(a, b) {
  return Boolean(a) && Boolean(b) && a === b;
}
