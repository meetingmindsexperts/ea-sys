/**
 * Where one assigned person stands on the certificate recipients report
 * (Nov 11, 2026): the states, their plain-word labels, and the one rule that
 * picks a state from the facts.
 *
 * Client-safe: no database import, so the dashboard reads the same labels and
 * hints the export and the agent use. The report itself (and its queries) is
 * recipients-report.ts.
 */

/** Where one assigned person stands. */
export const RECIPIENT_STATES = [
  "SENT",
  "ISSUED_NOT_SENT",
  "SENDING",
  "WAITING_FOR_SURVEY",
  "READY",
  "FAILED",
  "REVOKED",
  "CANCELLED",
] as const;
export type RecipientState = (typeof RECIPIENT_STATES)[number];

export const RECIPIENT_STATE_LABELS: Record<RecipientState, string> = {
  SENT: "Sent",
  ISSUED_NOT_SENT: "Issued, not sent yet",
  SENDING: "Sending",
  WAITING_FOR_SURVEY: "Waiting for survey",
  READY: "Ready to issue",
  FAILED: "Could not send",
  REVOKED: "Revoked",
  CANCELLED: "Registration cancelled",
};

/** What the organiser should understand, and do, for each state. */
export const RECIPIENT_STATE_HINTS: Record<RecipientState, string> = {
  SENT: "The certificate was emailed or handed over.",
  ISSUED_NOT_SENT: "The certificate is made and waits in an issue run for you to send it.",
  SENDING: "On its way: it goes out within a few minutes.",
  WAITING_FOR_SURVEY: "It is sent automatically once they answer the certificate survey.",
  READY: "Nothing sends it on its own: use Issue to send it.",
  FAILED: "Automatic sending gave up after several tries. Use Issue to send it.",
  REVOKED: "The certificate was taken back.",
  CANCELLED: "A cancelled registration is never sent a certificate.",
};

export interface RecipientStateFacts {
  registrationCancelled: boolean;
  certificate: { revoked: boolean; released: boolean } | null;
  /** The template's "send when the survey is answered" switch. */
  autoIssueOnSurvey: boolean;
  surveyAnswered: boolean;
  /** The survey sweep has looked at the person since they answered. */
  sweepChecked: boolean;
  /** ...and gave up on them with an error. */
  sweepFailed: boolean;
  /** A run that has not finished covers this person and template. */
  inRun: boolean;
}

/**
 * One state per assigned person. Pure, no database.
 *
 * A certificate that exists speaks first, whatever happened to the
 * registration since. With none: a cancelled registration never gets one; a
 * run in flight is about to send it; a template without the switch waits for
 * a manual Issue; with the switch it waits for the survey, then for the next
 * sweep. Answered, looked at and still nothing sent means the sweep will not
 * come back on its own (it predates the assignment list, or gave up): Issue.
 */
export function recipientState(f: RecipientStateFacts): RecipientState {
  if (f.certificate?.revoked) return "REVOKED";
  if (f.certificate) return f.certificate.released ? "SENT" : "ISSUED_NOT_SENT";
  if (f.registrationCancelled) return "CANCELLED";
  if (f.inRun) return "SENDING";
  if (!f.autoIssueOnSurvey) return "READY";
  if (!f.surveyAnswered) return "WAITING_FOR_SURVEY";
  if (f.sweepFailed) return "FAILED";
  return f.sweepChecked ? "READY" : "SENDING";
}
