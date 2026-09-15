/**
 * The approval emails, as one pure builder: assignment, reminder, delegation,
 * escalation, and the decision back to the requester.
 *
 * The spec's rule shapes every one of them: the decision is taken on the
 * Approvals page in EA-SYS, and the email only says something is waiting,
 * with a link. So there is no approve button here, deliberately, and the
 * approver emails say so in words.
 *
 * Every dynamic string is escaped: a request title, a note and a person's
 * name are all typed by someone. Client-safe and db-free, so the wording is
 * pinned by a unit test rather than discovered in an inbox.
 */
import { escapeHtml } from "@/lib/html";

export type ApprovalEmailKind = "assigned" | "escalated" | "reminder" | "delegated" | "decided";

export interface ApprovalEmailInput {
  kind: ApprovalEmailKind;
  recipientFirstName: string | null;
  /** "budget", "spend request", ... as `subjectWordFor` returns it. */
  subjectWord: string;
  /** "HM2026 v2 · Hematology Summit", "PR-2026-0004 · LED wall". */
  subjectLabel: string;
  /** "AED 36,000.00", or "USD 9,800.00 (AED 36,000.00)". */
  amountLine: string;
  requesterName: string | null;
  /** Who the request was waiting on (delegated, escalated). */
  previousApproverName?: string | null;
  hoursWaiting?: number;
  exception?: boolean;
  decision?: "APPROVED" | "REJECTED";
  deciderName?: string | null;
  note?: string | null;
  /** Absolute URL, or null when the app URL is not configured. */
  link: string | null;
}

export function waitedPhrase(hours: number): string {
  const h = Math.max(0, Math.floor(hours));
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return `${Math.floor(h / 24)} days`;
}

export function subjectWordFor(subjectType: string, payloadKind?: string | null): string {
  if (subjectType === "BUDGET") return "budget";
  if (subjectType === "BUDGET_REALLOCATION") return "move between budget lines";
  if (subjectType === "SPEND_REQUEST") return payloadKind === "AMENDMENT" ? "change to a spend request's amount" : "spend request";
  return "request";
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

const APPROVER_FOOTER = "Decide it on the Approvals page in EA-SYS. This email is only a notification and cannot approve anything.";

export function buildApprovalEmail(input: ApprovalEmailInput): { subject: string; html: string; text: string } {
  const hi = `Hi ${input.recipientFirstName?.trim() || "there"},`;
  const requester = input.requesterName?.trim() || "A colleague";
  const previous = input.previousApproverName?.trim() || "the approver it was assigned to";
  const waited = waitedPhrase(input.hoursWaiting ?? 0);
  const word = input.subjectWord;
  const label = input.subjectLabel;

  let subject: string;
  let lead: string;
  let cta = "Open the Approvals page";
  let footer: string | null = APPROVER_FOOTER;

  switch (input.kind) {
    case "assigned":
      subject = `Approval needed: ${label}`;
      lead = `${requester} has asked for approval of ${article(word)} ${word}.`;
      break;
    case "escalated":
      subject = `Approval passed to you: ${label}`;
      lead = `This ${word} from ${requester} waited ${waited} without a decision from ${previous}, so it now comes to you.`;
      break;
    case "reminder":
      subject = `Reminder, waiting on your approval: ${label}`;
      lead = `This ${word} from ${requester} has been waiting ${waited} for your decision.`;
      break;
    case "delegated":
      subject = `You can now approve: ${label}`;
      lead = `This ${word} from ${requester} has waited ${waited} for ${previous}, so it has been passed to you as well. Either of you can decide it.`;
      break;
    case "decided": {
      const approved = input.decision === "APPROVED";
      const decider = input.deciderName?.trim() || "The approver";
      subject = `${approved ? "Approved" : "Rejected"}: ${label}`;
      lead = `${decider} ${approved ? "approved" : "rejected"} your ${word}.`;
      cta = "Open it in EA-SYS";
      footer = null;
      break;
    }
  }

  const exceptionLine = input.exception ? "Over-budget exception: only the final approver decides it." : null;
  const note = input.kind === "decided" && input.note?.trim() ? input.note.trim() : null;

  const html = [
    `<p>${escapeHtml(hi)}</p>`,
    `<p>${escapeHtml(lead)}</p>`,
    `<p style="padding:12px 16px;border-left:3px solid #00aade;background:#f6fbfd;"><strong>${escapeHtml(label)}</strong><br/>${escapeHtml(input.amountLine)}${exceptionLine ? `<br/>${escapeHtml(exceptionLine)}` : ""}</p>`,
    note ? `<p><span style="color:#666;">Note:</span> ${escapeHtml(note)}</p>` : "",
    footer ? `<p>${escapeHtml(footer)}</p>` : "",
    input.link ? `<p><a href="${escapeHtml(input.link)}">${escapeHtml(cta)}</a></p>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const text = [hi, "", lead, "", label, input.amountLine, exceptionLine ?? "", note ? `Note: ${note}` : "", footer ?? "", input.link ? `${cta}: ${input.link}` : ""]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();

  return { subject, html, text };
}
