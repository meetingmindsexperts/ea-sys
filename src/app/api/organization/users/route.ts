import { NextResponse } from "next/server";
import { z } from "zod";
import { isHrModuleEnabled } from "@/lib/module-flags";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { findUserByEmail, userEmailScope, isUniqueViolation } from "@/lib/tenant/user-lookup";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";
import { getClientIp, hashVerificationToken, checkRateLimit } from "@/lib/security";
import { TEAM_ROLES, isTeamRole, ASSIGNABLE_USER_ROLES } from "@/lib/auth-guards";
import { isInternalEmail } from "@/lib/internal-domains";
import { UserRole } from "@prisma/client";

/** Human label for a team role (used in invite emails + promote messages). */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  ORGANIZER: "Organizer",
  MEMBER: "Member",
  ONSITE: "Onsite Staff",
  WEBINARS: "Webinars",
  REVIEWER: "Reviewer",
  CRM_USER: "CRM User",
  HR_USER: "HR User",
};

/**
 * HR_USER is only grantable where the HR module is switched on. The enum value
 * exists on every silo because the enum is shared, but existing and being
 * grantable are different questions: on the platform instance the module is off,
 * so the role would be a login that can reach nothing at all.
 *
 * This is the authoritative check. The Settings dropdown hides the option, but a
 * dropdown is UX and this is the boundary.
 */
function roleIsGrantableHere(role: string): boolean {
  return role !== "HR_USER" || isHrModuleEnabled();
}

const inviteUserSchema = z.object({
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  // MEMBER + ONSITE were offered in the Settings dropdown but missing here
  // (MEMBER invites would have 400'd); both are now accepted. All of these are
  // org-bound team roles created under the inviter's organization.
  role: z.enum(ASSIGNABLE_USER_ROLES),
  // Optional admin-set password. When present, the account is created active +
  // verified with NO invitation email — for temp accounts whose address may not
  // be a real mailbox (e.g. event-day staff). The admin hands over the
  // credentials directly. When absent, the normal email-invitation flow runs.
  password: z.string().min(8).max(200).optional(),
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

    // Team members only — an org can also contain org-bound REGISTRANTs
    // (internal-domain attendees), which are NOT staff and must not appear in
    // the Users list. Filter to actual team roles.
    const users = await db.user.findMany({
      where: {
        organizationId: session.user.organizationId!,
        role: { in: [...TEAM_ROLES] as UserRole[] },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        // So Settings can show who has been granted HR without a second call.
        hrAccess: true,
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

    // Admins can invite any team role. ORGANIZER is admitted too, but ONLY to
    // create ONSITE (registration-desk temp) accounts — enforced on the parsed
    // role below, so an organizer can't invite admins/organizers.
    const callerRole = session.user.role;
    if (callerRole !== "ADMIN" && callerRole !== "SUPER_ADMIN" && callerRole !== "ORGANIZER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const inviteLimit = checkRateLimit({
      key: `user-invite:org:${session.user.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000, // 10 invitations per hour per org
    });
    if (!inviteLimit.allowed) {
      apiLogger.warn({ msg: "organization/users:rate-limited", retryAfterSeconds: inviteLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Invitation limit reached. Maximum 10 invitations per hour." },
        { status: 429, headers: { "Retry-After": String(inviteLimit.retryAfterSeconds) } }
      );
    }

    const validated = inviteUserSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "organization/users:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { firstName, lastName, role, password } = validated.data;
    const email = validated.data.email.toLowerCase();

    if (!roleIsGrantableHere(role)) {
      apiLogger.warn({
        msg: "organization/users:role-not-grantable-on-this-deployment",
        role,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "That role is not available on this deployment." },
        { status: 400 },
      );
    }

    if (callerRole === "ORGANIZER" && role !== "ONSITE") {
      apiLogger.warn({
        msg: "organization/users:organizer-role-not-allowed",
        requestedRole: role,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Organizers can only create Onsite Staff accounts.", code: "ONSITE_ONLY" },
        { status: 403 },
      );
    }

    // Check if user already exists — in THIS org or org-independent. The
    // org-independent half is load-bearing: REGISTRANT/SUBMITTER/REVIEWER
    // accounts carry no org, and finding them is what turns this invite into a
    // PROMOTE rather than a blocked duplicate. They never appear in the
    // team-members list (GET filters by organizationId), so a blocked invite
    // can look like it "vanished"; we log the collision with the existing
    // account's role/org so it's diagnosable.
    //
    // Scoped rather than global since Aug 21 2026 (per-tenant email, item 6).
    // On master this is a no-op — there is exactly one organisation, so "this
    // org OR no org" is the whole table. The foreign-org branch below is
    // therefore unreachable today and stays only as the honest answer if a
    // second org ever appears while email is still globally unique; the create
    // maps P2002 to the same 409, so neither ordering can 500.
    const existingUser = await findUserByEmail(
      userEmailScope(session.user.organizationId, "invite: signed-in admin carries no org"),
      email,
      { select: { id: true, role: true, organizationId: true } },
    );

    if (existingUser) {
      const sameOrg = existingUser.organizationId === session.user.organizationId;
      const orgIndependent = existingUser.organizationId == null;

      // Already a team member of THIS org — manage them from the list instead.
      if (sameOrg && isTeamRole(existingUser.role)) {
        apiLogger.warn({
          msg: "organization/users:invite-already-team-member",
          email,
          existingUserId: existingUser.id,
          existingRole: existingUser.role,
          organizationId: session.user.organizationId,
        });
        return NextResponse.json(
          { error: "This email is already a team member of your organization.", code: "ALREADY_TEAM_MEMBER" },
          { status: 409 }
        );
      }

      // Belongs to a DIFFERENT organization — we don't absorb other orgs' users.
      if (!orgIndependent && !sameOrg) {
        apiLogger.warn({
          msg: "organization/users:invite-foreign-org",
          email,
          existingUserId: existingUser.id,
          existingRole: existingUser.role,
          existingOrg: existingUser.organizationId,
          organizationId: session.user.organizationId,
        });
        return NextResponse.json(
          { error: "This email already belongs to a user in another organization.", code: "EMAIL_IN_OTHER_ORG" },
          { status: 409 }
        );
      }

      // PROMOTE: an org-independent account (REGISTRANT/SUBMITTER/REVIEWER) — or
      // an org-bound non-team account already in THIS org (e.g. an
      // internal-domain registrant) — is attached to our org and given the
      // invited team role. The user keeps their existing password and any
      // linked registrations; this is how an internal attendee becomes staff
      // without the global-email check blocking the invite.
      const promoted = await db.user.update({
        where: { id: existingUser.id },
        data: { organizationId: session.user.organizationId!, role },
        select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
      });

      apiLogger.info({
        msg: "organization/users:invite-promoted-existing",
        email,
        userId: promoted.id,
        fromRole: existingUser.role,
        toRole: role,
        organizationId: session.user.organizationId,
        invitedByUserId: session.user.id,
        wasInternalDomain: isInternalEmail(email),
      });

      db.auditLog
        .create({
          data: {
            userId: session.user.id,
            organizationId: session.user.organizationId ?? null,
            action: "PROMOTE_USER",
            entityType: "User",
            entityId: promoted.id,
            changes: { email, fromRole: existingUser.role, toRole: role, ip: getClientIp(req) },
          },
        })
        .catch((err: unknown) =>
          apiLogger.error({ err, msg: "Failed to write PROMOTE_USER audit log", id: promoted.id })
        );

      return NextResponse.json(
        {
          ...promoted,
          promoted: true,
          message: `${promoted.firstName || "User"}'s existing account was promoted to ${ROLE_LABELS[role] ?? role}.`,
        },
        { status: 200 }
      );
    }

    // ── Admin-set-password path (no invitation email) ──────────────────────
    // For temp accounts whose address may not be a real mailbox: create the
    // account active + verified with the admin-chosen password. No email/token.
    // The admin hands the email + password to the person directly.
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await db.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            organizationId: session.user.organizationId,
            email,
            firstName,
            lastName,
            role,
            passwordHash,
            emailVerified: new Date(),
          },
          select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
        });
        await tx.auditLog.create({
          data: {
            userId: session.user.id,
            organizationId: session.user.organizationId ?? null,
            action: "CREATE_USER",
            entityType: "User",
            entityId: newUser.id,
            changes: { email, firstName, lastName, role, mode: "password", ip: getClientIp(req) },
          },
        });
        return newUser;
      });

      apiLogger.info({
        msg: "organization/users:created-with-password",
        email,
        role,
        userId: user.id,
        organizationId: session.user.organizationId,
        invitedByUserId: session.user.id,
      });

      return NextResponse.json(
        {
          ...user,
          passwordSet: true,
          message: `Account created. Share the email and password with ${firstName} — they can sign in now.`,
        },
        { status: 201 }
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

    const roleDisplayName = ROLE_LABELS[role] ?? role;

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
      emailType: "user_invitation",
      stream: "transactional",
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
          organizationId: session.user.organizationId ?? null,
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
    // The pre-check above answers "does an account already hold this address?"
    // by READING, and a read cannot be a guarantee: two admins inviting the
    // same person concurrently both pass it, and the losing INSERT raises
    // P2002. Map it to the same 409 the pre-check would have returned, so the
    // constraint — not the read — is what actually decides, and neither
    // ordering can produce a 500. This also keeps the answer right if the
    // deployment's uniqueness rule is narrower than the pre-check's scope.
    if (isUniqueViolation(error)) {
      apiLogger.warn({ msg: "organization/users:invite-email-taken-race" });
      return NextResponse.json(
        { error: "An account with this email already exists.", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error creating user" });
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 }
    );
  }
}
