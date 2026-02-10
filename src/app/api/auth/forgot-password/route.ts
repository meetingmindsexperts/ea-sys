import crypto from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { dbLogger } from "@/lib/logger";
import { emailTemplates, sendEmail } from "@/lib/email";

const forgotPasswordSchema = z.object({
  email: z.string().email("Please provide a valid email address"),
});

function getPasswordResetIdentifier(email: string) {
  return `password-reset:${email.toLowerCase()}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validated = forgotPasswordSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const email = validated.data.email.toLowerCase();
    const user = await db.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    // Always return success to prevent account enumeration
    if (!user) {
      return NextResponse.json({
        success: true,
        message: "If an account exists, a password reset link has been sent.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    const identifier = getPasswordResetIdentifier(email);

    await db.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({ where: { identifier } });

      await tx.verificationToken.create({
        data: {
          identifier,
          token,
          expires: tokenExpiry,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "FORGOT_PASSWORD_REQUESTED",
          entityType: "User",
          entityId: user.id,
          changes: { email },
        },
      });
    });

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      "http://localhost:3000";
    const resetLink = `${appUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

    const emailTemplate = emailTemplates.passwordReset({
      recipientName: `${user.firstName} ${user.lastName}`,
      resetLink,
      expiresIn: "1 hour",
    });

    const emailResult = await sendEmail({
      to: [{ email: user.email, name: `${user.firstName} ${user.lastName}` }],
      subject: emailTemplate.subject,
      htmlContent: emailTemplate.htmlContent,
      textContent: emailTemplate.textContent,
    });

    if (!emailResult.success) {
      dbLogger.warn({
        msg: "Failed to send password reset email",
        email,
        error: emailResult.error,
      });
    }

    return NextResponse.json({
      success: true,
      message: "If an account exists, a password reset link has been sent.",
    });
  } catch (error) {
    dbLogger.error({ err: error, msg: "Error requesting password reset" });
    return NextResponse.json(
      { error: "Failed to request password reset" },
      { status: 500 }
    );
  }
}
