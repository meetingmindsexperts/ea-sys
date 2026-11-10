import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
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

/**
 * Notify a reviewer that they've been assigned a specific abstract to review.
 *
 * Called from BOTH the REST assign route and the MCP `assign_reviewer_to_abstract`
 * executor — only on a *new* assignment (not idempotent re-assigns or role/COI
 * flips), so a reviewer isn't re-emailed when an organizer toggles their role.
 *
 * Fully failure-isolated: this never throws. A send failure is logged but must
 * NOT roll back or fail the assignment itself.
 */
const ROLE_LABELS: Record<string, string> = {
  PRIMARY: "Primary reviewer",
  SECONDARY: "Secondary reviewer",
  CONSULTING: "Consulting reviewer",
};

export async function notifyReviewerAssigned(args: {
  eventId: string;
  organizationId: string | null;
  reviewer: { id: string; firstName: string | null; lastName: string | null; email: string };
  eventName: string;
  abstractTitle: string;
  role: string;
  source: "rest" | "mcp" | "agent";
  triggeredByUserId?: string | null;
}): Promise<void> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const vars = {
      title: await reviewerTitle(args.eventId, args.reviewer),
      firstName: args.reviewer.firstName ?? "",
      lastName: args.reviewer.lastName ?? "",
      eventName: args.eventName,
      abstractTitle: args.abstractTitle,
      role: ROLE_LABELS[args.role] ?? "Reviewer",
      reviewLink: `${appUrl}/login?callbackUrl=${encodeURIComponent("/my-reviews")}`,
    };

    const tpl = (await getEventTemplate(args.eventId, "reviewer-assignment"))
      || getDefaultTemplate("reviewer-assignment");
    if (!tpl) {
      apiLogger.warn({ msg: "No template found for reviewer-assignment", eventId: args.eventId });
      return;
    }
    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: args.eventName };
    const rendered = renderAndWrap(tpl, vars, branding);

    await sendEmail({
      to: [{ email: args.reviewer.email, name: `${vars.firstName} ${vars.lastName}`.trim() || args.reviewer.email }],
      ...rendered,
      from: brandingFrom(branding),
      emailType: "reviewer_assignment",
      stream: "transactional",
      logContext: {
        organizationId: args.organizationId,
        eventId: args.eventId,
        entityType: "USER",
        entityId: args.reviewer.id,
        templateSlug: "reviewer-assignment",
        triggeredByUserId: args.triggeredByUserId ?? null,
      },
    });

    apiLogger.info({
      msg: "reviewer-assignment:notified",
      eventId: args.eventId,
      reviewerUserId: args.reviewer.id,
      source: args.source,
    });
  } catch (err) {
    apiLogger.error({ err, msg: "reviewer-assignment:notify-failed", eventId: args.eventId, reviewerUserId: args.reviewer.id });
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

    await sendEmail({
      to: [{ email: args.reviewer.email, name: `${vars.firstName} ${vars.lastName}`.trim() || args.reviewer.email }],
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
