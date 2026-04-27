import { apiLogger } from "@/lib/logger";
import {
  sendEmail,
  getEventTemplate,
  getDefaultTemplate,
  renderAndWrap,
  getAbstractStatusInfo,
  brandingFrom,
  brandingCc,
} from "@/lib/email";
import { notifyEventAdmins } from "@/lib/notifications";

const REVIEW_STATUSES = new Set(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface NotifyAbstractStatusChangeParams {
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  abstractId: string;
  abstractTitle: string;
  previousStatus: string;
  newStatus: string;
  reviewNotes: string | null;
  reviewScore: number | null;
  speaker: {
    id?: string;
    email: string | null;
    additionalEmail?: string | null;
    firstName: string;
    lastName: string;
  };
  /** When true, treats this as feedback-only (notes/score changed without a status transition). */
  feedbackOnly?: boolean;
}

/**
 * Sends the `abstract-status-update` email to the speaker and fires the admin
 * notification. Safe to call whether status changed, feedback was added, or
 * both. No-ops if neither condition is met or the speaker has no email.
 *
 * Called from the dashboard PUT handler and the AI agent `update_abstract_status`
 * tool so both entry points produce identical side effects.
 */
export async function notifyAbstractStatusChange(params: NotifyAbstractStatusChangeParams): Promise<void> {
  const {
    eventId,
    eventName,
    eventSlug,
    abstractId,
    abstractTitle,
    previousStatus,
    newStatus,
    reviewNotes,
    reviewScore,
    speaker,
    feedbackOnly = false,
  } = params;

  const isReview = !feedbackOnly && REVIEW_STATUSES.has(newStatus) && newStatus !== previousStatus;
  const shouldNotify = isReview || feedbackOnly;
  if (!shouldNotify) return;

  if (speaker.email) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const managementLink = eventSlug
      ? `${appUrl}/e/${eventSlug}/login?redirect=abstracts`
      : `${appUrl}/login?callbackUrl=${encodeURIComponent("/events")}`;

    const statusInfo = getAbstractStatusInfo(newStatus);
    const reviewNotesHtml = reviewNotes
      ? `<div style="background: #e0f2fe; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9; margin: 20px 0;"><strong>Reviewer Notes:</strong><br><span style="white-space: pre-wrap;">${escapeHtml(reviewNotes)}</span></div>`
      : "";

    const vars: Record<string, string | number | undefined> = {
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      eventName,
      abstractTitle,
      newStatus: newStatus.replace(/_/g, " "),
      statusHeading: feedbackOnly ? "Reviewer Feedback Received" : statusInfo.heading,
      statusMessage: feedbackOnly
        ? "A reviewer has provided feedback on your abstract. Log in to view the details."
        : statusInfo.message,
      reviewNotes: reviewNotesHtml,
      reviewScore: reviewScore ?? undefined,
      managementLink,
    };

    try {
      const tpl = await getEventTemplate(eventId, "abstract-status-update");
      const t = tpl || getDefaultTemplate("abstract-status-update");
      if (!t) {
        apiLogger.warn({ msg: "No template found for abstract-status-update", eventId, abstractId });
      } else {
        const branding = tpl?.branding || { eventName };
        const rendered = renderAndWrap(t, vars, branding);
        await sendEmail({
          to: [{ email: speaker.email, name: `${speaker.firstName} ${speaker.lastName}` }],
          cc: brandingCc(
            branding,
            [{ email: speaker.email }],
            [speaker.additionalEmail],
          ),
          ...rendered,
          from: brandingFrom(branding),
          logContext: {
            eventId,
            entityType: speaker.id ? "SPEAKER" : "OTHER",
            entityId: speaker.id ?? null,
            templateSlug: "abstract-status-update",
          },
        });
      }
    } catch (err) {
      apiLogger.error({ err, msg: "Failed to send abstract notification email", eventId, abstractId });
    }
  }

  try {
    await notifyEventAdmins(eventId, {
      type: "REVIEW",
      title: "Abstract Reviewed",
      message: `Abstract "${abstractTitle}" reviewed${reviewScore != null ? ` — Score: ${reviewScore}/100` : ""}`,
      link: `/events/${eventId}/abstracts`,
    });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to send abstract review admin notification", eventId, abstractId });
  }
}
