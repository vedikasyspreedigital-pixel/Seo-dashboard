// The email draft: a fixed, editable template -- no AI, no external call, no
// validation layer needed (a deterministic template can't produce invalid
// output). The SEO team edits the subject/body themselves before approving;
// this only fills in a sensible, professional starting point with the real
// reporting period dates.

export interface EmailDraftInput {
  clientName: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface EmailDraftOutput {
  subject: string;
  bodyText: string;
  bodyHtml?: string;
}

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

/** e.g. "17th August 2026" -- matches the client-facing convention already used in report/baseline filenames (e.g. "17th August 2026 - 31st August 2026.xlsx") and the subject line clients expect. */
function formatDate(date: Date): string {
  const day = date.getDate();
  const month = date.toLocaleDateString("en-US", { month: "long" });
  const year = date.getFullYear();
  return `${day}${ordinalSuffix(day)} ${month} ${year}`;
}

const SIGNATURE = `Thanks and Regards,

TEAM SySpree

SySpree Digital Pvt. Limited
SySpree Digital PTE. Limited
India | Singapore

Email: support@syspreesolutions.com`;

/** Fills the standard client-facing template with the real reporting period -- same dates shown on the PDF (generateClientReportPdf.ts formats them identically). */
export function buildDefaultEmailDraft({ clientName, periodStart, periodEnd }: EmailDraftInput): EmailDraftOutput {
  const start = formatDate(periodStart);
  const end = formatDate(periodEnd);

  const bodyText = `Dear Client,

Pleased to attach your website ranking report for ${start} - ${end}. This report summarizes the development and performance of the search engine rankings for your website throughout this time.

We want to stress that there are a number of variables that might affect search engine results, such as user behavior, competition, algorithm upgrades, and website design. But we've been working hard to optimize your website and raise its standing in search engine rankings.

Thank you for your continued trust and partnership.

${SIGNATURE}`;

  return {
    subject: `${clientName} Keyword Ranking Report ${start} - ${end}`,
    bodyText,
  };
}
