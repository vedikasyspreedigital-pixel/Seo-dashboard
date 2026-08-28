// The email-sending boundary, kept behind an interface exactly like
// DataForSEO's CallDataForSeoFn -- callers (approveAndSend.ts) never know
// or care whether they're talking to a real provider or a mock.

export interface SendEmailParams {
  to: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  // ClickUp-delivery concerns. Optional and ignored by senders that don't
  // need them (mock, plain SMTP/provider) -- only the ClickUp sender reads
  // these. clickupTaskUrl is resolved the same way `to` is: from
  // ClientReportConfig at draft time, never decided by Claude or by this
  // function's caller.
  clickupTaskUrl?: string;
  attachmentHtml?: string;
  attachmentFilename?: string;
  // The actual ranking Excel (re-patched with current row state, same file
  // a user would get from "Download Excel"), converted to PDF -- resolved
  // by approveAndSendReport from the report's run, not by the caller.
  excelPdfBuffer?: Buffer;
  excelPdfFilename?: string;
}

export interface SendEmailResult {
  messageId: string;
}

export type SendEmailFn = (params: SendEmailParams) => Promise<SendEmailResult>;

/**
 * REAL sender -- deliberately unimplemented. No email provider has been
 * chosen or configured (no SMTP host, no provider API key), so this
 * throws rather than silently no-op-ing or guessing a vendor. Nothing in
 * this codebase calls this function; server.ts always injects the mock
 * until a provider is actually selected.
 */
export async function sendEmailLive(_params: SendEmailParams): Promise<SendEmailResult> {
  throw new Error(
    "No email provider is configured. sendEmailLive is a placeholder -- replace its body once a provider is chosen, and inject it explicitly in place of the mock.",
  );
}
