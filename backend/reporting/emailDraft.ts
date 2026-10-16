// The email draft: a fixed, editable template -- no AI, no external call, no
// validation layer needed (a deterministic template can't produce invalid
// output). The SEO team edits the subject/body themselves before approving;
// this only fills in a sensible, professional starting point with the real
// reporting period dates.

import { formatOrdinalDate } from "./formatOrdinalDate.js";

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

const SIGNATURE = `Thanks and Regards,
TEAM SySpree
SySpree Digital Pvt. Limited
SySpree Digital PTE. Limited
India | Singapore
Email: support@syspreesolutions.com`;

/** Fills the standard client-facing template with the real reporting period -- same dates shown on the PDF (generateClientReportPdf.ts formats them identically). */
export function buildDefaultEmailDraft({ clientName, periodStart, periodEnd }: EmailDraftInput): EmailDraftOutput {
  const start = formatOrdinalDate(periodStart);
  const end = formatOrdinalDate(periodEnd);

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

export type EmailVariant = "regular" | "ga";
export const EMAIL_VARIANTS: EmailVariant[] = ["regular", "ga"];

/**
 * The Google Analytics version of the template (the agency's own wording,
 * 2026-10-16): same subject and period as the regular draft, but it also
 * mentions the attached Google Analytics reports (Traffic Acquisition and
 * Engagement Overview). The GA numbers are not in the dashboard, so they are
 * left as [bracketed] placeholders the SEO team replaces before approving.
 */
export function buildGaEmailDraft({ clientName, periodStart, periodEnd }: EmailDraftInput): EmailDraftOutput {
  const start = formatOrdinalDate(periodStart);
  const end = formatOrdinalDate(periodEnd);

  const bodyText = `Dear Client,

We are pleased to share with you the website ranking report for ${start} - ${end}. This report summarizes the development and performance of the search engine rankings for your website during this period.

We would like to emphasize that various variables might affect search engine results, such as user behavior, competition, algorithm upgrades, and website design. However, we've been working hard to optimize your website and improve its standing in search engine rankings.

We would be glad to receive your feedback on how these efforts have impacted your business. Please find the attached ranking report and Google Analytics reports (Traffic Acquisition and Engagement Overview).

The Google Analytics reports show [organic search users] organic search users and [event count] event counts for [month].

Thank you for your continued trust and partnership.

${SIGNATURE}`;

  return {
    subject: `${clientName} Keyword Ranking Report ${start} - ${end}`,
    bodyText,
  };
}

/** The draft for a report's chosen template. */
export function buildEmailDraft(variant: string | null | undefined, input: EmailDraftInput): EmailDraftOutput {
  return variant === "ga" ? buildGaEmailDraft(input) : buildDefaultEmailDraft(input);
}
