"use client";

import { toast } from "sonner";
import type { SendInvitationsOutcome } from "@/hooks/use-api";
import { sendInvitationsReport, type SendReportLevel } from "@/app/(dashboard)/events/[eventId]/reviewers/send-report";

/** A failure stays until closed; a warning long enough to read; a success the usual few seconds. */
const SEND_REPORT_DURATION: Record<SendReportLevel, number | undefined> = { error: Infinity, warning: 15000, info: undefined, success: undefined };

/**
 * Every outcome of one reviewer invitation send in ONE toast, the worst first
 * (see send-report.ts for why one). `sentTo` is the people the send was meant
 * to reach, so anyone it did not get to can be named.
 *
 * Lived in the Reviewers page until Nov 19, 2026, when the invitation moved
 * into the email dialog, which both that page and Communications open.
 */
export function reportSendInvitations(res: SendInvitationsOutcome, sentTo: { userId: string; name: string }[]): void {
  const { level, lines } = sendInvitationsReport(res, sentTo);
  const [title, ...rest] = lines;
  toast[level](title, {
    duration: SEND_REPORT_DURATION[level],
    description: rest.length > 0 ? <div className="space-y-1">{rest.map((line) => <p key={line}>{line}</p>)}</div> : undefined,
  });
}
