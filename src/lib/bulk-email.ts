import { PaymentStatus, RegistrationStatus, SessionRole, SpeakerStatus } from "@prisma/client";
import crypto from "crypto";
import { z } from "zod";
import { db } from "./db";
import { apiLogger } from "./logger";
import { hashVerificationToken } from "./security";
import {
  sendEmail,
  getEventTemplate,
  getDefaultTemplate,
  renderAndWrap,
  brandingFrom,
  brandingCc,
  type EmailBranding,
} from "./email";
import {
  buildSpeakerEmailContext,
  generateSpeakerAgreementDocx,
  generateSpeakerAgreementPdf,
  pickAgreementAttachmentMode,
  SPEAKER_AGREEMENT_DOCX_MIME,
  SPEAKER_AGREEMENT_PDF_MIME,
} from "./speaker-agreement";
import { buildEntryBarcode, templateUsesEntryBarcode } from "./email-barcode";
import { getTitleLabel } from "./utils";
import {
  DEFAULT_SURVEY_EXPIRY_DAYS,
  DAY_MS,
  surveyExpiryDaysSchema,
  type SurveyExpiryDays,
} from "./survey/share-link";

// ───────────────────────── Types ─────────────────────────

export type BulkEmailRecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

export type BulkEmailType =
  | "invitation"
  | "agreement"
  | "confirmation"
  | "reminder"
  | "custom"
  | "abstract-accepted"
  | "abstract-rejected"
  | "abstract-revision"
  | "abstract-reminder"
  | "webinar-confirmation"
  | "webinar-reminder-24h"
  | "webinar-reminder-1h"
  | "webinar-live-now"
  | "webinar-thank-you"
  /**
   * Post-event feedback survey invitation. Per-recipient token mint
   * (`survey:{regId}`) writes a `VerificationToken` and injects the
   * raw URL as `{{surveyLink}}`. Restricted to `registrations`
   * recipient type — speakers/reviewers/abstracts have no
   * Registration-bound survey.
   */
  | "survey-invitation"
  /**
   * Send a saved custom email template (one an organizer created under
   * Communications → Email Templates that is NOT one of the system
   * defaults). The specific template is identified by
   * `filters.templateSlug`; the body/subject come from that active
   * `EmailTemplate` row via `getEventTemplate`. Renders with the same
   * per-recipient variables as the built-in templated sends. Works for
   * every recipient type. This is the bridge that makes an active custom
   * template selectable + sendable from the bulk-email dialog and the
   * Communications page (custom templates were previously creatable but
   * orphaned — no send path referenced them).
   */
  | "template";

export const WEBINAR_EMAIL_TYPES = [
  "webinar-confirmation",
  "webinar-reminder-24h",
  "webinar-reminder-1h",
  "webinar-live-now",
  "webinar-thank-you",
] as const;

export function isWebinarEmailType(t: string): boolean {
  return (WEBINAR_EMAIL_TYPES as readonly string[]).includes(t);
}

export interface BulkEmailAttachment {
  name: string;
  content: string; // base64
  contentType?: string;
  /**
   * Inline image content-id. When set, the attachment is referenced from the
   * HTML body as `cid:<contentId>` (used by the entry-barcode token) instead
   * of being a downloadable attachment.
   */
  contentId?: string;
}

export interface BulkEmailFilters {
  /** RegistrationStatus filter (PENDING/CONFIRMED/CANCELLED/WAITLISTED/CHECKED_IN) — registrations recipient only */
  status?: string;
  /**
   * PaymentStatus filter (UNPAID/PAID/PENDING/COMPLIMENTARY/UNASSIGNED/REFUNDED/FAILED).
   * Registrations recipient only. Closes W2-F4 — the unpaid-chase
   * workflow (`paymentStatus=UNPAID`) was previously blocked at the
   * bulk-send endpoint and operators had to send to a broader
   * audience or fall back to external tools.
   */
  paymentStatus?: string;
  ticketTypeId?: string;
  /**
   * Speakers recipient only — filter on signed agreement state.
   *   "signed"   → `Speaker.agreementAcceptedAt IS NOT NULL`
   *   "unsigned" → `Speaker.agreementAcceptedAt IS NULL`
   */
  agreementSigned?: "signed" | "unsigned";
  /**
   * Speakers recipient only — filter on whether the speaker is assigned
   * to at least one EventSession via SessionSpeaker.
   *   "yes" → has at least one session
   *   "no"  → has no sessions
   */
  hasSession?: "yes" | "no";
  /**
   * Speakers recipient only — SessionRole filter
   * (SPEAKER/MODERATOR/CHAIRPERSON/PANELIST). Setting this implies the
   * speaker has at least one session in that role.
   */
  sessionRole?: SessionRole;
  /**
   * survey-invitation email type only — TTL (days) for the minted
   * survey link token (3/5/7/10, default 7). Rides inside `filters`
   * rather than a top-level param so it survives the schedule→worker
   * round trip (the worker reconstructs the send from the persisted
   * ScheduledEmail.filters JSON; a top-level param would silently fall
   * back to the default on scheduled sends).
   */
  surveyExpiryDays?: SurveyExpiryDays;
  /**
   * `emailType: "template"` only — slug of the saved custom EmailTemplate
   * to send. Rides inside `filters` (rather than a top-level param) for
   * the same reason as `surveyExpiryDays`: the scheduled-send worker
   * reconstructs the send from the persisted `ScheduledEmail.filters`
   * JSON, so riding here makes immediate + scheduled sends identical with
   * NO new column and NO worker change. Resolved via
   * `getEventTemplate(eventId, templateSlug)`, which returns the row only
   * when it is active — an inactive/missing custom template is rejected.
   */
  templateSlug?: string;
}

export interface BulkEmailInput {
  eventId: string;
  recipientType: BulkEmailRecipientType;
  recipientIds?: string[];
  emailType: BulkEmailType;
  customSubject?: string;
  customMessage?: string;
  attachments?: BulkEmailAttachment[];
  filters?: BulkEmailFilters;
  organizerName: string;
  organizerEmail: string;
  organizerSignature?: string;
  /** Optional audit context threaded into EmailLog rows. */
  organizationId?: string | null;
  triggeredByUserId?: string | null;
}

export interface BulkEmailResult {
  total: number;
  successCount: number;
  failureCount: number;
  errors: Array<{ email: string; error: string }>;
}

export class BulkEmailError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Shared Zod schema reused by both immediate-send and schedule routes
export const bulkEmailSchema = z.object({
  recipientType: z.enum(["speakers", "registrations", "reviewers", "abstracts"]),
  recipientIds: z.array(z.string().max(100)).optional(),
  emailType: z.enum([
    "invitation",
    "agreement",
    "confirmation",
    "reminder",
    "custom",
    "abstract-accepted",
    "abstract-rejected",
    "abstract-revision",
    "abstract-reminder",
    "webinar-confirmation",
    "webinar-reminder-24h",
    "webinar-reminder-1h",
    "webinar-live-now",
    "webinar-thank-you",
    "survey-invitation",
    "template",
  ]),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().max(255),
        content: z.string(),
        contentType: z.string().max(100).optional(),
      })
    )
    .max(5)
    .optional(),
  filters: z
    .object({
      status: z.string().max(50).optional(),
      // May be a single PaymentStatus or a comma-separated list (multi-value,
      // e.g. the Welcome-Paid tile sends PAID,COMPLIMENTARY,INCLUSIVE).
      paymentStatus: z.string().max(200).optional(),
      ticketTypeId: z.string().max(100).optional(),
      agreementSigned: z.enum(["signed", "unsigned"]).optional(),
      hasSession: z.enum(["yes", "no"]).optional(),
      sessionRole: z.nativeEnum(SessionRole).optional(),
      surveyExpiryDays: surveyExpiryDaysSchema.optional(),
      templateSlug: z.string().min(1).max(100).optional(),
    })
    .optional(),
}).superRefine((data, ctx) => {
  // A saved-template send must carry the slug to load. Enforced at the
  // schema layer so both the immediate route and the schedule route
  // reject a malformed payload before persisting a ScheduledEmail row.
  if (data.emailType === "template" && !data.filters?.templateSlug) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["filters", "templateSlug"],
      message: "filters.templateSlug is required when emailType is \"template\"",
    });
  }
});

const speakerStatusSchema = z.nativeEnum(SpeakerStatus);
const registrationStatusSchema = z.nativeEnum(RegistrationStatus);
const paymentStatusSchema = z.nativeEnum(PaymentStatus);

/**
 * Parse a `filters.paymentStatus` value into a list of valid PaymentStatus
 * enums. Accepts a single value ("PAID") or a comma-separated multi-value list
 * ("PAID,COMPLIMENTARY,INCLUSIVE", e.g. the Welcome-Paid tile). Whitespace is
 * trimmed and anything that isn't a real PaymentStatus (incl. "all") is
 * dropped — so an empty result means "no payment filter".
 */
export function parsePaymentStatusFilter(value: string | undefined): PaymentStatus[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => paymentStatusSchema.safeParse(v))
    .flatMap((r) => (r.success ? [r.data] : []));
}

// Max total attachment size: 10MB
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

// ───────────────────────── Helper ─────────────────────────

interface ResolvedRecipient {
  id: string;
  email: string;
  additionalEmail?: string | null;
  firstName: string;
  lastName: string;
  /**
   * Raw Title enum value from the DB ("DR" / "PROF" / "MR" / "MRS" / "MS") or
   * null. Formatted to "Dr." / "Prof." / "Mr." etc. via getTitleLabel() at
   * render time — keeps the recipient row faithful to the DB while letting
   * one helper own the enum→display mapping (same as sendRegistrationConfirmation).
   * Reviewers come from the User table which has no title column, so always null
   * there.
   */
  title?: string | null;
  ticketType?: string;
  serialId?: number | null;
  /**
   * Entry barcode + attendance mode — registrations recipients only, used to
   * render the {{entryBarcode}} token per recipient. Null/absent for
   * speakers/reviewers/abstracts (they have no entry barcode).
   */
  qrCode?: string | null;
  attendanceMode?: "IN_PERSON" | "VIRTUAL" | null;
}

/**
 * Resolves recipients, loads template, renders per-recipient, and dispatches in batches.
 * Used by both the immediate-send route and the cron worker for scheduled sends.
 *
 * Throws BulkEmailError on validation failures (e.g. event missing, no recipients).
 * Per-recipient send failures are captured in the result.errors array, not thrown.
 */
export async function executeBulkEmail(input: BulkEmailInput): Promise<BulkEmailResult> {
  const {
    eventId,
    recipientType,
    recipientIds,
    emailType,
    customSubject,
    customMessage,
    attachments,
    filters,
    organizerName,
    organizerEmail,
    organizerSignature,
    organizationId,
    triggeredByUserId,
  } = input;

  // Speaker-agreement bulk sends need either an uploaded .docx template OR
  // inline agreement HTML on the event — fail fast before resolving
  // recipients so we don't half-process and stress email rate limits.
  const needsAgreementAttachment = emailType === "agreement" && recipientType === "speakers";

  // Custom emails need both subject and message. This is a batch-wide
  // misconfiguration — checking it inside the per-recipient loop produces
  // N copies of the same error in `result.errors`, so hoist it here.
  if (emailType === "custom" && (!customSubject || !customMessage)) {
    throw new BulkEmailError("Custom emails require subject and message", 400);
  }

  // Survey invitations only make sense for `registrations` — speakers /
  // reviewers / abstracts have no Registration-bound survey to fill out.
  // Hoist the check so a misconfigured tile fails fast rather than
  // sending N broken emails with empty {{surveyLink}} placeholders.
  if (emailType === "survey-invitation" && recipientType !== "registrations") {
    throw new BulkEmailError(
      "Survey invitations can only be sent to registrations",
      400,
    );
  }

  // Validate attachment size
  if (attachments?.length) {
    const totalSize = attachments.reduce((sum, a) => sum + a.content.length, 0);
    if (totalSize > MAX_ATTACHMENT_SIZE) {
      throw new BulkEmailError("Total attachment size exceeds 10MB limit", 400);
    }
  }

  // Only fetch the columns we render into the email — avoids dragging back HTML
  // template fields, banner image, terms HTML, etc.
  // Include per-event sender fields + email branding so the `from` address
  // respects the event's configured sender (not just provider defaults).
  const event = await db.event.findFirst({
    where: { id: eventId },
    select: {
      id: true,
      slug: true,
      name: true,
      startDate: true,
      venue: true,
      address: true,
      settings: true,
      emailFromAddress: true,
      emailFromName: true,
      emailCcAddresses: true,
      emailHeaderImage: true,
      emailFooterImage: true,
      emailFooterHtml: true,
      speakerAgreementTemplate: true,
      speakerAgreementHtml: true,
      // surveyConfig — null if no survey is configured. Used by the
      // "survey-invitation" branch as a precondition (we won't mint
      // tokens for an event that has no survey for the recipient to
      // fill out).
      surveyConfig: true,
    },
  });
  if (!event) {
    throw new BulkEmailError("Event not found", 404);
  }

  const agreementMode = needsAgreementAttachment
    ? pickAgreementAttachmentMode({
        hasDocxTemplate: Boolean(event.speakerAgreementTemplate),
        hasInlineHtml: Boolean(event.speakerAgreementHtml?.trim()),
      })
    : null;

  if (needsAgreementAttachment && !agreementMode) {
    throw new BulkEmailError(
      "Upload a .docx template or add inline agreement HTML (Event → Content → Speaker Agreement) before sending agreement emails.",
      400,
    );
  }

  // Second survey precondition: the event must actually have a survey
  // built. We could let the per-recipient public link 404 instead, but
  // failing the bulk send up-front is friendlier to the operator and
  // doesn't waste a per-recipient SES quota slice.
  if (emailType === "survey-invitation") {
    const sc = event.surveyConfig;
    if (!Array.isArray(sc) || sc.length === 0) {
      throw new BulkEmailError(
        "No survey is configured for this event. Build the survey at Survey first.",
        400,
      );
    }
  }

  // App URL for building public links — same fallback chain as the
  // send-completion-emails route so behavior is identical on EC2 +
  // dev. Used to construct {{surveyLink}} per recipient.
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000";

  const eventDate = event.startDate
    ? new Date(event.startDate).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "TBA";
  const eventVenue = event.venue || "TBA";

  // ── Resolve recipients ──
  let recipients: ResolvedRecipient[] = [];

  if (recipientType === "reviewers") {
    const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] })?.reviewerUserIds ?? [];
    if (reviewerUserIds.length === 0) {
      throw new BulkEmailError("No reviewers assigned to this event", 400);
    }
    const reviewerUsers = await db.user.findMany({
      where: {
        id: {
          in: recipientIds?.length
            ? recipientIds.filter((id) => reviewerUserIds.includes(id))
            : reviewerUserIds,
        },
        role: "REVIEWER",
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    recipients = reviewerUsers.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
    }));
  } else if (recipientType === "speakers") {
    const parsedStatus = filters?.status ? speakerStatusSchema.safeParse(filters.status) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    // Tier-1 speaker filters: agreementSigned / hasSession / sessionRole.
    // sessionRole implies hasSession=yes naturally (the SessionSpeaker
    // join is required for either) so we let them combine without a
    // dedicated conflict check — Prisma ANDs them.
    const agreementWhere =
      filters?.agreementSigned === "signed"
        ? { agreementAcceptedAt: { not: null } }
        : filters?.agreementSigned === "unsigned"
          ? { agreementAcceptedAt: null }
          : {};
    const sessionWhere = filters?.sessionRole
      ? { sessions: { some: { role: filters.sessionRole } } }
      : filters?.hasSession === "yes"
        ? { sessions: { some: {} } }
        : filters?.hasSession === "no"
          ? { sessions: { none: {} } }
          : {};
    const speakers = await db.speaker.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(status && { status }),
        ...agreementWhere,
        ...sessionWhere,
      },
      select: { id: true, email: true, additionalEmail: true, firstName: true, lastName: true, title: true },
    });
    recipients = speakers.map((s) => ({
      id: s.id,
      email: s.email,
      additionalEmail: s.additionalEmail,
      firstName: s.firstName,
      lastName: s.lastName,
      title: s.title,
    }));
  } else if (recipientType === "abstracts") {
    const abstracts = await db.abstract.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(filters?.status ? { status: filters.status as never } : {}),
      },
      select: {
        id: true,
        speaker: { select: { email: true, additionalEmail: true, firstName: true, lastName: true, title: true } },
      },
    });
    const seen = new Set<string>();
    for (const a of abstracts) {
      if (!seen.has(a.speaker.email)) {
        seen.add(a.speaker.email);
        recipients.push({
          id: a.id,
          email: a.speaker.email,
          additionalEmail: a.speaker.additionalEmail,
          firstName: a.speaker.firstName,
          lastName: a.speaker.lastName,
          title: a.speaker.title,
        });
      }
    }
  } else {
    const parsedStatus = filters?.status ? registrationStatusSchema.safeParse(filters.status) : null;
    const status = parsedStatus?.success ? parsedStatus.data : undefined;
    // paymentStatus may be a single value or a comma-separated multi-value
    // list (e.g. the Welcome-Paid tile → PAID,COMPLIMENTARY,INCLUSIVE).
    const paymentStatuses = parsePaymentStatusFilter(filters?.paymentStatus);
    const registrations = await db.registration.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(status && { status }),
        ...(paymentStatuses.length === 1
          ? { paymentStatus: paymentStatuses[0] }
          : paymentStatuses.length > 1
            ? { paymentStatus: { in: paymentStatuses } }
            : {}),
        ...(filters?.ticketTypeId ? { ticketTypeId: filters.ticketTypeId } : {}),
      },
      select: {
        id: true,
        serialId: true,
        qrCode: true,
        attendanceMode: true,
        ticketType: { select: { name: true } },
        attendee: { select: { email: true, additionalEmail: true, firstName: true, lastName: true, title: true } },
      },
    });
    recipients = registrations.map((r) => ({
      id: r.id,
      email: r.attendee.email,
      additionalEmail: r.attendee.additionalEmail,
      firstName: r.attendee.firstName,
      lastName: r.attendee.lastName,
      title: r.attendee.title,
      ticketType: r.ticketType?.name,
      serialId: r.serialId,
      qrCode: r.qrCode,
      attendanceMode: r.attendanceMode,
    }));
  }

  if (recipients.length === 0) {
    throw new BulkEmailError("No recipients found matching the criteria", 400);
  }

  // ── Load template ──
  // The 5 supported types map directly to template slugs.
  //
  // The 4 abstract-* types are accepted by the schema for forward-compat with
  // the abstracts-list page, but the bulk helper cannot enrich per-recipient
  // abstract context (abstractTitle, newStatus, reviewNotes…). Sending them
  // through this path would render emails with empty {{abstractTitle}}
  // placeholders, so we reject them explicitly. Send abstract status updates
  // from the abstract detail route instead, where the Abstract row is in scope.
  const slugMap: Partial<Record<BulkEmailType, string>> = {
    invitation: "speaker-invitation",
    agreement: "speaker-agreement",
    confirmation: "registration-confirmation",
    reminder: "event-reminder",
    custom: "custom-notification",
    "webinar-confirmation": "webinar-confirmation",
    "webinar-reminder-24h": "webinar-reminder-24h",
    "webinar-reminder-1h": "webinar-reminder-1h",
    "webinar-live-now": "webinar-live-now",
    "webinar-thank-you": "webinar-thank-you",
    "survey-invitation": "survey-invitation",
  };
  // Resolve the template slug. A "template" send carries a custom slug in
  // filters.templateSlug and loads the active EmailTemplate directly; every
  // other type maps to a fixed system slug.
  const isCustomTemplate = emailType === "template";
  let templateSlug: string;
  if (isCustomTemplate) {
    if (!filters?.templateSlug) {
      // The schema's superRefine already guards this at both routes; kept
      // here so direct (non-route) callers can't slip a malformed send by.
      throw new BulkEmailError("A saved-template send requires filters.templateSlug", 400);
    }
    templateSlug = filters.templateSlug;
  } else {
    const mapped = slugMap[emailType];
    if (!mapped) {
      throw new BulkEmailError(
        `Bulk send for "${emailType}" is not supported — send from the abstract detail page instead`,
        400
      );
    }
    templateSlug = mapped;
  }

  // For a custom template there is NO system default to fall back to, so an
  // inactive or missing custom slug must hard-fail (don't blast a batch with
  // an empty body). getEventTemplate already returns null for an inactive or
  // missing row; the explicit `null` makes the no-fallback intent clear.
  const tpl =
    (await getEventTemplate(eventId, templateSlug)) ||
    (isCustomTemplate ? null : getDefaultTemplate(templateSlug));
  if (!tpl) {
    throw new BulkEmailError(
      isCustomTemplate
        ? `Saved template "${templateSlug}" was not found or is inactive — activate it under Communications → Email Templates`
        : `Email template not found for slug: ${templateSlug}`,
      isCustomTemplate ? 400 : 500
    );
  }

  // Entry-barcode token: render the per-recipient {{entryBarcode}} image only
  // when the template body carries the token (organizer opt-in). For
  // non-registration audiences the token can't resolve (they have no qrCode),
  // so log once that it did nothing rather than silently dropping it.
  const templateWantsBarcode = templateUsesEntryBarcode(tpl.htmlContent, tpl.textContent);
  if (templateWantsBarcode && recipientType !== "registrations") {
    apiLogger.warn({
      msg: "bulk-email:entry-barcode-unavailable",
      eventId,
      recipientType,
      count: recipients.length,
    });
  }

  const daysUntil = event.startDate
    ? Math.max(
        1,
        Math.ceil((new Date(event.startDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      )
    : 1;

  // Event-level branding: prefer the explicit branding shipped with a rendered
  // event template (e.g. from /api/templates/preview), else build one from the
  // event columns we just fetched. The from/name fields are what power
  // `brandingFrom()` — without them `sendEmail` falls back to provider defaults
  // and hits "Forbidden" if the default sender isn't authorized.
  const branding: EmailBranding =
    "branding" in tpl
      ? (tpl as { branding: EmailBranding }).branding
      : {
          eventName: event.name,
          emailFromAddress: event.emailFromAddress,
          emailFromName: event.emailFromName,
          emailCcAddresses: event.emailCcAddresses ?? [],
          emailHeaderImage: event.emailHeaderImage,
          emailFooterImage: event.emailFooterImage,
          emailFooterHtml: event.emailFooterHtml,
        };

  // ── Webinar enrichment ────────────────────────────────────────────
  // For webinar-* types, look up the anchor session + ZoomMeeting ONCE
  // (not per recipient) and inject join URL / passcode / recording into vars.
  let webinarEnrichment: {
    joinUrl: string;
    passcode: string;
    webinarDate: string;
    webinarTime: string;
    recordingUrl: string;
    passcodeBlockHtml: string;
    passcodeBlockText: string;
    recordingBlockHtml: string;
    recordingBlockText: string;
  } | null = null;

  if (isWebinarEmailType(emailType)) {
    const webinarSettings = (event.settings as { webinar?: { sessionId?: string } } | null)?.webinar;
    const anchorSessionId = webinarSettings?.sessionId;
    if (!anchorSessionId) {
      throw new BulkEmailError(
        "Webinar email requested but event has no anchor session. Run the webinar provisioner first.",
        400,
      );
    }
    const [anchorSession, zoomMeeting] = await Promise.all([
      db.eventSession.findFirst({
        where: { id: anchorSessionId, eventId },
        select: { startTime: true, endTime: true },
      }),
      db.zoomMeeting.findUnique({
        where: { sessionId: anchorSessionId },
        select: {
          joinUrl: true,
          passcode: true,
          recordingUrl: true,
          recordingPassword: true,
          recordingStatus: true,
        },
      }),
    ]);
    if (!zoomMeeting) {
      throw new BulkEmailError(
        "Webinar email requested but no Zoom webinar is attached to the anchor session.",
        400,
      );
    }
    const webinarDate = anchorSession?.startTime
      ? new Date(anchorSession.startTime).toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "TBA";
    const webinarTime = anchorSession?.startTime
      ? new Date(anchorSession.startTime).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        })
      : "TBA";
    const passcode = zoomMeeting.passcode ?? "";
    // Recording URL is only populated once the webinar has ended AND the
    // cron worker has successfully fetched it from Zoom. Until then, the
    // template renders a "coming soon" fallback via recordingBlock.
    const recordingUrl =
      zoomMeeting.recordingStatus === "AVAILABLE" && zoomMeeting.recordingUrl
        ? zoomMeeting.recordingUrl
        : "";
    webinarEnrichment = {
      joinUrl: zoomMeeting.joinUrl,
      passcode,
      webinarDate,
      webinarTime,
      recordingUrl,
      passcodeBlockHtml: passcode
        ? `<div style="text-align:center; margin:12px 0; color:#374151; font-size:14px;">Passcode: <strong style="font-family:monospace;">${passcode}</strong></div>`
        : "",
      passcodeBlockText: passcode ? `Passcode: ${passcode}` : "",
      recordingBlockHtml: recordingUrl
        ? `<div style="text-align:center; margin:20px 0;"><a href="${recordingUrl}" style="display:inline-block; background:#00aade; color:#ffffff; padding:12px 28px; border-radius:6px; text-decoration:none; font-weight:600;">Watch Replay</a></div>`
        : `<p style="color:#6b7280;">The recording will be available shortly. We'll send it to you as soon as it's ready.</p>`,
      recordingBlockText: recordingUrl
        ? `Watch replay: ${recordingUrl}`
        : "The recording will be available shortly. We'll send it to you as soon as it's ready.",
    };
  }

  // For speaker-targeted templates (invitation/agreement), build the rich
  // per-speaker context so greetings include the title prefix and the body
  // shows their actual sessions/topics/dates.
  const isSpeakerContextNeeded =
    recipientType === "speakers" && (emailType === "invitation" || emailType === "agreement");

  const generateEmailForRecipient = async (recipient: ResolvedRecipient) => {
    const vars: Record<string, string | number> = {
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      eventName: event.name,
      eventDate,
      eventVenue,
      eventAddress: event.address || "",
      organizerName,
      organizerEmail,
      organizerSignature: organizerSignature ?? "",
      personalMessage: customMessage || "",
      ticketType: recipient.ticketType || "General Admission",
      registrationId:
        recipient.serialId != null
          ? String(recipient.serialId).padStart(3, "0")
          : recipient.id.slice(-8).toUpperCase(),
      daysUntilEvent: daysUntil,
      // Title formatted via the same getTitleLabel helper used by every
      // other send-site (sendRegistrationConfirmation, buildSpeakerEmailContext).
      // For speaker-context branches (invitation/agreement), the override
      // below replaces this with ctx.title — same formatted shape, just
      // sourced from the Speaker row's enriched context.
      title: getTitleLabel(recipient.title),
      speakerName: `${recipient.firstName} ${recipient.lastName}`,
      presentationDetails: "",
      presentationDetailsText: "",
      sessionDetails: "",
      // Entry-barcode token defaults — overridden below for registrations
      // recipients when the template uses {{entryBarcode}} and the recipient
      // has a qrCode. Empty otherwise so the placeholder disappears.
      entryBarcode: "",
      entryBarcodeText: "",
    };

    if (isSpeakerContextNeeded) {
      const ctx = await buildSpeakerEmailContext(eventId, recipient.id);
      if (ctx) {
        vars.title = ctx.title;
        vars.speakerName = ctx.speakerName;
        vars.presentationDetails = ctx.presentationDetails;
        vars.presentationDetailsText = ctx.presentationDetailsText;
        vars.sessionDetails = ctx.sessionTitles.replace(/\n/g, ", ");
      }
    }

    if (emailType === "custom") {
      // Pre-flight already verified subject + message are present (see
      // hoisted check above the recipient resolve), so this is just
      // hydration of the per-recipient vars.
      vars.subject = customSubject!;
      vars.message = customMessage!;
    } else if (emailType === "template") {
      // A saved custom template defines its own subject + body, but may also
      // reference {{subject}} / {{message}} placeholders for an optional
      // per-send note. Both are optional here (the template, not the
      // operator, owns the content), so default to empty.
      vars.subject = customSubject ?? "";
      vars.message = customMessage ?? "";
    }

    if (emailType === "survey-invitation") {
      // Per-recipient token mint. Identifier is `survey:{regId}` —
      // matches the public survey route's prefix check. Old tokens for
      // the same registration are removed first so a re-send produces
      // exactly one live link (no resend confusion if the operator
      // clicks the tile twice on the same audience). TTL is operator-
      // configurable (3/5/7/10 days) via filters.surveyExpiryDays,
      // defaulting to 7. It rides inside `filters` so scheduled sends
      // honor it too (the worker rebuilds the send from the persisted
      // ScheduledEmail.filters JSON).
      //
      // We mint INSIDE generateEmailForRecipient so an aborted batch
      // doesn't leave orphan VerificationToken rows for recipients we
      // never managed to email. Each per-recipient try/catch keeps
      // the failure isolated.
      await db.verificationToken.deleteMany({
        where: { identifier: `survey:${recipient.id}` },
      });
      const rawToken = crypto.randomBytes(32).toString("hex");
      const hashedToken = hashVerificationToken(rawToken);
      const surveyExpiryDays: SurveyExpiryDays =
        filters?.surveyExpiryDays ?? DEFAULT_SURVEY_EXPIRY_DAYS;
      await db.verificationToken.create({
        data: {
          identifier: `survey:${recipient.id}`,
          token: hashedToken,
          expires: new Date(Date.now() + surveyExpiryDays * DAY_MS),
        },
      });
      vars.surveyLink = `${appUrl}/e/${event.slug}/survey?token=${rawToken}`;
    }

    if (webinarEnrichment) {
      vars.joinUrl = webinarEnrichment.joinUrl;
      vars.passcode = webinarEnrichment.passcode;
      vars.webinarDate = webinarEnrichment.webinarDate;
      vars.webinarTime = webinarEnrichment.webinarTime;
      vars.recordingUrl = webinarEnrichment.recordingUrl;
      vars.passcodeBlock = webinarEnrichment.passcodeBlockHtml;
      vars.passcodeBlockText = webinarEnrichment.passcodeBlockText;
      vars.recordingBlock = webinarEnrichment.recordingBlockHtml;
      vars.recordingBlockText = webinarEnrichment.recordingBlockText;
    }

    // Per-recipient entry barcode for the {{entryBarcode}} token — only for
    // registrations recipients with a qrCode (virtual / non-registration
    // recipients leave the token empty). Render failure is non-fatal: log and
    // send without the barcode rather than dropping the whole email.
    let barcodeAttachment: BulkEmailAttachment | undefined;
    if (templateWantsBarcode && recipientType === "registrations" && recipient.qrCode) {
      try {
        const bc = await buildEntryBarcode({
          qrCode: recipient.qrCode,
          attendanceMode: recipient.attendanceMode,
        });
        if (bc) {
          vars.entryBarcode = bc.html;
          vars.entryBarcodeText = bc.text;
          barcodeAttachment = bc.attachment;
        }
      } catch (err) {
        apiLogger.warn({
          msg: "bulk-email:entry-barcode-render-failed",
          eventId,
          registrationId: recipient.id,
          err,
        });
      }
    }

    return {
      ...renderAndWrap(
        tpl,
        vars,
        branding,
        new Set([
          "presentationDetails",
          "organizerSignature",
          "personalMessage",
          "passcodeBlock",
          "recordingBlock",
        ]),
      ),
      barcodeAttachment,
    };
  };

  // ── Send in batches of 25 ──
  const BATCH_SIZE = 25;
  let successCount = 0;
  let failureCount = 0;
  const errors: Array<{ email: string; error: string }> = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (recipient) => {
        try {
          const emailContent = await generateEmailForRecipient(recipient);

          // Per-recipient personalized attachment for speaker agreements.
          // Precedence: explicit .docx upload wins; else inline HTML → PDF.
          let recipientAttachments: BulkEmailAttachment[] | undefined = attachments;
          // Inline entry-barcode image (cid:reg-barcode) when the template's
          // {{entryBarcode}} token resolved for this recipient.
          if (emailContent.barcodeAttachment) {
            recipientAttachments = [
              ...(recipientAttachments ?? []),
              emailContent.barcodeAttachment,
            ];
          }
          if (agreementMode === "docx") {
            const doc = await generateSpeakerAgreementDocx({
              eventId,
              speakerId: recipient.id,
            });
            if (!doc) {
              throw new Error("Failed to generate agreement document");
            }
            const personalizedAttachment: BulkEmailAttachment = {
              name: doc.filename,
              content: doc.buffer.toString("base64"),
              contentType: SPEAKER_AGREEMENT_DOCX_MIME,
            };
            recipientAttachments = attachments
              ? [...attachments, personalizedAttachment]
              : [personalizedAttachment];
          } else if (agreementMode === "pdf") {
            const doc = await generateSpeakerAgreementPdf({
              eventId,
              speakerId: recipient.id,
            });
            if (!doc) {
              throw new Error("Failed to generate agreement PDF");
            }
            const personalizedAttachment: BulkEmailAttachment = {
              name: doc.filename,
              content: doc.buffer.toString("base64"),
              contentType: SPEAKER_AGREEMENT_PDF_MIME,
            };
            recipientAttachments = attachments
              ? [...attachments, personalizedAttachment]
              : [personalizedAttachment];
          }

          const bulkEntityType =
            recipientType === "speakers"
              ? ("SPEAKER" as const)
              : recipientType === "registrations"
                ? ("REGISTRATION" as const)
                : recipientType === "reviewers"
                  ? ("USER" as const)
                  : ("OTHER" as const);
          const result = await sendEmail({
            to: [{ email: recipient.email, name: `${recipient.firstName} ${recipient.lastName}` }],
            cc: brandingCc(branding, [{ email: recipient.email }], [recipient.additionalEmail]),
            subject: emailContent.subject,
            htmlContent: emailContent.htmlContent,
            textContent: emailContent.textContent,
            attachments: recipientAttachments,
            from: brandingFrom(branding),
            replyTo:
              (recipientType === "speakers" || recipientType === "reviewers") && organizerEmail
                ? { email: organizerEmail, name: organizerName }
                : undefined,
            // CloudWatch metric keys: emailType picks up whatever the
            // Communications-page send chose (registration_confirmation /
            // payment_reminder / speaker_invitation / abstract_reminder /
            // agreement / custom etc.) — sanitized server-side. Stream is
            // ALWAYS "bulk" here so bounce/complaint reputation alerts on
            // the Communications page don't pollute transactional metrics.
            emailType: emailType.replace(/-/g, "_"),
            stream: "bulk",
            logContext: {
              organizationId: organizationId ?? null,
              eventId,
              entityType: bulkEntityType,
              entityId: recipient.id,
              templateSlug: `bulk-${emailType}`,
              triggeredByUserId: triggeredByUserId ?? null,
            },
          });
          return { recipient, result };
        } catch (error) {
          apiLogger.error({
            err: error,
            msg: "Failed to send email to recipient",
            email: recipient.email,
          });
          return {
            recipient,
            result: {
              success: false,
              error: error instanceof Error ? error.message : "Failed to send email",
            },
          };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        const { recipient, result: emailResult } = r.value;
        if (emailResult.success) {
          successCount++;
        } else {
          failureCount++;
          errors.push({ email: recipient.email, error: emailResult.error || "Unknown error" });
        }
      } else {
        // Should not normally happen — the inner try/catch returns a fulfilled
        // value for any per-recipient failure. If we land here it means the
        // promise rejected before reaching the inner try (e.g. synchronous
        // throw in generateEmailForRecipient). Surface it loudly.
        failureCount++;
        apiLogger.error({ err: r.reason, msg: "bulk-email:batch-promise-rejected" });
      }
    }
  }

  return {
    total: recipients.length,
    successCount,
    failureCount,
    errors,
  };
}
