import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";
import { getClientIp, hashVerificationToken, checkRateLimit } from "@/lib/security";

const inviteUserSchema = z.object({
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: z.enum(["ADMIN", "ORGANIZER", "REVIEWER"]),
});

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only org members (ADMIN, SUPER_ADMIN, ORGANIZER) can list users
    if (!session.user.organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const users = await db.user.findMany({
      where: { organizationId: session.user.organizationId! },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        image: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(users);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching users" });
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const [session, body] = await Promise.all([auth(), req.json()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only admins can invite users
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const inviteLimit = checkRateLimit({
      key: `user-invite:org:${session.user.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000, // 10 invitations per hour per org
    });
    if (!inviteLimit.allowed) {
      return NextResponse.json(
        { error: "Invitation limit reached. Maximum 10 invitations per hour." },
        { status: 429, headers: { "Retry-After": String(inviteLimit.retryAfterSeconds) } }
      );
    }

    const validated = inviteUserSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { firstName, lastName, role } = validated.data;
    const email = validated.data.email.toLowerCase();

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User with this email already exists" },
        { status: 400 }
      );
    }

    // Generate a secure invitation token
    const invitationToken = crypto.randomBytes(32).toString("hex");
    const invitationTokenHash = hashVerificationToken(invitationToken);
    const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Create a placeholder password hash (user will set their own via invitation link)
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);

    // Get organization name for the email
    const organization = await db.organization.findUnique({
      where: { id: session.user.organizationId! },
      select: { name: true },
    });

    // Send invitation email BEFORE creating the user — if email fails, don't
    // leave an orphaned user record that blocks re-invitation.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const setupLink = `${appUrl}/accept-invitation?token=${invitationToken}&email=${encodeURIComponent(email)}`;

    const inviterName = session.user.firstName && session.user.lastName
      ? `${session.user.firstName} ${session.user.lastName}`
      : session.user.email || "A team member";

    const roleDisplayName = role === "ADMIN" ? "Admin" : role === "ORGANIZER" ? "Organizer" : "Reviewer";

    const emailTemplate = emailTemplates.userInvitation({
      recipientName: `${firstName} ${lastName}`,
      recipientEmail: email,
      organizationName: organization?.name || "your organization",
      inviterName,
      role: roleDisplayName,
      setupLink,
      expiresIn: "7 days",
    });

    // Note: the invited user doesn't exist yet — we send first, then create the
    // user + token atomically if the email succeeds. So entityId is null; the
    // log row is still searchable by email + templateSlug.
    const emailResult = await sendEmail({
      to: [{ email, name: `${firstName} ${lastName}` }],
      subject: emailTemplate.subject,
      htmlContent: emailTemplate.htmlContent,
      textContent: emailTemplate.textContent,
      logContext: {
        organizationId: session.user.organizationId,
        entityType: "USER",
        templateSlug: "user-invitation",
        triggeredByUserId: session.user.id,
      },
    });

    if (!emailResult.success) {
      apiLogger.warn({ msg: "Failed to send invitation email", email, error: emailResult.error });
      return NextResponse.json(
        { error: "Failed to send invitation email. Please check the email address and try again." },
        { status: 502 }
      );
    }

    // Email sent successfully — now create the user + token atomically
    const user = await db.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          organizationId: session.user.organizationId!,
          email,
          firstName,
          lastName,
          role,
          passwordHash: placeholderHash,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          createdAt: true,
        },
      });

      // Store invitation token
      await tx.verificationToken.create({
        data: {
          identifier: email,
          token: invitationTokenHash,
          expires: tokenExpiry,
        },
      });

      // Log the action
      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          action: "INVITE_USER",
          entityType: "User",
          entityId: newUser.id,
          changes: { email, firstName, lastName, role, ip: getClientIp(req) },
        },
      });

      return newUser;
    });

    return NextResponse.json(
      {
        ...user,
        invitationSent: true,
        message: "Invitation email sent successfully",
      },
      { status: 201 }
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating user" });
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 }
    );
  }
}
