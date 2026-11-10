import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { REVIEWABLE_ABSTRACT_STATUSES } from "@/lib/abstract-reviewer-access";
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
 * Used by the automatic emails here and by the reviewers bulk email.
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type SendPendingAssignmentsResult =
  | { ok: true; sent: number }
  | { ok: false; code: "NOTHING_PENDING" | "REVIEWER_NOT_FOUND" | "NO_TEMPLATE" | "SEND_FAILED"; message: string };

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
 * `{{abstractCount}}` the number. Conflict-flagged assignments and abstracts no
 * longer up for review are left out and stay pending.
 *
 * Never throws: returns a code the caller reports.
 */
export async function sendPendingAssignments(args: {
  eventId: string;
  organizationId: string | null;
  reviewerUserId: string;
  triggeredByUserId?: string | null;
}): Promise<SendPendingAssignmentsResult> {
  const { eventId, reviewerUserId } = args;
  try {
    const [reviewer, pending] = await Promise.all([
      db.user.findUnique({ where: { id: reviewerUserId }, select: { id: true, firstName: true, lastName: true, email: true } }),
      db.abstractReviewer.findMany({
        where: {
          userId: reviewerUserId,
          notifiedAt: null,
          conflictFlag: false,
          abstract: { eventId, status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] } },
        },
        select: { id: true, role: true, abstract: { select: { title: true } } },
        orderBy: { assignedAt: "asc" },
      }),
    ]);
    if (!reviewer) {
      apiLogger.warn({ msg: "reviewer-assignment:reviewer-not-found", eventId, reviewerUserId });
      return { ok: false, code: "REVIEWER_NOT_FOUND", message: "Reviewer not found" };
    }
    if (pending.length === 0) {
      apiLogger.info({ msg: "reviewer-assignment:nothing-pending", eventId, reviewerUserId });
      return { ok: false, code: "NOTHING_PENDING", message: "Nothing new to send to this reviewer" };
    }

    const tpl = await getEventTemplate(eventId, "reviewer-assignment");
    if (!tpl) {
      apiLogger.warn({ msg: "reviewer-assignment:no-template", eventId });
      return { ok: false, code: "NO_TEMPLATE", message: "The reviewer assignment email template is missing" };
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const titles = pending.map((p) => p.abstract.title);
    const vars = {
      title: await reviewerTitle(eventId, reviewer),
      firstName: reviewer.firstName ?? "",
      lastName: reviewer.lastName ?? "",
      eventName: tpl.branding.eventName ?? "",
      role: roleLabelFor(pending.map((p) => p.role)),
      abstractCount: titles.length,
      reviewLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/my-reviews")}`,
    };
    // The HTML body gets the titles one per line, escaped here and passed raw;
    // the text body gets them as plain lines. Same template, two renders.
    const html = renderAndWrap(tpl, { ...vars, abstractTitle: titles.map(escapeHtml).join("<br>") }, tpl.branding, new Set(["abstractTitle"]));
    const text = renderAndWrap(tpl, { ...vars, abstractTitle: titles.join("\n  ") }, tpl.branding);

    const to = [{ email: reviewer.email, name: `${vars.firstName} ${vars.lastName}`.trim() || reviewer.email }];
    const result = await sendEmail({
      to,
      cc: brandingCc(tpl.branding, to),
      subject: html.subject,
      htmlContent: html.htmlContent,
      textContent: text.textContent,
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
      return { ok: false, code: "SEND_FAILED", message: result.error || "The email could not be sent" };
    }

    await db.abstractReviewer.updateMany({
      where: { id: { in: pending.map((p) => p.id) }, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    apiLogger.info({ msg: "reviewer-assignment:sent", eventId, reviewerUserId, count: pending.length });
    return { ok: true, sent: pending.length };
  } catch (err) {
    apiLogger.error({ err, msg: "reviewer-assignment:send-error", eventId, reviewerUserId });
    return { ok: false, code: "SEND_FAILED", message: "The email could not be sent" };
  }
}

/**
 * Notify a reviewer that they've been added to an event's reviewer pool (the
 * event-level grant — distinct from a per-abstract assignment above).
 *
 * Only for **pre-existing** accounts: a brand-new reviewer account gets the
 * account-setup invitation (`reviewer-invitation`) instead, which doubles as
 * the "you're a reviewer" signal — sending both would be redundant, and a new
 * account can't log in until they set a password anyway.
 *
 * Fully failure-isolated: never throws. A send failure is logged but must NOT
 * fail the add-reviewer request.
 */
export async function notifyReviewerPoolAdded(args: {
  eventId: string;
  organizationId: string | null;
  reviewer: { id: string; firstName: string | null; lastName: string | null; email: string };
  eventName: string;
  triggeredByUserId?: string | null;
}): Promise<void> {
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
      return;
    }
    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: args.eventName };
    const rendered = renderAndWrap(tpl, vars, branding);

    const to = [{ email: args.reviewer.email, name: `${vars.firstName} ${vars.lastName}`.trim() || args.reviewer.email }];
    await sendEmail({
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

    apiLogger.info({ msg: "reviewer-pool:notified", eventId: args.eventId, reviewerUserId: args.reviewer.id });
  } catch (err) {
    apiLogger.error({ err, msg: "reviewer-pool:notify-failed", eventId: args.eventId, reviewerUserId: args.reviewer.id });
  }
}
