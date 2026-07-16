import { AbstractStatus, PaymentStatus, Prisma, RegistrationStatus, SessionRole, SpeakerStatus } from "@prisma/client";
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
  renderMessageValue,
  brandingFrom,
  brandingCc,
  type EmailBranding,
} from "./email";
import {
  buildAgreementBlock,
  buildSpeakerEmailContext,
  generateSpeakerAgreementDocx,
  generateSpeakerAgreementPdf,
  mintSpeakerAgreementLink,
  pickAgreementAttachmentMode,
  templateUsesAgreementBlock,
  SPEAKER_AGREEMENT_DOCX_MIME,
  SPEAKER_AGREEMENT_PDF_MIME,
} from "./speaker-agreement";
import { buildEntryBarcode, templateUsesEntryBarcode } from "./email-barcode";
import { EXCLUDE_FACULTY_WHERE } from "./faculty-filter";
import { getTitleLabel } from "./utils";
import { buildPaymentReminderVars } from "./payment-reminder";
import {
  DEFAULT_SURVEY_EXPIRY_DAYS,
  DAY_MS,
  surveyExpiryDaysSchema,
  type SurveyExpiryDays,
} from "./survey/share-link";
import {
  CANCELLED_EXCLUDED_EMAIL_TYPES,
  excludesCancelledByDefault,
} from "./bulk-email-audience";
import { loadCertTemplate, type LoadedCertTemplate } from "./certificates/bundle";
import { executeCertificateBulkSend } from "./certificates/bulk-issue";

// ───────────────────────── Types ─────────────────────────

export type BulkEmailRecipientType = "speakers" | "registrations" | "reviewers" | "abstracts";

export type BulkEmailType =
  | "invitation"
  | "agreement"
  | "confirmation"
  | "reminder"
  | "payment-reminder"
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
  | "template"
  /**
   * Issue + email certificates: for each recipient, tag-filter the selected
   * `filters.certificateTemplateIds` (a recipient only gets certs whose
   * template tag they hold — same routing as survey auto-issue), issue-or-
   * reuse real IssuedCertificate records, and send ONE email with every
   * applicable PDF attached. Registrations/speakers recipient types only.
   * Bypasses the slugMap/renderAndWrap pipeline — delegated to
   * executeCertificateBulkSend (src/lib/certificates/bulk-issue.ts).
   */
  | "certificate";

/**
 * The client-safe audience module stores its list as plain strings (it must not
 * import anything from this Prisma-bound file). This assignment is the compile-
 * time tether: a typo, or a send type that is later renamed, fails the build
 * here rather than silently ceasing to exclude CANCELLED registrations.
 */
const _cancelledExcludedAreRealEmailTypes: readonly BulkEmailType[] =
  CANCELLED_EXCLUDED_EMAIL_TYPES;
void _cancelledExcludedAreRealEmailTypes;

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
  /** Single ticket-type filter (legacy / tile pass-through). Prefer `ticketTypeIds`. */
  ticketTypeId?: string;
  /**
   * Registrations recipient only — send only to registrations on ANY of these
   * ticket types (Prisma `in`). Multi-select. Takes precedence over the single
   * `ticketTypeId` when present.
   */
  ticketTypeIds?: string[];
  /**
   * Registrations recipient only — send only to registrations whose
   * `Registration.badgeType` is ANY of these (Prisma `in`). Empty / absent =
   * no badge filter. Multi-select.
   */
  badgeTypes?: string[];
  /**
   * Registrations recipient only — send only to attendees whose
   * `Attendee.tags` include ANY of these tags (Prisma `hasSome`). Empty /
   * absent = no tag filter. The "filter by tag" capability organizers asked
   * for; pairs naturally with a future `tagsExclude`.
   */
  tagsInclude?: string[];
  /**
   * Registrations recipient only — drop faculty companion registrations (the
   * hidden `isFaculty` ticket type). Lets an organizer email delegates only,
   * excluding speakers/faculty. Keyed on `ticketType.isFaculty` (robust to new
   * delegate types / null badges) via `EXCLUDE_FACULTY_WHERE`.
   */
  excludeFaculty?: boolean;
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
  /**
   * `emailType: "certificate"` only — the CertificateTemplate ids to issue
   * (1..5). Rides inside `filters` for the same schedule-compat reason as
   * `templateSlug`: the worker reconstructs the send from the persisted
   * `ScheduledEmail.filters` JSON, so immediate + scheduled sends stay
   * identical with NO new column and NO worker change. Each recipient only
   * receives the certs whose template TAG they hold.
   */
  certificateTemplateIds?: string[];
}

export interface BulkEmailInput {
  eventId: string;
  recipientType: BulkEmailRecipientType;
  recipientIds?: string[];
  emailType: BulkEmailType;
  customSubject?: string;
  customMessage?: string;
  /**
   * True when `customMessage` is trusted, already-sanitized HTML (the MCP /
   * in-app-agent `send_bulk_email` contract — the tool schema asks for "HTML
   * content" and the executor runs it through sanitizeHtml). Renders
   * `{{message}}` raw instead of escaped. The dashboard dialog's message is a
   * plain Textarea, so it stays escaped (the default). Review A1, July 16,
   * 2026: the MCP pipeline rewire (`6f5f6e9`) dropped the raw-HTML behavior
   * and every agent/n8n bulk email with markup rendered as literal source.
   * Server-internal flag — deliberately NOT in bulkEmailSchema.
   */
  customMessageIsHtml?: boolean;
  attachments?: BulkEmailAttachment[];
  filters?: BulkEmailFilters;
  organizerName: string;
  organizerEmail: string;
  organizerSignature?: string;
  /** Optional audit context threaded into EmailLog rows. */
  organizationId?: string | null;
  triggeredByUserId?: string | null;
  /**
   * Per-recipient send idempotency (review H1; extended to certificate sends
   * July 16, 2026 — review A4). Recipient ids already emailed by a prior run
   * of this send — skipped so a retry after a crash resumes instead of
   * re-emailing everyone. Also means an already-emailed recipient's survey
   * token is never re-minted (review M6).
   */
  alreadyEmailedKeys?: string[];
  /**
   * Called after each successfully-sent batch with that batch's recipient ids
   * so the caller can persist idempotency progress (the worker appends them to
   * ScheduledEmail.emailedKeys). Best-effort — a failure to record must not fail
   * the send (worst case: a retry re-sends a batch).
   */
  onBatchEmailed?: (keys: string[]) => Promise<void>;
}

export interface BulkEmailResult {
  total: number;
  successCount: number;
  failureCount: number;
  /**
   * Certificate sends only — recipients who matched the audience filters
   * but hold NONE of the selected templates' tags. Per the tag rule ("no
   * tag, no certificate") they are silently not emailed: expected routing,
   * not a failure, so they appear in neither successCount nor failureCount.
   */
  skippedCount?: number;
  errors: Array<{ email: string; error: string }>;
}

export class BulkEmailError extends Error {
  status: number;
  /**
   * Optional machine-readable code so callers can branch on a specific
   * failure without matching the message string. Currently used for
   * "NO_RECIPIENTS" so the scheduled-email worker can treat an empty
   * audience at fire time as a benign skip (not a paging FAILED) while the
   * immediate-send route still surfaces it as a 400 to the operator.
   */
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Error code set on BulkEmailError when recipient resolution yields zero rows. */
export const NO_RECIPIENTS_CODE = "NO_RECIPIENTS";

/**
 * emailType → system template slug. Every sendable non-template, non-cert
 * type must appear here — a type accepted by the schema but absent from this
 * map cannot send and is rejected by precheckBulkEmailViability (review A2).
 *
 * The 4 abstract-* types are deliberately ABSENT: the bulk helper cannot
 * enrich per-recipient abstract context (abstractTitle, newStatus,
 * reviewNotes…), so sending them here would render emails with empty
 * placeholders. They stay in the schema for backward compat with persisted
 * ScheduledEmail rows, but new sends are rejected up-front. Send abstract
 * status updates from the abstract detail route instead.
 */
const BULK_EMAIL_TEMPLATE_SLUGS: Partial<Record<BulkEmailType, string>> = {
  invitation: "speaker-invitation",
  agreement: "speaker-agreement",
  confirmation: "registration-confirmation",
  reminder: "event-reminder",
  "payment-reminder": "payment-reminder",
  custom: "custom-notification",
  "webinar-confirmation": "webinar-confirmation",
  "webinar-reminder-24h": "webinar-reminder-24h",
  "webinar-reminder-1h": "webinar-reminder-1h",
  "webinar-live-now": "webinar-live-now",
  "webinar-thank-you": "webinar-thank-you",
  "survey-invitation": "survey-invitation",
};

const UNSUPPORTED_EMAIL_TYPE_MESSAGE = (emailType: string) =>
  `Bulk send for "${emailType}" is not supported — send abstract status updates from the abstract detail page instead`;

/**
 * Enqueue-time idempotency guard shared by the send-now + schedule routes
 * (review H2 for send-now; review C3 extended it to the schedule POST, which
 * previously had no dedup — a 502'd/double-clicked schedule request created
 * two identical PENDING rows that BOTH fired at the scheduled time).
 *
 * Best-effort value-equality match on a same-creator, same-content PENDING
 * row created in the last 2 minutes. Key-order differences in `filters` can
 * miss a dedup, but never merge two genuinely-different sends. Send-now mode
 * (scheduledFor: null) matches only send-now rows (scheduledFor ≈ now);
 * schedule mode matches only rows with the IDENTICAL scheduledFor — a retry
 * of the same POST carries the same timestamp, while two deliberate sends at
 * different times never collide.
 */
export async function findDuplicateQueuedSend(input: {
  eventId: string;
  createdById: string;
  recipientType: string;
  emailType: string;
  customSubject?: string | null;
  customMessage?: string | null;
  recipientIds?: string[] | null;
  filters?: unknown;
  /** null/undefined = send-now; a Date = a future-scheduled send. */
  scheduledFor?: Date | null;
}): Promise<{ id: string } | null> {
  const DEDUP_WINDOW_MS = 2 * 60 * 1000;
  const canonical = (v: unknown) => JSON.stringify(v ?? null);
  const incomingRecipientIds = canonical([...(input.recipientIds ?? [])].sort());
  const incomingFilters = canonical(input.filters ?? null);

  const dupCandidates = await db.scheduledEmail.findMany({
    where: {
      eventId: input.eventId,
      createdById: input.createdById,
      status: "PENDING",
      recipientType: input.recipientType,
      emailType: input.emailType,
      createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
      scheduledFor: input.scheduledFor
        ? { equals: input.scheduledFor }
        : // Send-now rows only (scheduledFor ≈ now) — never dedup against a
          // genuinely future-scheduled row that happens to match content.
          { lte: new Date(Date.now() + 60 * 1000) },
    },
    select: { id: true, customSubject: true, customMessage: true, recipientIds: true, filters: true },
  });

  return (
    dupCandidates.find(
      (r) =>
        (r.customSubject ?? null) === (input.customSubject ?? null) &&
        (r.customMessage ?? null) === (input.customMessage ?? null) &&
        canonical([...r.recipientIds].sort()) === incomingRecipientIds &&
        canonical(r.filters) === incomingFilters,
    ) ?? null
  );
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
    "payment-reminder",
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
    "certificate",
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
      ticketTypeIds: z.array(z.string().max(100)).max(50).optional(),
      badgeTypes: z.array(z.string().max(255)).max(50).optional(),
      tagsInclude: z.array(z.string().max(100)).max(50).optional(),
      excludeFaculty: z.boolean().optional(),
      agreementSigned: z.enum(["signed", "unsigned"]).optional(),
      hasSession: z.enum(["yes", "no"]).optional(),
      sessionRole: z.nativeEnum(SessionRole).optional(),
      surveyExpiryDays: surveyExpiryDaysSchema.optional(),
      templateSlug: z.string().min(1).max(100).optional(),
      certificateTemplateIds: z.array(z.string().min(1).max(100)).min(1).max(5).optional(),
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
  // A certificate send must carry the template set (mirror of the
  // templateSlug rule above — rejected before a ScheduledEmail persists).
  if (data.emailType === "certificate" && !data.filters?.certificateTemplateIds?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["filters", "certificateTemplateIds"],
      message: "filters.certificateTemplateIds is required when emailType is \"certificate\"",
    });
  }
});

const speakerStatusSchema = z.nativeEnum(SpeakerStatus);
const registrationStatusSchema = z.nativeEnum(RegistrationStatus);
const paymentStatusSchema = z.nativeEnum(PaymentStatus);
const abstractStatusSchema = z.nativeEnum(AbstractStatus);

/**
 * Parse a `filters.paymentStatus` value into a list of valid PaymentStatus
 * enums. Accepts a single value ("PAID") or a comma-separated multi-value list
 * ("PAID,COMPLIMENTARY,INCLUSIVE", e.g. the Welcome-Paid tile). Whitespace is
 * trimmed and anything that isn't a real PaymentStatus (incl. "all") is
 * dropped — so an empty result means "no payment filter".
 *
 * NOTE: silent dropping is safe ONLY because `assertValidBulkEmailFilters`
 * has already rejected any unknown value (review M7) — by the time this
 * runs, the only droppable token is the "all" sentinel.
 */
export function parsePaymentStatusFilter(value: string | undefined): PaymentStatus[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => paymentStatusSchema.safeParse(v))
    .flatMap((r) => (r.success ? [r.data] : []));
}

/** Error code set on BulkEmailError for an unparsable filter value (review M7). */
export const INVALID_FILTER_CODE = "INVALID_FILTER";

/** The no-filter sentinel some UI surfaces pass through ("All …" dropdowns). */
const isAllSentinel = (v: string) => v.trim().toLowerCase() === "all";

/**
 * Reject unparsable `filters.status` / `filters.paymentStatus` values instead
 * of silently dropping them (review M7, July 13 2026).
 *
 * Before this, a typo'd value ("CONFIRMD", "COMPLIMENTRY") failed its
 * safeParse, the predicate was silently omitted, and the send went to
 * **everyone** — and a payment-reminder with a bad status filter re-admitted
 * CANCELLED registrations. Unreachable from the dialog (valid enum values
 * only) but fully reachable via MCP / the REST API / a future tile, and it
 * violated the every-failure-logs rule.
 *
 * Pure + synchronous: called from `precheckBulkEmailViability`, so both the
 * enqueue and schedule routes 400 immediately, and `executeBulkEmail` (via
 * the precheck) fails a legacy persisted row loudly at fire time instead of
 * over-sending. The "all" sentinel passes through as "no filter".
 */
export function assertValidBulkEmailFilters(
  recipientType: string,
  filters: BulkEmailFilters | undefined,
): void {
  if (!filters) return;

  const invalid = (field: string, value: string, allowed: readonly string[]) => {
    throw new BulkEmailError(
      `Invalid ${field} filter value "${value}" — the send was rejected instead of silently widening the audience. Allowed: ${allowed.join(", ")}.`,
      400,
      INVALID_FILTER_CODE,
    );
  };

  if (filters.status && !isAllSentinel(filters.status)) {
    if (recipientType === "speakers" && !speakerStatusSchema.safeParse(filters.status).success) {
      invalid("status", filters.status, Object.values(SpeakerStatus));
    }
    if (recipientType === "registrations" && !registrationStatusSchema.safeParse(filters.status).success) {
      invalid("status", filters.status, Object.values(RegistrationStatus));
    }
    if (recipientType === "abstracts" && !abstractStatusSchema.safeParse(filters.status).success) {
      invalid("status", filters.status, Object.values(AbstractStatus));
    }
  }

  if (filters.paymentStatus) {
    const tokens = filters.paymentStatus.split(",").map((s) => s.trim()).filter(Boolean);
    for (const token of tokens) {
      // ANY invalid token rejects — "PAID,COMPLIMENTRY" must not silently
      // narrow to PAID any more than a fully-bad value may widen to everyone.
      if (!isAllSentinel(token) && !paymentStatusSchema.safeParse(token).success) {
        invalid("paymentStatus", token, Object.values(PaymentStatus));
      }
    }
  }
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
  /**
   * Pricing — registrations recipients only, consumed solely by the
   * payment-reminder branch (buildPaymentReminderVars) to render the amount-due
   * + Pay Now link. `originalPrice`/`discountAmount` are Prisma Decimals (or
   * null); the helper coerces via Number().
   */
  originalPrice?: unknown;
  discountAmount?: unknown;
  pricingTier?: { price: unknown; currency: string } | null;
  ticketTypePricing?: { price: unknown; currency: string } | null;
  /**
   * Speakers recipients only — drives the {{agreementBlock}} token (signed
   * speakers get an "already accepted" note instead of a Review & Agree CTA).
   */
  agreementAcceptedAt?: Date | null;
}

/** The subset of a bulk-email request needed to validate its config viability. */
export type BulkEmailViabilityInput = Pick<
  BulkEmailInput,
  "eventId" | "recipientType" | "emailType" | "customSubject" | "customMessage" | "attachments" | "filters"
>;

// The event columns rendered into an email (sender/branding/tax + the survey +
// agreement preconditions). Shared by the viability precheck and executeBulkEmail
// so the send loads the event exactly once.
const VIABILITY_EVENT_SELECT = {
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
  surveyConfig: true,
  taxRate: true,
  taxLabel: true,
} satisfies Prisma.EventSelect;

export type BulkEmailViabilityEvent = Prisma.EventGetPayload<{ select: typeof VIABILITY_EVENT_SELECT }>;

export interface BulkEmailViability {
  event: BulkEmailViabilityEvent;
  certTemplates: LoadedCertTemplate[] | null;
  agreementMode: ReturnType<typeof pickAgreementAttachmentMode> | null;
}

/**
 * Config-only viability checks — everything validatable WITHOUT resolving
 * recipients: recipient-type/emailType compatibility, custom subject+message,
 * attachment size, event existence, agreement-template presence, survey
 * configuration, and certificate-template existence + tagging. Throws
 * BulkEmailError (status + code) on the first failure; returns the loaded event
 * + cert templates + agreement mode so the caller doesn't re-load them.
 *
 * Called at the TOP of executeBulkEmail (the fire-time backstop) AND
 * synchronously by the enqueue + schedule routes (review M2), so an operator
 * gets an immediate 4xx for a misconfigured send instead of a green "queued"
 * toast followed by a FAILED ScheduledEmail row a minute later. ONE
 * implementation — the two call sites can't drift.
 */
export async function precheckBulkEmailViability(
  input: BulkEmailViabilityInput,
): Promise<BulkEmailViability> {
  const { eventId, recipientType, emailType, customSubject, customMessage, attachments, filters } = input;

  // Unparsable status/paymentStatus values are rejected up-front (review M7)
  // — dropping them silently widened the audience to everyone.
  assertValidBulkEmailFilters(recipientType, filters);

  // A2 (July 16, 2026): a type with no slug mapping (the 4 abstract-* types)
  // can NEVER send — reject it here, synchronously at the routes, instead of
  // returning 202 "queued" and flipping the row FAILED a minute later with an
  // error-level page. executeBulkEmail keeps its own check as the backstop.
  if (
    emailType !== "template" &&
    emailType !== "certificate" &&
    !BULK_EMAIL_TEMPLATE_SLUGS[emailType]
  ) {
    throw new BulkEmailError(UNSUPPORTED_EMAIL_TYPE_MESSAGE(emailType), 400);
  }

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
  if (emailType === "survey-invitation" && recipientType !== "registrations") {
    throw new BulkEmailError(
      "Survey invitations can only be sent to registrations",
      400,
    );
  }

  // Certificate sends: hoisted guards — recipient-type restriction + the
  // full template-set validation (exists, belongs to the event, tagged).
  let certTemplates: LoadedCertTemplate[] | null = null;
  if (emailType === "certificate") {
    if (recipientType !== "registrations" && recipientType !== "speakers") {
      throw new BulkEmailError(
        "Certificate emails can only be sent to registrations or speakers",
        400,
      );
    }
    // M3: a certificate must never be minted + emailed to a CANCELLED
    // registration — the invariant is unconditional. A non-CANCELLED explicit
    // status already excludes them and the no-status path adds the guard in
    // the where clause; the one hole is an explicit CANCELLED filter (freely
    // passable via REST/MCP/n8n, and the dashboard's "Cancelled Re-engagement"
    // tile), which is rejected here rather than silently minting certs.
    if (
      recipientType === "registrations" &&
      filters?.status &&
      !isAllSentinel(filters.status) &&
      filters.status.toUpperCase() === "CANCELLED"
    ) {
      throw new BulkEmailError(
        "Certificates cannot be sent to CANCELLED registrations. Remove the Cancelled status filter.",
        400,
        INVALID_FILTER_CODE,
      );
    }
    const certTemplateIds = filters?.certificateTemplateIds ?? [];
    if (certTemplateIds.length === 0) {
      // Schema superRefine guards this at both routes; kept for direct callers.
      throw new BulkEmailError("Select at least one certificate template", 400);
    }
    const loaded = await Promise.all(
      certTemplateIds.map((id) => loadCertTemplate(eventId, id)),
    );
    const missing = loaded.filter((t) => t === null).length;
    if (missing > 0) {
      throw new BulkEmailError(
        "One or more selected certificate templates no longer exist for this event",
        400,
      );
    }
    certTemplates = loaded as LoadedCertTemplate[];
    const untagged = certTemplates.filter((t) => !t.autoIssueTag?.trim());
    if (untagged.length > 0) {
      throw new BulkEmailError(
        `Certificate template${untagged.length > 1 ? "s" : ""} ${untagged
          .map((t) => `"${t.name}"`)
          .join(", ")} ha${untagged.length > 1 ? "ve" : "s"} no tag — set a tag on the template first (the tag decides who receives it)`,
        400,
      );
    }
  }

  // Validate attachment size
  if (attachments?.length) {
    const totalSize = attachments.reduce((sum, a) => sum + a.content.length, 0);
    if (totalSize > MAX_ATTACHMENT_SIZE) {
      throw new BulkEmailError("Total attachment size exceeds 10MB limit", 400);
    }
  }

  const event = await db.event.findFirst({
    where: { id: eventId },
    select: VIABILITY_EVENT_SELECT,
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

  // Second survey precondition: the event must actually have a survey built.
  if (emailType === "survey-invitation") {
    const sc = event.surveyConfig;
    if (!Array.isArray(sc) || sc.length === 0) {
      throw new BulkEmailError(
        "No survey is configured for this event. Build the survey at Survey first.",
        400,
      );
    }
  }

  return { event, certTemplates, agreementMode };
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
    customMessageIsHtml,
    attachments,
    filters,
    organizerName,
    organizerEmail,
    organizerSignature,
    organizationId,
    triggeredByUserId,
    alreadyEmailedKeys,
    onBatchEmailed,
  } = input;

  // Config viability — recipient-type/emailType compatibility, custom
  // subject+message, attachment size, event existence, agreement template,
  // survey configuration, certificate templates. Shared with the enqueue +
  // schedule routes (review M2) so a misconfigured send is rejected there
  // synchronously; this call is the fire-time backstop and also loads the
  // event + cert templates + agreement mode for the send below.
  const { event, certTemplates, agreementMode } = await precheckBulkEmailViability(input);

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
      select: {
        id: true,
        email: true,
        additionalEmail: true,
        firstName: true,
        lastName: true,
        title: true,
        // Drives {{agreementBlock}} — signed speakers get an "already
        // accepted" note instead of a fresh Review & Agree CTA.
        agreementAcceptedAt: true,
      },
    });
    recipients = speakers.map((s) => ({
      id: s.id,
      email: s.email,
      additionalEmail: s.additionalEmail,
      firstName: s.firstName,
      lastName: s.lastName,
      title: s.title,
      agreementAcceptedAt: s.agreementAcceptedAt,
    }));
  } else if (recipientType === "abstracts") {
    // Validated by assertValidBulkEmailFilters (via the precheck) — the old
    // unchecked `as never` cast let a bad value reach Prisma and abort the
    // whole send with a cryptic throw. "all" parses false → no filter.
    const parsedAbstractStatus = filters?.status ? abstractStatusSchema.safeParse(filters.status) : null;
    const abstractStatus = parsedAbstractStatus?.success ? parsedAbstractStatus.data : undefined;
    const abstracts = await db.abstract.findMany({
      where: {
        eventId,
        ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
        ...(abstractStatus && { status: abstractStatus }),
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
        // Default-safe audience for the send types that must never reach a
        // CANCELLED registration. The rule (and the reasoning per type) lives in
        // bulk-email-audience.ts, shared with the dashboard's recipient-count
        // predicates so the number the organizer reads is the number we mail.
        ...(excludesCancelledByDefault(emailType, status)
          ? { status: { not: "CANCELLED" as const } }
          : {}),
        ...(paymentStatuses.length === 1
          ? { paymentStatus: paymentStatuses[0] }
          : paymentStatuses.length > 1
            ? { paymentStatus: { in: paymentStatuses } }
            : {}),
        ...(filters?.ticketTypeIds?.length
          ? { ticketTypeId: { in: filters.ticketTypeIds } }
          : filters?.ticketTypeId
            ? { ticketTypeId: filters.ticketTypeId }
            : {}),
        ...(filters?.badgeTypes?.length ? { badgeType: { in: filters.badgeTypes } } : {}),
        // Tag filter — attendees with ANY of the requested tags. Relation
        // filter on the linked Attendee row.
        ...(filters?.tagsInclude?.length
          ? { attendee: { tags: { hasSome: filters.tagsInclude } } }
          : {}),
        // Drop faculty companions (the isFaculty ticket type) — email delegates only.
        ...(filters?.excludeFaculty ? EXCLUDE_FACULTY_WHERE : {}),
      },
      select: {
        id: true,
        serialId: true,
        qrCode: true,
        attendanceMode: true,
        // Pricing — feeds the payment-reminder amount-due + Pay Now link
        // (buildPaymentReminderVars). Cheap columns; loaded for every
        // registrations send but only consumed for payment-reminder.
        originalPrice: true,
        discountAmount: true,
        pricingTier: { select: { name: true, price: true, currency: true } },
        ticketType: { select: { name: true, price: true, currency: true } },
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
      originalPrice: r.originalPrice,
      discountAmount: r.discountAmount,
      pricingTier: r.pricingTier ? { price: r.pricingTier.price, currency: r.pricingTier.currency } : null,
      ticketTypePricing: r.ticketType ? { price: r.ticketType.price, currency: r.ticketType.currency } : null,
    }));
  }

  if (recipients.length === 0) {
    throw new BulkEmailError(
      "No recipients found matching the criteria",
      400,
      NO_RECIPIENTS_CODE,
    );
  }

  // Certificate sends bypass the entire template/renderAndWrap pipeline —
  // per-recipient tag routing, issue-or-reuse, and the multi-PDF bundle
  // email live in the certificates lib.
  if (emailType === "certificate" && certTemplates) {
    return executeCertificateBulkSend({
      eventId,
      recipientType: recipientType as "registrations" | "speakers",
      recipients,
      templates: certTemplates,
      customSubject,
      customMessage,
      organizationId,
      triggeredByUserId,
      // A4 (July 16, 2026): the cert send previously had NO email-level
      // idempotency (issue-or-reuse dedups the cert ROW, not the email) — a
      // crash + Retry re-emailed everyone already emailed on the biggest
      // fan-out in the system. Same resume contract as the non-cert path.
      alreadyEmailedKeys,
      onBatchEmailed,
    });
  }

  // ── Load template ──
  // Resolve the template slug. A "template" send carries a custom slug in
  // filters.templateSlug and loads the active EmailTemplate directly; every
  // other type maps to a fixed system slug via BULK_EMAIL_TEMPLATE_SLUGS
  // (module-scope so precheckBulkEmailViability rejects unsupported types
  // synchronously at the routes — review A2 — and this stays the backstop
  // for direct callers).
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
    const mapped = BULK_EMAIL_TEMPLATE_SLUGS[emailType];
    if (!mapped) {
      throw new BulkEmailError(UNSUPPORTED_EMAIL_TYPE_MESSAGE(emailType), 400);
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

  // Agreement tokens ({{agreementBlock}} / {{agreementLink}}): minted
  // per-recipient only when the template actually uses one — an unrelated
  // send must never rotate (invalidate) a previously-emailed agreement link.
  // This also fixes a latent bug: bulk AGREEMENT sends never minted
  // {{agreementLink}}, so the default agreement template's CTA button href
  // stayed the literal token.
  const templateWantsAgreement =
    recipientType === "speakers" &&
    templateUsesAgreementBlock(tpl.subject, tpl.htmlContent, tpl.textContent);

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
      // Attendees join through OUR gated session page (waiting room → embed/HLS),
      // NOT the raw Zoom URL. The session page handles auth + registration-gating
      // and admits viewers only when the producer opens the room. Sending the
      // Zoom link directly would bypass the waiting room entirely.
      // (Panelists get the real Zoom join URL via the separate panelist-email
      // path in src/lib/webinar-panelist-email.ts — unchanged.)
      joinUrl: `${appUrl}/e/${event.slug}/session/${anchorSessionId}`,
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

  // For ANY speaker-targeted send, build the rich per-speaker context so
  // greetings include the title prefix and {{presentationDetails}} shows the
  // speaker's actual sessions/topics/dates. This used to be gated to the
  // invitation/agreement types only — an organizer sending a SAVED custom
  // template (emailType "template") or a custom email whose template body
  // used {{presentationDetails}} got a silently empty block (organizer-
  // reported bug, July 16 2026).
  const isSpeakerContextNeeded = recipientType === "speakers";

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
      // Agreement tokens — populated below for speaker recipients when the
      // template uses them; empty so the placeholders disappear otherwise.
      agreementLink: "",
      agreementBlock: "",
      agreementBlockText: "",
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

    if (templateWantsAgreement) {
      // Signed speakers get the "already accepted" note; unsigned speakers
      // get a freshly-minted one-time link + Review & Agree CTA. A mint
      // failure throws and is captured by the per-recipient error handling —
      // one bad row never sinks the batch.
      const link = recipient.agreementAcceptedAt
        ? ""
        : await mintSpeakerAgreementLink(recipient.id, event.slug || event.id);
      vars.agreementLink = link;
      const block = buildAgreementBlock({
        agreementLink: link,
        agreementAcceptedAt: recipient.agreementAcceptedAt ?? null,
      });
      vars.agreementBlock = block.html;
      vars.agreementBlockText = block.text;
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

    // Payment-reminder {{amount}} (amount due) + {{paymentBlock}} (Pay Now
    // link), via the SAME helper the single-send route uses so the two can't
    // drift. Gated on the resolved template slug so it fires whether the send
    // is the first-class "payment-reminder" type OR a saved template on that
    // slug — the bulk path previously left both tokens empty (no link).
    if (templateSlug === "payment-reminder" && recipientType === "registrations") {
      const { amount, paymentBlock } = buildPaymentReminderVars({
        registrationId: recipient.id,
        firstName: recipient.firstName,
        eventSlug: event.slug || event.id,
        originalPrice: recipient.originalPrice,
        discountAmount: recipient.discountAmount,
        pricingTier: recipient.pricingTier ?? null,
        ticketType: recipient.ticketTypePricing ?? null,
        taxRate: event.taxRate ? Number(event.taxRate) : null,
        taxLabel: event.taxLabel,
      });
      vars.amount = amount;
      vars.paymentBlock = paymentBlock;
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

    const rawHtmlKeys = new Set([
      "presentationDetails",
      "organizerSignature",
      "personalMessage",
      "passcodeBlock",
      "recordingBlock",
      // message + personalMessage are pre-rendered FINAL HTML below via
      // renderMessageValue — escaping is handled there (dashboard plain text
      // escaped, MCP sanitized HTML kept — the A1 contract), so both render
      // raw here.
      "message",
    ]);

    // Resolve tokens the organizer typed INTO the message itself —
    // {{organizerSignature}}, {{firstName}}, … (July 16, 2026 organizer
    // ask). renderTemplate is single-pass over the TEMPLATE, so tokens
    // inside var values were previously left as literal text. Runs last so
    // every per-recipient var (paymentBlock, entryBarcode, webinar blocks)
    // is available to the message too. The two keys keep their HISTORICAL
    // escaping contracts exactly: {{personalMessage}} has always rendered
    // the typed message raw (isHtml: true); {{message}} escapes it unless
    // the caller flagged sanitized HTML (the MCP A1 contract).
    if (customMessage) {
      vars.personalMessage = renderMessageValue(customMessage, vars, {
        isHtml: true,
        rawHtmlKeys,
      });
      if ("message" in vars) {
        vars.message = renderMessageValue(customMessage, vars, {
          isHtml: customMessageIsHtml,
          rawHtmlKeys,
        });
      }
    }

    return {
      ...renderAndWrap(tpl, vars, branding, rawHtmlKeys),
      barcodeAttachment,
    };
  };

  // ── Per-recipient idempotency (review H1) ──
  // On a re-run (retry after a crash, or a superseded duplicate) skip the
  // recipients a prior run already emailed so we resume instead of re-emailing
  // everyone. A fresh send has an empty set, so `toSend === recipients`. This
  // also means an already-emailed recipient's survey token is never re-minted
  // (review M6 — the mint lives inside generateEmailForRecipient, below the
  // filter). Certificate sends returned early above with the same keys passed
  // through — executeCertificateBulkSend applies the identical skip (A4).
  const alreadyEmailed = new Set(alreadyEmailedKeys ?? []);
  const toSend = alreadyEmailed.size
    ? recipients.filter((r) => !alreadyEmailed.has(r.id))
    : recipients;
  if (alreadyEmailed.size) {
    apiLogger.info({
      msg: "bulk-email:resume-skip",
      eventId,
      emailType,
      alreadyEmailed: alreadyEmailed.size,
      remaining: toSend.length,
    });
  }

  // ── Send in batches of 25 ──
  const BATCH_SIZE = 25;
  let successCount = 0;
  let failureCount = 0;
  const errors: Array<{ email: string; error: string }> = [];

  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const batch = toSend.slice(i, i + BATCH_SIZE);

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

    // Recipient ids successfully emailed in THIS batch — recorded to the
    // caller's idempotency store (review H1) so a crash after this point resumes
    // past them.
    const batchEmailedKeys: string[] = [];
    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        const { recipient, result: emailResult } = r.value;
        if (emailResult.success) {
          successCount++;
          batchEmailedKeys.push(recipient.id);
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

    // Persist idempotency progress after each batch (best-effort — a record
    // failure must never fail the send; worst case a retry re-sends this batch).
    if (onBatchEmailed && batchEmailedKeys.length) {
      await onBatchEmailed(batchEmailedKeys).catch((err) =>
        apiLogger.warn({ err, msg: "bulk-email:record-emailed-failed", eventId, count: batchEmailedKeys.length }),
      );
    }
  }

  return {
    // The number this run attempted (a fresh send = all recipients; a resumed
    // retry = the remaining, already-emailed excluded).
    total: toSend.length,
    successCount,
    failureCount,
    errors,
  };
}
