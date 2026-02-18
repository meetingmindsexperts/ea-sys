import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { sendEmail, emailTemplates } from "@/lib/email";
import { hashVerificationToken } from "@/lib/security";

const addReviewerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speaker"), speakerId: z.string().min(1) }),
  z.object({ type: z.literal("direct"), email: z.string().email(), firstName: z.string().min(1), lastName: z.string().min(1) }),
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

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, speakers] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
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
          select: { id: true, email: true, firstName: true, lastName: true, emailVerified: true },
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

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = addReviewerSchema.safeParse(body);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, name: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const reviewerUserIds = (settings.reviewerUserIds as string[]) || [];

    let userId: string;
    let invitationSent = false;
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
        const result = await findOrCreateReviewerUser(
          speaker.email, speaker.firstName, speaker.lastName, session
        );
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        userId = result.userId;
        invitationSent = result.invitationSent;

        // Link speaker to user
        await db.speaker.update({
          where: { id: speaker.id },
          data: { userId },
        });
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
      invitationSent = result.invitationSent;
    }

    // Check if already assigned
    if (reviewerUserIds.includes(userId)) {
      return NextResponse.json(
        { error: "This person is already a reviewer for this event" },
        { status: 400 }
      );
    }

    // Update event settings
    await db.event.update({
      where: { id: eventId },
      data: {
        settings: {
          ...settings,
          reviewerUserIds: [...reviewerUserIds, userId],
        },
      },
    });

    // Audit log (non-blocking)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "CREATE",
        entityType: "EventReviewer",
        entityId: userId,
        changes: { type: validated.data.type, email: reviewerEmail, invitationSent },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json(
      {
        success: true,
        userId,
        invitationSent,
        message: invitationSent
          ? "Reviewer added and invitation email sent"
          : "Reviewer added to event",
      },
      { status: 201 }
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error adding reviewer" });
    return NextResponse.json(
      { error: "Failed to add reviewer" },
      { status: 500 }
    );
  }
}

// Shared helper: find existing REVIEWER user or create one with invitation
async function findOrCreateReviewerUser(
  email: string,
  firstName: string,
  lastName: string,
  session: { user: { organizationId?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null } }
): Promise<{ userId: string; invitationSent: boolean } | { error: string }> {
  const normalizedEmail = email.toLowerCase();

  const existingUser = await db.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, role: true },
  });

  if (existingUser) {
    // Reviewers are org-independent, so no cross-org check needed
    if (existingUser.role !== "REVIEWER") {
      return { error: `User already exists with role ${existingUser.role}. Change their role in Settings > Users first.` };
    }
    return { userId: existingUser.id, invitationSent: false };
  }

  // Create new REVIEWER User with invitation (no organizationId — reviewers are org-independent)
  const invitationToken = crypto.randomBytes(32).toString("hex");
  const invitationTokenHash = hashVerificationToken(invitationToken);
  const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);

  const newUser = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        firstName,
        lastName,
        role: "REVIEWER",
        passwordHash: placeholderHash,
      },
      select: { id: true },
    });

    await tx.verificationToken.create({
      data: {
        identifier: normalizedEmail,
        token: invitationTokenHash,
        expires: tokenExpiry,
      },
    });

    return user;
  });

  // Send invitation email
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
  const setupLink = `${appUrl}/accept-invitation?token=${invitationToken}&email=${encodeURIComponent(normalizedEmail)}`;

  const organization = session.user.organizationId
    ? await db.organization.findUnique({
        where: { id: session.user.organizationId! },
        select: { name: true },
      })
    : null;

  const inviterName = session.user.firstName && session.user.lastName
    ? `${session.user.firstName} ${session.user.lastName}`
    : session.user.email || "A team member";

  const emailTemplate = emailTemplates.userInvitation({
    recipientName: `${firstName} ${lastName}`,
    recipientEmail: email,
    organizationName: organization?.name || "your organization",
    inviterName,
    role: "Reviewer",
    setupLink,
    expiresIn: "7 days",
  });

  const emailResult = await sendEmail({
    to: [{ email: normalizedEmail, name: `${firstName} ${lastName}` }],
    subject: emailTemplate.subject,
    htmlContent: emailTemplate.htmlContent,
    textContent: emailTemplate.textContent,
  });

  if (!emailResult.success) {
    apiLogger.warn({
      msg: "Failed to send reviewer invitation email",
      email: normalizedEmail,
      error: emailResult.error,
    });
  }

  return { userId: newUser.id, invitationSent: emailResult.success };
}
