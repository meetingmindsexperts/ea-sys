import { mustConfirmEmailToReview } from "@/lib/abstract-reviewer-access";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { findUserByEmail, userEmailScope, isUniqueViolation } from "@/lib/tenant/user-lookup";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { isLinkedRole, requirePermission } from "@/lib/permissions/require-permission";
import { updateEventSettings } from "@/lib/event-settings";
import { getClientIp } from "@/lib/security";
import { syncToContact } from "@/lib/contact-sync";

const addReviewerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speaker"), speakerId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("direct"), email: z.string().email().max(255), firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100) }),
]);

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/reviewers:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "reviewers.pool.manage", { route: "events/[eventId]/reviewers:GET", eventId });
    if (!gate.ok) return gate.response;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
    const [event, speakers] = await Promise.all([
      db.event.findFirst({
        where: gate.eventWhere,
        select: { id: true, settings: true },
      }),
      db.speaker.findMany({
        where: { eventId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          organization: true,
          jobTitle: true,
          status: true,
          userId: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const reviewerUserIds = (settings.reviewerUserIds as string[]) || [];

    // Fetch reviewer User records
    const reviewerUsers = reviewerUserIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: reviewerUserIds } },
          select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true, role: true, emailConfirmedAt: true },
        })
      : [];

    const reviewerUserMap = new Map(reviewerUsers.map((u) => [u.id, u]));

    // Build reviewers list: speakers whose userId is in reviewerUserIds
    const reviewers = speakers
      .filter((s) => s.userId && reviewerUserIds.includes(s.userId))
      .map((s) => {
        const user = s.userId ? reviewerUserMap.get(s.userId) : null;
        return {
          speakerId: s.id,
          userId: s.userId,
          firstName: s.firstName,
          lastName: s.lastName,
          email: s.email,
          organization: s.organization,
          jobTitle: s.jobTitle,
          speakerStatus: s.status as string | null,
          accountActive: !!user?.emailVerified,
          needsEmailConfirmation: !!user && mustConfirmEmailToReview(user),
        };
      });

    // Also include reviewers who are Users but NOT linked to a speaker
    for (const userId of reviewerUserIds) {
      const alreadyIncluded = reviewers.some((r) => r.userId === userId);
      if (!alreadyIncluded) {
        const user = reviewerUserMap.get(userId);
        if (user) {
          reviewers.push({
            speakerId: "",
            userId,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            organization: null,
            jobTitle: null,
            speakerStatus: null,
            accountActive: !!user.emailVerified,
            needsEmailConfirmation: mustConfirmEmailToReview(user),
          });
        }
      }
    }

    // Available speakers: those not already reviewers
    const reviewerSpeakerIds = new Set(reviewers.map((r) => r.speakerId));
    const availableSpeakers = speakers.filter((s) => !reviewerSpeakerIds.has(s.id));

    const response = NextResponse.json({ reviewers, availableSpeakers });
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching reviewers" });
    return NextResponse.json(
      { error: "Failed to fetch reviewers" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/reviewers:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "reviewers.pool.manage", { route: "events/[eventId]/reviewers:POST", eventId });
    if (!gate.ok) return gate.response;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
    const validated = addReviewerSchema.safeParse(body);
    if (!validated.success) {
        apiLogger.warn({ msg: "events/reviewers:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const event = await db.event.findFirst({
      where: gate.eventWhere,
      select: { id: true, name: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const reviewerUserIds = (settings.reviewerUserIds as string[]) || [];

    // Adding a reviewer sends no email (owner, Nov 10, 2026: "disable auto
    // email trigger on reviewer addition, send email manually"). The Reviewers
    // page's Send button does it: the setup invitation for a new account, the
    // "added as a reviewer" email for one that can already sign in.
    let userId: string;
    let reviewerEmail: string;

    if (validated.data.type === "speaker") {
      // ---- Add from speaker ----
      const { speakerId } = validated.data;

      const speaker = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: { id: true, email: true, firstName: true, lastName: true, userId: true },
      });

      if (!speaker) {
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }

      reviewerEmail = speaker.email;

      if (speaker.userId) {
        userId = speaker.userId;
      } else {
        const result = await findOrCreateReviewerUser(speaker.email, speaker.firstName, speaker.lastName, session);
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        userId = result.userId;

        // Link speaker to user. An existing account must have proven the address
        // first (the rule in speaker-companion.ts): a speaker record and its
        // abstracts must not go to whoever signed up on that address.
        if (!result.existed || result.confirmed) {
          await db.speaker.update({
            where: { id: speaker.id },
            data: { userId },
          });
        } else {
          apiLogger.warn({ msg: "events/reviewers:speaker-not-linked-unconfirmed", eventId, speakerId: speaker.id, userId });
        }
      }
    } else {
      // ---- Add by email directly ----
      const { email, firstName, lastName } = validated.data;
      reviewerEmail = email;

      const result = await findOrCreateReviewerUser(email, firstName, lastName, session);
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      userId = result.userId;
    }

    // Check if already assigned
    if (reviewerUserIds.includes(userId)) {
      return NextResponse.json(
        { error: "This person is already a reviewer for this event" },
        { status: 400 }
      );
    }

    // Update event settings — atomic append against the freshly-locked
    // reviewerUserIds so concurrent reviewer adds (or a parallel settings
    // write to another key) can't drop each other.
    await updateEventSettings(eventId, (cur) => ({
      ...cur,
      // Dedupe inside the lock: the "already a reviewer" guard above reads a
      // pre-lock snapshot, so two concurrent adds of the same user could both
      // pass it — a Set keeps reviewerUserIds free of duplicates.
      reviewerUserIds: Array.from(new Set([...((cur.reviewerUserIds as string[]) ?? []), userId])),
    }));

    // Sync reviewer to org contact store (fire-and-forget)
    if (validated.data.type === "speaker") {
      // Speaker data already has rich fields — fetch them
      const spk = await db.speaker.findFirst({
        where: { id: validated.data.speakerId, eventId },
        select: { email: true, firstName: true, lastName: true, title: true, organization: true, jobTitle: true, phone: true, photo: true, city: true, country: true, bio: true, specialty: true, registrationType: true },
      });
      if (spk) {
        await syncToContact({
          organizationId: orgGuard.orgId,
          eventId,
          email: spk.email,
          firstName: spk.firstName,
          lastName: spk.lastName,
          title: spk.title,
          organization: spk.organization,
          jobTitle: spk.jobTitle,
          phone: spk.phone,
          photo: spk.photo,
          city: spk.city,
          country: spk.country,
          bio: spk.bio,
          specialty: spk.specialty,
          registrationType: spk.registrationType,
        });
      }
    } else {
      await syncToContact({
        organizationId: orgGuard.orgId,
        eventId,
        email: validated.data.email,
        firstName: validated.data.firstName,
        lastName: validated.data.lastName,
      });
    }

    // Audit log (non-blocking)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "EventReviewer",
        entityId: userId,
        changes: { type: validated.data.type, email: reviewerEmail, emailed: false, ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(
      {
        success: true,
        userId,
        invitationSent: false,
        message: "Reviewer added. No email was sent: use Send on their row when you are ready.",
      },
      { status: 201 }
    );
    });
  } catch (error) {
    // Same reasoning as the team invite: the existence pre-check is a read, so
    // a concurrent add of the same address loses the INSERT with P2002. Answer
    // it the way the pre-check would rather than 500.
    if (isUniqueViolation(error)) {
      apiLogger.warn({ msg: "reviewers:add-email-taken-race" });
      return NextResponse.json(
        { error: "An account with this email already exists.", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error adding reviewer" });
    return NextResponse.json(
      { error: "Failed to add reviewer" },
      { status: 500 }
    );
  }
}

// Shared helper: find an existing outside account or create a REVIEWER. Sends
// nothing: the organiser emails reviewers by hand (owner, Nov 10, 2026).
async function findOrCreateReviewerUser(
  email: string,
  firstName: string,
  lastName: string,
  session: { user: { id: string; organizationId?: string | null } },
): Promise<{ userId: string; existed: boolean; confirmed?: boolean } | { error: string }> {
  const normalizedEmail = email.toLowerCase();

  // Reviewers are created org-independent, so the org-less half of this scope
  // is what actually finds them; the org half only matters on the platform,
  // where a same-address account in ANOTHER tenant must not block this invite.
  const existingUser = await findUserByEmail(
    userEmailScope(session.user.organizationId, "reviewer invite: caller carries no org"),
    normalizedEmail,
    { select: { id: true, role: true, emailConfirmedAt: true } },
  );

  if (existingUser) {
    // Reviewers are org-independent, so no cross-org check needed. Review rights
    // follow the pool, not the role (abstract-reviewer-access.ts), so a speaker's
    // SUBMITTER account joins as it is; only staff accounts are refused here.
    if (!isLinkedRole(existingUser.role)) {
      return { error: `User already exists with role ${existingUser.role}. Change their role in Settings > Users first.` };
    }
    return { userId: existingUser.id, existed: true, confirmed: !!existingUser.emailConfirmedAt };
  }

  // A new REVIEWER account (no organizationId: reviewers are org-independent),
  // with no setup link yet. The link is minted when the organiser sends the
  // invitation from the Reviewers page (resend-invitation route).
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const newUser = await db.user.create({
    data: {
      email: normalizedEmail,
      firstName,
      lastName,
      role: "REVIEWER",
      passwordHash: placeholderHash,
    },
    select: { id: true },
  });

  return { userId: newUser.id, existed: false };
}
