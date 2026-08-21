import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { createNotification } from "@/lib/notifications";
import { findUserByEmail, scopeFromRequestHost } from "@/lib/tenant/user-lookup";

const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export async function POST(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `accept-invitation:post:ip:${clientIp}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      apiLogger.warn({ msg: "auth/accept-invitation:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const validated = acceptInvitationSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "auth/accept-invitation:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { token, password } = validated.data;
    const email = validated.data.email.toLowerCase();
    const tokenHash = hashVerificationToken(token);

    // Find the verification token
    const verificationToken = await db.verificationToken.findFirst({
      where: {
        identifier: email,
        token: tokenHash,
      },
    });

    if (!verificationToken) {
      return NextResponse.json(
        { error: "Invalid or expired invitation link" },
        { status: 400 }
      );
    }

    // Check if token has expired
    if (verificationToken.expires < new Date()) {
      // Delete expired token
      await db.verificationToken.delete({
        where: {
          identifier_token: {
            identifier: email,
            token: tokenHash,
          },
        },
      });

      return NextResponse.json(
        { error: "Invitation has expired. Please contact your administrator for a new invitation." },
        { status: 400 }
      );
    }

    // The token proves the mailbox; the HOST proves the tenant. On the platform
    // one address may be two accounts, and VerificationToken is keyed on the
    // address alone, so the link's own domain is the only thing that says which
    // account is being activated.
    const user = await findUserByEmail(
      await scopeFromRequestHost(req, "invitation acceptance: host did not resolve to a tenant"),
      email,
      { select: { id: true, organizationId: true, firstName: true, lastName: true, role: true } },
    );

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    // Hash the new password
    const passwordHash = await bcrypt.hash(password, 10);

    // Update user and delete token in a transaction
    await db.$transaction(async (tx) => {
      // By id, not by email. `update({ where: { email } })` needs email to be
      // unique, and on the platform it is only unique per tenant — Prisma would
      // still compile it (its client believes the old @unique) and the DB would
      // no longer guarantee it addresses one row.
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          emailVerified: new Date(),
        },
      });

      await tx.verificationToken.delete({
        where: {
          identifier_token: {
            identifier: email,
            token: tokenHash,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          // org-null actors (registrants/reviewers) correctly stamp null here
          organizationId: user.organizationId,
          action: "ACCEPT_INVITATION",
          entityType: "User",
          entityId: user.id,
          changes: { email, ip: getClientIp(req) },
        },
      });
    });

    apiLogger.info({
      msg: "User accepted invitation",
      email,
      userId: user.id,
    });

    // Notify org admins of new team member (non-blocking)
    if (user.organizationId) {
      db.user.findMany({
        where: {
          organizationId: user.organizationId,
          role: { in: ["SUPER_ADMIN", "ADMIN"] },
          id: { not: user.id },
        },
        select: { id: true },
      }).then((admins) => {
        for (const admin of admins) {
          createNotification({
            userId: admin.id,
            type: "SIGNUP",
            title: "Team Member Joined",
            message: `${user.firstName} ${user.lastName} (${email}) accepted their invitation and set up their account`,
            link: "/settings",
          });
        }
      }).catch((err) => apiLogger.warn({ err, msg: "accept-invitation:notify-admins-failed" }));
    }

    return NextResponse.json({
      success: true,
      message: "Account setup complete. You can now sign in.",
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error accepting invitation" });
    return NextResponse.json(
      { error: "Failed to complete account setup" },
      { status: 500 }
    );
  }
}

// GET endpoint to validate the token without setting password
export async function GET(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `accept-invitation:get:ip:${clientIp}`,
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      apiLogger.warn({ msg: "auth/accept-invitation:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { valid: false, error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const { searchParams } = new URL(req.url);
    const token = searchParams.get("token");
    const email = searchParams.get("email");

    if (!token || !email) {
      return NextResponse.json(
        { error: "Missing token or email" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase();
    const tokenHash = hashVerificationToken(token);

    // Find the verification token
    const verificationToken = await db.verificationToken.findFirst({
      where: {
        identifier: normalizedEmail,
        token: tokenHash,
      },
    });

    if (!verificationToken) {
      return NextResponse.json(
        { valid: false, error: "Invalid invitation link" },
        { status: 400 }
      );
    }

    // Check if token has expired
    if (verificationToken.expires < new Date()) {
      return NextResponse.json(
        { valid: false, error: "Invitation has expired" },
        { status: 400 }
      );
    }

    // Same rule as the POST: host decides which tenant's invitation this is.
    const user = await findUserByEmail(
      await scopeFromRequestHost(req, "invitation preview: host did not resolve to a tenant"),
      normalizedEmail,
      {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          organization: {
            select: { name: true },
          },
        },
      },
    );

    if (!user) {
      return NextResponse.json(
        { valid: false, error: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      valid: true,
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        organizationName: user.organization?.name ?? null,
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error validating invitation" });
    return NextResponse.json(
      { error: "Failed to validate invitation" },
      { status: 500 }
    );
  }
}
