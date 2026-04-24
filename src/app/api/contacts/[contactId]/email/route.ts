import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { normalizeEmail } from "@/lib/email-change";

// PATCH changes the canonical email on a Contact row. Contact is an
// org-scoped CRM snapshot — it has no direct User FK, and Speakers /
// Registrations that sourced it are NOT auto-updated (use their own
// change-email flows for that). This route only performs the
// collision check on Contact.(organizationId, email) and writes an
// audit entry.
const changeEmailSchema = z.object({
  newEmail: z.string().email().max(255),
});

type RouteParams = { params: Promise<{ contactId: string }> };

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ contactId }, ctx] = await Promise.all([params, getOrgContext(req)]);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (ctx.role === "REVIEWER" || ctx.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const changeLimit = checkRateLimit({
      key: `contact-email-change:org:${ctx.organizationId}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!changeLimit.allowed) {
      return NextResponse.json(
        { error: "Email change rate limit reached. Maximum 30 per hour." },
        { status: 429, headers: { "Retry-After": String(changeLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const newEmail = normalizeEmail(parsed.data.newEmail);
    if (!newEmail) {
      return NextResponse.json({ error: "Invalid email address", code: "INVALID_EMAIL" }, { status: 400 });
    }

    const contact = await db.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId },
      select: { id: true, email: true },
    });

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const oldEmail = contact.email.toLowerCase();
    if (oldEmail === newEmail) {
      return NextResponse.json({ error: "New email is the same as the current email", code: "NO_CHANGE" }, { status: 400 });
    }

    const collision = await db.contact.findFirst({
      where: {
        organizationId: ctx.organizationId,
        email: newEmail,
        id: { not: contactId },
      },
      select: { id: true },
    });

    if (collision) {
      return NextResponse.json(
        { error: "Another contact in this organization already uses that email", code: "CONTACT_EMAIL_TAKEN" },
        { status: 409 }
      );
    }

    const updated = await db.contact.update({
      where: { id: contactId },
      data: { email: newEmail },
    });

    db.auditLog
      .create({
        data: {
          userId: ctx.userId ?? null,
          action: "UPDATE",
          entityType: "Contact",
          entityId: contactId,
          changes: {
            field: "email",
            before: oldEmail,
            after: newEmail,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.warn({ msg: "contact email-change audit log failed", err }));

    apiLogger.info({
      msg: "contact email changed",
      organizationId: ctx.organizationId,
      contactId,
    });

    return NextResponse.json({ contact: updated });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: "That email was just taken by another contact. Try again.", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error changing contact email" });
    return NextResponse.json({ error: "Failed to change email" }, { status: 500 });
  }
}
