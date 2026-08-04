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
import { db } from "@/lib/db";
import { getTitleLabel, formatPersonName } from "@/lib/utils";
import { normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { PRESENTATION_TYPE_LABELS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";

const REVIEW_STATUSES = new Set(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface SendAbstractSubmissionConfirmationParams {
  eventId: string;
  /** Organization that owns the event — threaded into the EmailLog row. */
  organizationId?: string | null;
  eventName: string;
  abstractId: string;
  abstractTitle: string;
  /** Per-event serial (A-###); null on pre-migration legacy rows → renders blank. */
  serialId: number | null;
  speaker: {
    id: string;
    email: string | null;
    additionalEmail?: string | null;
    firstName: string;
    lastName: string;
    title?: string | null;
  };
  triggeredByUserId?: string;
  /**
   * Manual-resend only: the resending organizer's saved signature HTML
   * ({{organizerSignature}} renders empty on the automated sends, per the
   * July-16 rule — automated paths never fabricate a signature).
   */
  organizerSignature?: string | null;
}

/**
 * Sends the `abstract-submission-confirmation` email to the submitting
 * speaker. ONE implementation for all three callers (create POST, resubmit
 * PUT, manual resend route) — the create/resubmit pair used to carry two
 * inline copies that had already drifted (the resubmit copy silently dropped
 * presentationType/theme/authorName/coAuthorNames, so those tokens rendered
 * blank on resubmission emails).
 *
 * Self-fetches presentationType / theme / co-authors by abstractId (the
 * notifyAbstractStatusChange pattern) so callers don't thread them through.
 * Never throws; returns false on any failure so a manual-resend caller can
 * surface a 502 while the automated callers stay fire-and-forget.
 */
export async function sendAbstractSubmissionConfirmation(
  params: SendAbstractSubmissionConfirmationParams,
): Promise<boolean> {
  const { eventId, organizationId, eventName, abstractId, abstractTitle, serialId, speaker } = params;

  if (!speaker.email) {
    apiLogger.warn({ msg: "abstract-submission-confirmation:no-speaker-email", eventId, abstractId });
    return false;
  }

  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const details = await db.abstract
      .findUnique({
        where: { id: abstractId },
        select: { presentationType: true, coAuthors: true, theme: { select: { name: true } } },
      })
      .catch(() => null);

    const vars: Record<string, string> = {
      title: getTitleLabel(speaker.title),
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      eventName,
      // "" (not "—") on legacy serial-less rows — the template hides the row.
      abstractNumber: serialId != null ? formatAbstractSerial(serialId) : "",
      abstractTitle,
      presentationType: details?.presentationType
        ? PRESENTATION_TYPE_LABELS[details.presentationType] ?? details.presentationType
        : "",
      theme: details?.theme?.name ?? "",
      authorName: formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
      coAuthorNames: normalizeCoAuthors(details?.coAuthors)
        .map((c) => `${c.firstName} ${c.lastName}`)
        .join(", "),
      managementLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/events")}`,
      ...(params.organizerSignature ? { organizerSignature: params.organizerSignature } : {}),
    };

    const eventTpl = await getEventTemplate(eventId, "abstract-submission-confirmation");
    const tpl = eventTpl || getDefaultTemplate("abstract-submission-confirmation");
    if (!tpl) {
      apiLogger.warn({ msg: "No template found for abstract-submission-confirmation", eventId, abstractId });
      return false;
    }
    const branding = eventTpl?.branding || { eventName };
    const rendered = renderAndWrap(tpl, vars, branding);
    const result = await sendEmail({
      to: [{ email: speaker.email, name: `${speaker.firstName} ${speaker.lastName}` }],
      cc: brandingCc(branding, [{ email: speaker.email }], [speaker.additionalEmail]),
      ...rendered,
      from: brandingFrom(branding),
      emailType: "abstract_submission_confirmation",
      stream: "transactional",
      logContext: {
        organizationId: organizationId ?? null,
        eventId,
        entityType: "SPEAKER",
        entityId: speaker.id,
        templateSlug: "abstract-submission-confirmation",
        triggeredByUserId: params.triggeredByUserId,
      },
    });
    if (!result.success) {
      apiLogger.error({ msg: "abstract-submission-confirmation:send-failed", eventId, abstractId, error: result.error });
      return false;
    }
    return true;
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to send abstract submission confirmation email", eventId, abstractId });
    return false;
  }
}

export interface NotifyAbstractStatusChangeParams {
  eventId: string;
  /**
   * Organization that owns the event. Threaded into the EmailLog row's
   * `organizationId` so the Email History card on the speaker detail
   * sheet finds it (see src/lib/email-log.ts history note on the
   * 8-caller missing-organizationId bug). Optional for back-compat
   * with callers that haven't been updated; null-org rows are still
   * visible via the relaxed read filter, but tagging is best.
   */
  organizationId?: string | null;
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
    /**
     * Raw Title enum ("DR"/"PROF"/...) or null. Optional so existing
     * callers that haven't been updated keep working (title renders as
     * empty string then). Formatted via getTitleLabel at render time.
     */
    title?: string | null;
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
    organizationId,
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

    // Self-fetch the abstract's presentation type / theme / co-authors so the
    // email vars resolve without every caller threading them through.
    const details = await db.abstract
      .findUnique({
        where: { id: abstractId },
        select: { presentationType: true, coAuthors: true, theme: { select: { name: true } } },
      })
      .catch(() => null);
    const presentationTypeLabel = details?.presentationType
      ? PRESENTATION_TYPE_LABELS[details.presentationType] ?? details.presentationType
      : "";
    const themeName = details?.theme?.name ?? "";
    const coAuthorNames = normalizeCoAuthors(details?.coAuthors)
      .map((c) => `${c.firstName} ${c.lastName}`)
      .join(", ");
    const authorName = formatPersonName(speaker.title, speaker.firstName, speaker.lastName);

    const statusInfo = getAbstractStatusInfo(newStatus);
    const reviewNotesHtml = reviewNotes
      ? `<div style="background: #e0f2fe; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9; margin: 20px 0;"><strong>Reviewer Notes:</strong><br><span style="white-space: pre-wrap;">${escapeHtml(reviewNotes)}</span></div>`
      : "";

    const vars: Record<string, string | number | undefined> = {
      title: getTitleLabel(speaker.title),
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      eventName,
      abstractTitle,
      presentationType: presentationTypeLabel,
      theme: themeName,
      authorName,
      coAuthorNames,
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
          emailType: "abstract_status_update",
          stream: "transactional",
          logContext: {
            organizationId: organizationId ?? null,
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
