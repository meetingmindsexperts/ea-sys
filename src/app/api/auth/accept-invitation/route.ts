import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";

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
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const validated = acceptInvitationSchema.safeParse(body);

    if (!validated.success) {
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

    // Find the user
    const user = await db.user.findUnique({
      where: { email },
    });

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
      await tx.user.update({
        where: { email },
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
          action: "ACCEPT_INVITATION",
          entityType: "User",
          entityId: user.id,
          changes: { email },
        },
      });
    });

    apiLogger.info({
      msg: "User accepted invitation",
      email,
      userId: user.id,
    });

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

    // Get user info
    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        organization: {
          select: { name: true },
        },
      },
    });

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
