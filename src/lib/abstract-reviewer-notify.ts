import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { sendableAssignmentWhere } from "@/lib/abstract-reviewer-access";
import { escapeHtml } from "@/lib/html";
import { UNRESOLVED_TOKENS_CODE, untokened } from "@/lib/template-tokens";
import { apiLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { getTitleLabel } from "@/lib/utils";

/**
 * Reviewers' titles (the Title enum, e.g. "DR") for `{{title}}`. A reviewer
 * account stores none; their speaker record on this event usually does. The
 * account-linked record wins over one matched by address.
 *
 * Never throws: a failed lookup gives no titles, and the email still goes out
 * ("Dear  Ortiz" beats no email). Nov 10, 2026: MEHF's templates were edited
 * to "Dear {{title}} {{lastName}}" and, with no title supplied, every reviewer
 * email was refused on the unresolved token, so the reviewer was never told.
 * Used by the reviewer emails here and by the reviewers bulk email.
 */
export async function reviewerTitles(
  eventId: string,
  reviewers: { id: string; email: string }[],
): Promise<Map<string, string | null>> {
  const titles = new Map<string, string | null>();
  if (reviewers.length === 0) return titles;
  try {
    const speakers = await db.speaker.findMany({
      where: {
        eventId,
        OR: [
          { userId: { in: reviewers.map((r) => r.id) } },
          ...reviewers.map((r) => ({ email: { equals: r.email, mode: "insensitive" as const } })),
        ],
      },
      select: { userId: true, email: true, title: true },
      orderBy: { createdAt: "asc" },
    });
    for (const r of reviewers) {
      const linked = speakers.find((s) => s.userId === r.id);
      const byAddress = speakers.find((s) => s.email.toLowerCase() === r.email.toLowerCase());
      titles.set(r.id, (linked ?? byAddress)?.title ?? null);
    }
  } catch (err) {
    apiLogger.warn({ err, msg: "reviewer-title:lookup-failed", eventId });
  }
  return titles;
}

async function reviewerTitle(eventId: string, reviewer: { id: string; email: string }): Promise<string> {
  return getTitleLabel((await reviewerTitles(eventId, [reviewer])).get(reviewer.id));
}

const ROLE_LABELS: Record<string, string> = {
  PRIMARY: "Primary reviewer",
  SECONDARY: "Secondary reviewer",
  CONSULTING: "Consulting reviewer",
};

/** One role's label when every assignment shares it, else the plain word. */
function roleLabelFor(roles: string[]): string {
  const distinct = new Set(roles);
  if (distinct.size !== 1) return "Reviewer";
  return ROLE_LABELS[roles[0]] ?? "Reviewer";
}

/**
 * How long a send lease lasts. Far longer than any real send, so a claim older
 * than this means the send was interrupted (a process killed mid-request) and
 * the next press takes the rows over.
 */
export const ASSIGNMENT_CLAIM_TTL_MS = 10 * 60 * 1000;

export type SendPendingAssignmentsResult =
  | {
      ok: true;
      sent: number;
      /** false: the email went out but could not be marked; the rows still show as not emailed. */
      recorded: boolean;
      /** true: an earlier send to this reviewer was interrupted, so they may have this email twice. */
      reclaimed: boolean;
    }
  | {
      ok: false;
      code: "NOTHING_PENDING" | "IN_PROGRESS" | "ACCOUNT_NOT_SET_UP" | "REVIEWER_NOT_FOUND" | "NO_TEMPLATE" | "SEND_FAILED";
      message: string;
    };

type AssignmentTemplate = NonNullable<Awaited<ReturnType<typeof getEventTemplate>>>;

/** One line, no control characters, no `{{` (sendEmail would refuse the whole email on it). */
function listTitle(raw: string): string {
  return untokened(raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()) || "Untitled abstract";
}

/**
 * The assignment email for these rows. `{{abstractTitle}}` is one value per
 * part: an escaped list for the HTML body (passed raw), plain lines for the
 * text part, and for the subject the single title or "3 abstracts", never
 * markup. Several titles are numbered, since a title often wraps.
 */
function renderAssignmentEmail(
  tpl: AssignmentTemplate,
  reviewer: { firstName: string | null; lastName: string | null },
  title: string,
  rows: { role: string; abstract: { title: string } }[],
) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
  const titles = rows.map((r) => listTitle(r.abstract.title));
  const lines = titles.length === 1 ? titles : titles.map((t, i) => `${i + 1}. ${t}`);
  const vars = {
    title,
    firstName: reviewer.firstName ?? "",
    lastName: reviewer.lastName ?? "",
    eventName: tpl.branding.eventName ?? "",
    role: roleLabelFor(rows.map((r) => r.role)),
    abstractCount: titles.length,
    reviewLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/my-reviews")}`,
  };
  return renderAndWrap(
    tpl,
    { ...vars, abstractTitle: lines.map(escapeHtml).join("<br>") },
    tpl.branding,
    new Set(["abstractTitle"]),
    {
      subject: { abstractTitle: titles.length === 1 ? titles[0] : `${titles.length} abstracts` },
      text: { abstractTitle: lines.join("\n  ") },
    },
  );
}

/**
 * Lease these rows for one send: a single conditional UPDATE whose WHERE holds
 * only the row's own columns, which Postgres re-tests after waiting on a row
 * lock, so of two overlapping sends exactly one gets each row. Returns the
 * token that owns the claim, or null when another send holds every row.
 */
async function claimAssignments(reviewerUserId: string, ids: string[], staleBefore: Date): Promise<string | null> {
  const token = globalThis.crypto.randomUUID();
  const claimed = await db.abstractReviewer.updateMany({
    where: {
      id: { in: ids },
      userId: reviewerUserId,
      notifiedAt: null,
      conflictFlag: false,
      OR: [{ notifyClaimedAt: null }, { notifyClaimedAt: { lt: staleBefore } }],
    },
    data: { notifyClaimedAt: new Date(), notifyClaimToken: token },
  });
  return claimed.count > 0 ? token : null;
}

/** The send failed: give the rows back so the next press can try again. */
async function releaseClaim(reviewerUserId: string, token: string, ctx: { eventId: string }): Promise<void> {
  try {
    await db.abstractReviewer.updateMany({
      where: { userId: reviewerUserId, notifyClaimToken: token, notifiedAt: null },
      data: { notifyClaimedAt: null, notifyClaimToken: null },
    });
  } catch (err) {
    // Nothing is lost: the rows still show as not emailed, and the claim
    // expires by itself after ASSIGNMENT_CLAIM_TTL_MS.
    apiLogger.error({ err, msg: "reviewer-assignment:release-failed", eventId: ctx.eventId, reviewerUserId });
  }
}

const MARK_ATTEMPTS = 3;
const MARK_RETRY_MS = 200;

/**
 * The email is out: mark the rows emailed and drop the claim. Tried a few
 * times, because failing here must not be reported as a failed send (the
 * organiser would press again and the reviewer would get it twice).
 */
async function recordSent(reviewerUserId: string, token: string, expected: number, ctx: { eventId: string }): Promise<boolean> {
  for (let attempt = 1; attempt <= MARK_ATTEMPTS; attempt++) {
    try {
      const marked = await db.abstractReviewer.updateMany({
        where: { userId: reviewerUserId, notifyClaimToken: token },
        data: { notifiedAt: new Date(), notifyClaimedAt: null, notifyClaimToken: null },
      });
      if (marked.count < expected) {
        apiLogger.warn({ msg: "reviewer-assignment:marked-fewer-than-sent", eventId: ctx.eventId, reviewerUserId, expected, marked: marked.count });
      }
      return true;
    } catch (err) {
      apiLogger.warn({ err, msg: "reviewer-assignment:mark-attempt-failed", eventId: ctx.eventId, reviewerUserId, attempt });
      if (attempt < MARK_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, MARK_RETRY_MS));
    }
  }
  return false;
}

/**
 * Email a reviewer every assignment on this event they have not been told
 * about yet, in ONE email, then mark those assignments notified.
 *
 * Assigning sends nothing (owner, Nov 10, 2026): one email per assignment
 * would have meant hundreds on a large event, each copied to the event's
 * Auto-CC list. The organiser presses "Send assignments" on the Reviewers page.
 *
 * Reuses the `reviewer-assignment` template, so an event's edited copy keeps
 * working: `{{abstractTitle}}` becomes the list of titles (one per line) and
 * `{{abstractCount}}` the number. What it may carry is `sendableAssignmentWhere`
 * (abstract-reviewer-access.ts): conflict-flagged assignments and abstracts no
 * longer up for review are left out.
 *
 * The rows are LEASED before the send (notifyClaimedAt + notifyClaimToken) and
 * marked notified only after it, so two overlapping sends (a retry after a
 * gateway timeout, two tabs, two organisers) cannot both email the same
 * assignments. The lease is not on notifiedAt on purpose: a process killed
 * between claim and send must leave the rows showing as not emailed.
 *
 * Never throws: returns a code the caller reports.
 */
export async function sendPendingAssignments(args: SendPendingAssignmentsArgs): Promise<SendPendingAssignmentsResult> {
  const { eventId, reviewerUserId } = args;
  const outcome = await leaseAndSend(args);
  if ("failure" in outcome) return outcome.failure;

  // Sent. From here nothing may report a failed send.
  const recorded = await recordSent(reviewerUserId, outcome.token, outcome.count, { eventId });
  if (!recorded) {
    apiLogger.error({ msg: "reviewer-assignment:sent-not-recorded", eventId, reviewerUserId, count: outcome.count, claimToken: outcome.token });
  }
  apiLogger.info({ msg: "reviewer-assignment:sent", eventId, reviewerUserId, count: outcome.count, recorded });
  return { ok: true, sent: outcome.count, recorded, reclaimed: outcome.reclaimed };
}

interface SendPendingAssignmentsArgs {
  eventId: string;
  organizationId: string | null;
  reviewerUserId: string;
  triggeredByUserId?: string | null;
}

type Refusal = Extract<SendPendingAssignmentsResult, { ok: false }>;
const refuse = (code: Refusal["code"], message: string): { failure: Refusal } => ({ failure: { ok: false, code, message } });

/** Everything up to and including the send. A failure here has released its claim. */
async function leaseAndSend(
  args: SendPendingAssignmentsArgs,
): Promise<{ failure: Refusal } | { token: string; count: number; reclaimed: boolean }> {
  const { eventId, reviewerUserId } = args;
  const ctx = { eventId };
  let token: string | null = null;
  try {
    const [reviewer, pending] = await Promise.all([
      db.user.findUnique({
        where: { id: reviewerUserId },
        select: { id: true, firstName: true, lastName: true, email: true, emailVerified: true },
      }),
      db.abstractReviewer.findMany({
        where: { ...sendableAssignmentWhere(eventId), userId: reviewerUserId },
        select: { id: true, notifyClaimedAt: true },
      }),
    ]);
    if (!reviewer) {
      apiLogger.warn({ msg: "reviewer-assignment:reviewer-not-found", eventId, reviewerUserId });
      return refuse("REVIEWER_NOT_FOUND", "Reviewer not found");
    }
    if (pending.length === 0) {
      apiLogger.info({ msg: "reviewer-assignment:nothing-pending", eventId, reviewerUserId });
      return refuse("NOTHING_PENDING", "Nothing new to send to this reviewer");
    }
    // The email says "log in": an account that never accepted its invitation
    // has no password, so it gets the invitation first (the row's own button).
    if (!reviewer.emailVerified) {
      apiLogger.warn({ msg: "reviewer-assignment:account-not-set-up", eventId, reviewerUserId });
      return refuse("ACCOUNT_NOT_SET_UP", "This reviewer has not set up their account yet. Send their invitation first.");
    }
    const staleBefore = new Date(Date.now() - ASSIGNMENT_CLAIM_TTL_MS);
    const free = pending.filter((row) => !row.notifyClaimedAt || row.notifyClaimedAt < staleBefore);
    if (free.length === 0) {
      apiLogger.info({ msg: "reviewer-assignment:in-progress", eventId, reviewerUserId });
      return refuse("IN_PROGRESS", "Another send is emailing this reviewer, or one was interrupted in the last 10 minutes.");
    }

    // Everything that can refuse without sending is read BEFORE the claim.
    const tpl = await getEventTemplate(eventId, "reviewer-assignment");
    if (!tpl) {
      apiLogger.warn({ msg: "reviewer-assignment:no-template", eventId });
      return refuse("NO_TEMPLATE", "The reviewer assignment email template is missing");
    }
    const title = await reviewerTitle(eventId, reviewer);

    // The only trace a killed send can leave: its claim, now expired.
    const reclaimed = free.some((row) => !!row.notifyClaimedAt);
    if (reclaimed) {
      apiLogger.error({ msg: "reviewer-assignment:interrupted-send-reclaimed", eventId, reviewerUserId, rows: free.filter((row) => row.notifyClaimedAt).length });
    }

    token = await claimAssignments(reviewerUserId, free.map((row) => row.id), staleBefore);
    if (!token) {
      apiLogger.info({ msg: "reviewer-assignment:in-progress", eventId, reviewerUserId, lostClaim: true });
      return refuse("IN_PROGRESS", "Another send is emailing this reviewer right now.");
    }
    // The email is built from what THIS call owns, never from the earlier read.
    const mine = await db.abstractReviewer.findMany({
      where: { userId: reviewerUserId, notifyClaimToken: token },
      select: { id: true, role: true, abstract: { select: { title: true } } },
      orderBy: { assignedAt: "asc" },
    });
    if (mine.length === 0) {
      apiLogger.info({ msg: "reviewer-assignment:nothing-pending", eventId, reviewerUserId, removedMeanwhile: true });
      return refuse("NOTHING_PENDING", "Nothing new to send to this reviewer");
    }

    const to = [{ email: reviewer.email, name: `${reviewer.firstName ?? ""} ${reviewer.lastName ?? ""}`.trim() || reviewer.email }];
    const result = await sendEmail({
      to,
      cc: brandingCc(tpl.branding, to),
      ...renderAssignmentEmail(tpl, reviewer, title, mine),
      from: brandingFrom(tpl.branding),
      emailType: "reviewer_assignment",
      stream: "transactional",
      logContext: {
        organizationId: args.organizationId,
        eventId,
        entityType: "USER",
        entityId: reviewer.id,
        templateSlug: "reviewer-assignment",
        triggeredByUserId: args.triggeredByUserId ?? null,
      },
    });
    if (!result.success) {
      apiLogger.error({ msg: "reviewer-assignment:send-failed", eventId, reviewerUserId, code: result.code, error: result.error });
      await releaseClaim(reviewerUserId, token, ctx);
      // A template fault is the organiser's to fix, so they get its wording;
      // a provider error's raw text is logged above, not shown.
      const message = result.code === UNRESOLVED_TOKENS_CODE && result.error ? result.error : "The email could not be sent";
      return refuse("SEND_FAILED", message);
    }
    return { token, count: mine.length, reclaimed };
  } catch (err) {
    apiLogger.error({ err, msg: "reviewer-assignment:send-error", eventId, reviewerUserId });
    if (token) await releaseClaim(reviewerUserId, token, ctx);
    return refuse("SEND_FAILED", "The email could not be sent");
  }
}

/**
 * The "added as a reviewer" email (`reviewer-pool-invitation`), for an account
 * that can already sign in. Sent only by hand since Nov 10, 2026: the row's
 * Send email button on the Reviewers page (adding a reviewer sends nothing).
 * A new account gets the account-setup invitation instead.
 *
 * Never throws, and says whether the email went: a refused send (an unresolved
 * token in the event's template, a provider error) must reach the organiser,
 * who would otherwise be told it was sent.
 */
export async function notifyReviewerPoolAdded(args: {
  eventId: string;
  organizationId: string | null;
  reviewer: { id: string; firstName: string | null; lastName: string | null; email: string };
  eventName: string;
  triggeredByUserId?: string | null;
}): Promise<{ ok: true } | { ok: false; code: "NO_TEMPLATE" | "SEND_FAILED"; message: string }> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const vars = {
      title: await reviewerTitle(args.eventId, args.reviewer),
      firstName: args.reviewer.firstName ?? "",
      lastName: args.reviewer.lastName ?? "",
      eventName: args.eventName,
      reviewLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/my-reviews")}`,
    };

    const tpl = (await getEventTemplate(args.eventId, "reviewer-pool-invitation"))
      || getDefaultTemplate("reviewer-pool-invitation");
    if (!tpl) {
      apiLogger.warn({ msg: "No template found for reviewer-pool-invitation", eventId: args.eventId });
      return { ok: false, code: "NO_TEMPLATE", message: "The reviewer email template is missing" };
    }
    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: args.eventName };
    const rendered = renderAndWrap(tpl, vars, branding);

    const to = [{ email: args.reviewer.email, name: `${vars.firstName} ${vars.lastName}`.trim() || args.reviewer.email }];
    const result = await sendEmail({
      to,
      cc: brandingCc(branding, to),
      ...rendered,
      from: brandingFrom(branding),
      emailType: "reviewer_pool_invitation",
      stream: "transactional",
      logContext: {
        organizationId: args.organizationId,
        eventId: args.eventId,
        entityType: "USER",
        entityId: args.reviewer.id,
        templateSlug: "reviewer-pool-invitation",
        triggeredByUserId: args.triggeredByUserId ?? null,
      },
    });
    if (!result.success) {
      apiLogger.error({ msg: "reviewer-pool:send-failed", eventId: args.eventId, reviewerUserId: args.reviewer.id, code: result.code, error: result.error });
      const message = result.code === UNRESOLVED_TOKENS_CODE && result.error ? result.error : "The email could not be sent";
      return { ok: false, code: "SEND_FAILED", message };
    }

    apiLogger.info({ msg: "reviewer-pool:notified", eventId: args.eventId, reviewerUserId: args.reviewer.id });
    return { ok: true };
  } catch (err) {
    apiLogger.error({ err, msg: "reviewer-pool:notify-failed", eventId: args.eventId, reviewerUserId: args.reviewer.id });
    return { ok: false, code: "SEND_FAILED", message: "The email could not be sent" };
  }
}
