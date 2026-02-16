import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { dbLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";

const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string().min(6),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

function getPasswordResetIdentifier(email: string) {
  return `password-reset:${email.toLowerCase()}`;
}

export async function POST(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `reset-password:post:ip:${clientIp}`,
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
    const validated = resetPasswordSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { token, password } = validated.data;
    const email = validated.data.email.toLowerCase();
    const identifier = getPasswordResetIdentifier(email);
    const tokenHash = hashVerificationToken(token);

    const verificationToken = await db.verificationToken.findFirst({
      where: {
        identifier,
        token: tokenHash,
      },
    });

    if (!verificationToken) {
      return NextResponse.json(
        { error: "Invalid or expired reset link" },
        { status: 400 }
      );
    }

    if (verificationToken.expires < new Date()) {
      await db.verificationToken.delete({
        where: {
          identifier_token: {
            identifier,
            token: tokenHash,
          },
        },
      });

      return NextResponse.json(
        { error: "Reset link has expired. Please request a new one." },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({ where: { email } });

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      await tx.verificationToken.delete({
        where: {
          identifier_token: {
            identifier,
            token: tokenHash,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "PASSWORD_RESET",
          entityType: "User",
          entityId: user.id,
          changes: { email },
        },
      });
    });

    return NextResponse.json({
      success: true,
      message: "Password reset successful. You can now sign in.",
    });
  } catch (error) {
    dbLogger.error({ err: error, msg: "Error resetting password" });
    return NextResponse.json(
      { error: "Failed to reset password" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `reset-password:get:ip:${clientIp}`,
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
        { valid: false, error: "Missing token or email" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase();
    const identifier = getPasswordResetIdentifier(normalizedEmail);
    const tokenHash = hashVerificationToken(token);
    const verificationToken = await db.verificationToken.findFirst({
      where: {
        identifier,
        token: tokenHash,
      },
    });

    if (!verificationToken) {
      return NextResponse.json(
        { valid: false, error: "Invalid reset link" },
        { status: 400 }
      );
    }

    if (verificationToken.expires < new Date()) {
      return NextResponse.json(
        { valid: false, error: "Reset link has expired" },
        { status: 400 }
      );
    }

    return NextResponse.json({ valid: true });
  } catch (error) {
    dbLogger.error({ err: error, msg: "Error validating reset token" });
    return NextResponse.json(
      { error: "Failed to validate reset link" },
      { status: 500 }
    );
  }
}
