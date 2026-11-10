import crypto from "crypto";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { reviewerAccountIsSetUp } from "@/lib/abstract-reviewer-access";
import { reviewerPortalAccess, REVIEWER_SETUP_EXPIRES_IN, REVIEWER_SETUP_LINK_DAYS } from "@/lib/reviewer-portal-access";
import { hashVerificationToken } from "@/lib/security";
import { UNRESOLVED_TOKENS_CODE } from "@/lib/template-tokens";
import { apiLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { getTitleLabel } from "@/lib/utils";
import { equalsIgnoringCase } from "@/lib/like-escape";

/** What a reviewer's speaker record on the event adds to their emails. */
export interface ReviewerSpeakerRecord {
  /** The Title enum, e.g. "DR", for `{{title}}`. */
  title: string | null;
  /** Their second inbox, copied on emails about them like every other email to a speaker. */
  additionalEmail: string | null;
}

const NO_SPEAKER_RECORD: ReviewerSpeakerRecord = { title: null, additionalEmail: null };

/**
 * Each reviewer's title and additional email. A reviewer account stores
 * neither; their speaker record on this event usually does. The
 * account-linked record wins over one matched by address.
 *
 * Never throws: a failed lookup gives nothing, and the email still goes out
 * ("Dear  Ortiz" beats no email). Nov 10, 2026: MEHF's templates were edited
 * to "Dear {{title}} {{lastName}}" and, with no title supplied, every reviewer
 * email was refused on the unresolved token, so the reviewer was never told.
 * The same day the additional email was found to be left off the CC of every
 * reviewer email. Used by the reviewer emails here, the reviewers bulk email
 * and the Reviewers page.
 */
export async function reviewerSpeakerRecords(
  eventId: string,
  reviewers: { id: string; email: string }[],
): Promise<Map<string, ReviewerSpeakerRecord>> {
  const records = new Map<string, ReviewerSpeakerRecord>();
  if (reviewers.length === 0) return records;
  try {
    const speakers = await db.speaker.findMany({
      where: {
        eventId,
        OR: [
          { userId: { in: reviewers.map((r) => r.id) } },
          ...reviewers.map((r) => ({ email: equalsIgnoringCase(r.email) })),
        ],
      },
      select: { userId: true, email: true, title: true, additionalEmail: true },
      orderBy: { createdAt: "asc" },
    });
    for (const r of reviewers) {
      const linked = speakers.find((s) => s.userId === r.id);
      // A record on their address that ANOTHER account has claimed is not
      // theirs: its additional email must never get this reviewer's emails.
      const byAddress = speakers.find((s) => s.email.toLowerCase() === r.email.toLowerCase() && (s.userId === null || s.userId === r.id));
      const speaker = linked ?? byAddress;
      if (speaker) records.set(r.id, { title: speaker.title ?? null, additionalEmail: speaker.additionalEmail ?? null });
    }
  } catch (err) {
    apiLogger.warn({ err, msg: "reviewer-title:lookup-failed", eventId });
  }
  return records;
}

async function reviewerSpeakerRecord(eventId: string, reviewer: { id: string; email: string }): Promise<ReviewerSpeakerRecord> {
  return (await reviewerSpeakerRecords(eventId, [reviewer])).get(reviewer.id) ?? NO_SPEAKER_RECORD;
}

/**
 * The signature of whoever pressed Send, for `{{organizerSignature}}`. Preview
 * and Send test always showed it; the real reviewer emails went out unsigned
 * (review of 0f77a7ee, Nov 10, 2026). Never costs the email: none on a failure.
 */
async function senderSignature(userId: string | null | undefined): Promise<string> {
  if (!userId) return "";
  try {
    const sender = await db.user.findUnique({ where: { id: userId }, select: { emailSignature: true } });
    return sender?.emailSignature ?? "";
  } catch (err) {
    apiLogger.warn({ err, msg: "reviewer-email:signature-lookup-failed", userId });
    return "";
  }
}

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";

/** Sign in, then My Reviews: the way into the portal on every visit. */
function myReviewsLink(): string {
  return `${appUrl()}/login?callbackUrl=${encodeURIComponent("/my-reviews")}`;
}

/**
 * A fresh set-password link for an account that has none yet. The earlier
 * link, if any, stops working: one address holds one invitation at a time.
 */
async function mintSetupLink(email: string, eventSlug: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const identifier = email.toLowerCase();
  const expires = new Date(Date.now() + REVIEWER_SETUP_LINK_DAYS * 24 * 60 * 60 * 1000);
  await db.$transaction(async (tx) => {
    await tx.verificationToken.deleteMany({ where: { identifier } });
    await tx.verificationToken.create({ data: { identifier, token: hashVerificationToken(token), expires } });
  });
  return `${appUrl()}/accept-invitation?token=${token}&email=${encodeURIComponent(identifier)}&eventSlug=${encodeURIComponent(eventSlug)}`;
}

export type ReviewerEmailResult =
  /** "setup": the reviewer had no password and was sent the link to set one. */
  | { ok: true; kind: "setup" | "portal" }
  | { ok: false; code: "NO_TEMPLATE" | "SEND_FAILED"; message: string };

export interface ReviewerInvitationArgs {
  eventId: string;
  organizationId: string | null;
  eventName: string;
  eventSlug: string;
  reviewer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    role?: string | null;
    emailVerified?: Date | null;
  };
  /** The name reviewers know the organiser by (the attendee-facing brand). */
  organizationName: string;
  inviterName: string;
  triggeredByUserId?: string | null;
}

/**
 * THE reviewer email: the event's `reviewer-invitation` template, sent by the
 * row's Send button and by Send to all on the Reviewers page.
 *
 * One email since Nov 10, 2026 (owner, for the MEHF organiser: "just one
 * template that can handle new invitations, and if existing go directly to My
 * Reviews; no need for send assignments because My Reviews shows what is to be
 * reviewed"). Before it there were three: an account-setup invitation, an
 * "added as a reviewer" email and a per-press list of new assignments, each
 * with its own wording to keep in step.
 *
 * What differs per reviewer is `{{portalAccess}}` (reviewer-portal-access.ts):
 * an account with no password yet gets a freshly minted set-password link,
 * one that can sign in gets the portal button. "Can sign in" is
 * reviewerAccountIsSetUp, never emailVerified alone: a registrant has a
 * password and no emailVerified, and a setup link would REPLACE it.
 *
 * The reviewer's title and additional email come from their speaker record on
 * the event; the additional email is copied beside the event's Auto-CC, the
 * account stays on the main address (owner, Nov 10, 2026).
 *
 * Never throws, and says whether the email went: a refused send (an unresolved
 * token in the event's template, a provider error) must reach the organiser.
 */
export async function sendReviewerInvitation(args: ReviewerInvitationArgs): Promise<ReviewerEmailResult> {
  const { eventId, reviewer } = args;
  try {
    // Read before a link is minted: a missing template must not cost the
    // reviewer the link they already hold.
    const tpl = (await getEventTemplate(eventId, "reviewer-invitation")) || getDefaultTemplate("reviewer-invitation");
    if (!tpl) {
      apiLogger.warn({ msg: "reviewer-invitation:no-template", eventId });
      return { ok: false, code: "NO_TEMPLATE", message: "The reviewer invitation email template is missing" };
    }
    const [speakerRecord, organizerSignature] = await Promise.all([
      reviewerSpeakerRecord(eventId, reviewer),
      senderSignature(args.triggeredByUserId),
    ]);
    const kind = reviewerAccountIsSetUp(reviewer) ? "portal" : "setup";
    const setupLink = kind === "setup" ? await mintSetupLink(reviewer.email, args.eventSlug) : null;
    const reviewLink = myReviewsLink();
    const access = reviewerPortalAccess({ email: reviewer.email, reviewLink, setupLink });

    const vars = {
      title: getTitleLabel(speakerRecord.title),
      firstName: reviewer.firstName ?? "",
      lastName: reviewer.lastName ?? "",
      email: reviewer.email,
      eventName: args.eventName,
      organizationName: args.organizationName,
      inviterName: args.inviterName,
      organizerSignature,
      portalAccess: access.html,
      reviewLink,
      // For a copy saved before {{portalAccess}} existed: its set-password
      // button still leads somewhere for a reviewer who needs no password.
      setupLink: setupLink ?? reviewLink,
      expiresIn: REVIEWER_SETUP_EXPIRES_IN,
    };
    const branding = "branding" in tpl ? tpl.branding : { eventName: args.eventName };
    const rendered = renderAndWrap(tpl, vars, branding, undefined, { text: { portalAccess: access.text } });

    const to = [{ email: reviewer.email, name: `${vars.firstName} ${vars.lastName}`.trim() || reviewer.email }];
    const result = await sendEmail({
      to,
      cc: brandingCc(branding, to, [speakerRecord.additionalEmail]),
      ...rendered,
      from: brandingFrom(branding),
      emailType: "reviewer_invitation",
      stream: "transactional",
      logContext: {
        organizationId: args.organizationId,
        eventId,
        entityType: "USER",
        entityId: reviewer.id,
        templateSlug: "reviewer-invitation",
        triggeredByUserId: args.triggeredByUserId ?? null,
      },
    });
    if (!result.success) {
      apiLogger.error({ msg: "reviewer-invitation:send-failed", eventId, reviewerUserId: reviewer.id, kind, code: result.code, error: result.error });
      // A template fault is the organiser's to fix, so they get its wording;
      // a provider error's raw text is logged above, not shown.
      const message = result.code === UNRESOLVED_TOKENS_CODE && result.error ? result.error : "The email could not be sent";
      return { ok: false, code: "SEND_FAILED", message };
    }
    apiLogger.info({ msg: "reviewer-invitation:sent", eventId, reviewerUserId: reviewer.id, kind });
    return { ok: true, kind };
  } catch (err) {
    apiLogger.error({ err, msg: "reviewer-invitation:send-error", eventId, reviewerUserId: reviewer.id });
    return { ok: false, code: "SEND_FAILED", message: "The email could not be sent" };
  }
}

/** Who pressed Send, as the email names them. */
export function inviterNameOf(user: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  return user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email || "A team member";
}
