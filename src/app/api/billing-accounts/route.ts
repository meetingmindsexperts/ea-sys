import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { createBillingAccount } from "@/services/billing-account-service";

/**
 * Billing accounts = reusable org-scoped third-party payers for "charge to
 * another account". This is finance/billing data, so every handler is
 * gated by `denyFinance` (MEMBER read-only viewer is barred) on top of
 * `denyReviewer` for writes. Org-scoped by session — never trust an id.
 */

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["INSTITUTION", "COMPANY", "OTHER"]).optional(),
  email: z.string().email().max(255).optional().nullable().or(z.literal("")),
  phone: z.string().max(50).optional().nullable(),
  contactName: z.string().max(150).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  city: z.string().max(255).optional().nullable(),
  state: z.string().max(255).optional().nullable(),
  zipCode: z.string().max(20).optional().nullable(),
  country: z.string().max(255).optional().nullable(),
  taxNumber: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    const { searchParams } = new URL(req.url);
    const includeInactive = searchParams.get("includeInactive") === "1";
    const needsReviewOnly = searchParams.get("needsReview") === "1";
    const eventId = searchParams.get("eventId") || undefined;

    // Per-event scoping: when `eventId` is supplied, return ONLY payers
    // attached to that event via the EventBillingAccount junction. This is
    // the filtered list the Add Registration form + detail-sheet pickers
    // consume so each event sees only its own curated set, not every
    // active payer in the org. Without `eventId` (Settings → Billing
    // card), the full org list is returned. The event itself is still
    // org-scoped via the junction filter — a foreign eventId returns []
    // rather than leaking another org's attachments.
    const accounts = await db.billingAccount.findMany({
      where: {
        organizationId: session.user.organizationId!,
        ...(includeInactive ? {} : { isActive: true }),
        ...(needsReviewOnly ? { needsReview: true } : {}),
        ...(eventId
          ? {
              events: {
                some: {
                  eventId,
                  event: { organizationId: session.user.organizationId! },
                },
              },
            }
          : {}),
      },
      orderBy: [{ needsReview: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { registrations: true, events: true } },
      },
    });

    return NextResponse.json(accounts);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing billing accounts" });
    return NextResponse.json({ error: "Failed to list billing accounts" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    const body = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "billing-accounts:zod-validation-failed",
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await createBillingAccount({
      ...parsed.data,
      email: parsed.data.email || null,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
    });

    if (!result.ok) {
      const status =
        result.code === "DUPLICATE_NAME" ? 409 : result.code === "NAME_REQUIRED" ? 400 : 500;
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.billingAccount, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating billing account" });
    return NextResponse.json({ error: "Failed to create billing account" }, { status: 500 });
  }
}
