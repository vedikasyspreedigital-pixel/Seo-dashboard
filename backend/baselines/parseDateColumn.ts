// Deterministic, plain-code date-label parsing -- this is the one part of
// the baseline import flow with no human override step (per the explicit
// "auto-detect the newest date, don't ask the user to pick" requirement),
// so it stays hand-rolled and unit-tested rather than delegated to a model
// or to engine-specific Date.parse leniency alone.

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Handles the formats actually seen in the wild for this feature: ordinal
 * day-month-year text ("31st August 2026", "17th August 2026" -- the exact
 * format in the sample report this was built against), plain day-month-year
 * ("31 August 2026"), and numeric day/month/year ("31/08/2026",
 * "31-08-2026", day-first per this app's UAE/agency domain) or ISO
 * ("2026-08-31"). Returns null rather than guessing when the format isn't
 * recognized -- an unparseable column is simply not a candidate baseline
 * date, not a crash.
 */
export function parseDateLabel(raw: string): Date | null {
  const cleaned = raw.trim().replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
  if (cleaned === "") return null;

  const dayMonthYear = cleaned.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dayMonthYear) {
    const [, day, monthName, year] = dayMonthYear;
    const monthIndex = MONTHS.findIndex((m) => m.startsWith(monthName.toLowerCase()) && monthName.length >= 3);
    if (monthIndex >= 0) {
      const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
      if (isValidCalendarDate(date, Number(year), monthIndex, Number(day))) return date;
    }
    return null;
  }

  const isoOrNumeric = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoOrNumeric) {
    const [, year, month, day] = isoOrNumeric;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (isValidCalendarDate(date, Number(year), Number(month) - 1, Number(day))) return date;
    return null;
  }

  const slashOrDash = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashOrDash) {
    const [, day, month, year] = slashOrDash; // day-first, per this app's domain
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (isValidCalendarDate(date, Number(year), Number(month) - 1, Number(day))) return date;
    return null;
  }

  return null;
}

// Date.UTC silently rolls over out-of-range values (e.g. day 32) into the
// next month instead of erroring -- reject those rather than accept a
// technically-non-null but wrong date.
function isValidCalendarDate(date: Date, year: number, monthIndex: number, day: number): boolean {
  return date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex && date.getUTCDate() === day;
}

export interface DateColumn {
  label: string;
}

/**
 * Picks the column with the maximum parsed date -- the ONLY selection rule
 * for the baseline date, applied with no human override. Returns null if
 * none of the given labels parse as a date at all.
 */
export function pickNewestDateColumn<T extends DateColumn>(columns: T[]): { column: T; date: Date } | null {
  let best: { column: T; date: Date } | null = null;
  for (const column of columns) {
    const date = parseDateLabel(column.label);
    if (!date) continue;
    if (!best || date.getTime() > best.date.getTime()) best = { column, date };
  }
  return best;
}
