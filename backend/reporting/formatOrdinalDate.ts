// Shared by emailDraft.ts (Subject/Body) and generateClientReportPdf.ts (the
// PDF header) so the client-facing date format can never drift between the
// email and the attached report -- exactly the class of mismatch this app
// has already hit once (see the report-period consistency investigation).

/** 1st, 2nd, 3rd, 4th...11th-13th are always "th", everything else follows the last digit. */
function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** e.g. "17th August 2026" -- the client-facing convention already used in report/baseline filenames (e.g. "17th August 2026 - 31st August 2026.xlsx"). */
export function formatOrdinalDate(date: Date): string {
  const day = date.getDate();
  const month = date.toLocaleDateString("en-US", { month: "long" });
  const year = date.getFullYear();
  return `${day}${ordinalSuffix(day)} ${month} ${year}`;
}
