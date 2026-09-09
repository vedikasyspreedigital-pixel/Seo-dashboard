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

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

const SIGNATURE = `Thanks and Regards,

TEAM SySpree

SySpree Digital Pvt. Limited
SySpree Digital PTE. Limited
India | Singapore

Email: support@syspreesolutions.com`;

/** Fills the standard client-facing template with the real reporting period -- same dates shown on the PDF (generateClientReportPdf.ts formats them identically). */
export function buildDefaultEmailDraft({ periodStart, periodEnd }: EmailDraftInput): EmailDraftOutput {
  const start = formatDate(periodStart);
  const end = formatDate(periodEnd);

  const bodyText = `Dear Client,

Pleased to attach your website ranking report for ${start} - ${end}. This report summarizes the development and performance of the search engine rankings for your website throughout this time.

We want to stress that there are a number of variables that might affect search engine results, such as user behavior, competition, algorithm upgrades, and website design. But we've been working hard to optimize your website and raise its standing in search engine rankings.

Thank you for your continued trust and partnership.

${SIGNATURE}`;

  return {
    subject: `SEO Ranking Report – ${start} to ${end}`,
    bodyText,
  };
}
