import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requirePermission } from "@/lib/permissions/require-permission";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { createBillingAccount } from "@/services/billing-account-service";

/**
 * Billing accounts = reusable org-scoped third-party payers for "charge to
 * another account". The list needs `billingAccounts.read` (the desk's payer
 * picker reads it, so ONSITE and WEBINARS hold it); creating and editing need
 * `billingAccounts.manage`. A payer's DETAIL is wider (its money on every
 * event) and needs `invoices.ledger`. Org-scoped by session — never trust an id.
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
    const gate = requirePermission(session, "billingAccounts.read", { route: "billing-accounts:GET" });
    if (!gate.ok) return gate.response;

    const orgId = session.user.organizationId!; // capture before the closure
    // Tenancy: populate the ALS tenant store. RLS_SET_LOCAL off (master) → a
    // pure async passthrough; on an RLS deployment every query rides the lane.
    return await runWithTenant(orgId, async () => {
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
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing billing accounts" });
    return NextResponse.json({ error: "Failed to list billing accounts" }, { status: 500 });
  }
}

function createStatusForCode(code: string): number {
  if (code === "DUPLICATE_NAME") return 409;
  if (code === "NAME_REQUIRED") return 400;
  return 500;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const gate = requirePermission(session, "billingAccounts.manage", { route: "billing-accounts:POST" });
    if (!gate.ok) return gate.response;

    const orgId = session.user.organizationId!; // capture before the closure
    return await runWithTenant(orgId, async () => {
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
      const status = createStatusForCode(result.code);
      return NextResponse.json(
        { error: result.message, code: result.code, ...(result.meta ?? {}) },
        { status },
      );
    }

    return NextResponse.json(result.billingAccount, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating billing account" });
    return NextResponse.json({ error: "Failed to create billing account" }, { status: 500 });
  }
}
