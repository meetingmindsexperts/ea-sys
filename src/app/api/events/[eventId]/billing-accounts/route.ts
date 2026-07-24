import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { findOrCreateBillingAccount } from "@/services/billing-account-service";

/**
 * Event-level payer entry with org-level consolidation (mirrors how Contacts
 * work: capture in context, dedupe into one org record).
 *
 * POST creates-or-reuses a `BillingAccount` at the ORG level (exact-name reuse;
 * a near-duplicate name is created + flagged `needsReview` for an admin to merge
 * later) and AUTO-ATTACHES it to this event via the `EventBillingAccount`
 * junction — so an organizer can add a "Charge to" payer without leaving the
 * event for Settings → Billing. The payer itself stays a single shared org row;
 * only the per-event attachment is event-specific.
 *
 * (The per-event LIST is served by GET /api/billing-accounts?eventId=…, and
 * attach/detach of an EXISTING payer is at /billing-accounts/[id].)
 */
interface RouteParams {
  params: Promise<{ eventId: string }>;
}

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

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session, body] = await Promise.all([params, auth(), req.json().catch(() => null)]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    const noFinance = denyFinance(session);
    if (noFinance) return noFinance;

    const orgId = session.user.organizationId!; // capture before the closure
    return await runWithTenant(orgId, async () => {
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "events/billing-accounts:zod-validation-failed", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    // Org-level find-or-create (consolidate by name).
    const result = await findOrCreateBillingAccount({
      ...parsed.data,
      email: parsed.data.email || null,
      organizationId: session.user.organizationId!,
      userId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
    });
    if (!result.ok) {
      const status = result.code === "NAME_REQUIRED" ? 400 : 500;
      return NextResponse.json({ error: result.message, code: result.code, ...(result.meta ?? {}) }, { status });
    }

    // Auto-attach to this event (idempotent on the (eventId, billingAccountId) unique).
    await db.eventBillingAccount.upsert({
      where: { eventId_billingAccountId: { eventId, billingAccountId: result.billingAccount.id } },
      update: {},
      create: { eventId, billingAccountId: result.billingAccount.id, addedByUserId: session.user.id },
    });

    apiLogger.info({
      msg: "events/billing-accounts:resolved",
      eventId,
      billingAccountId: result.billingAccount.id,
      reused: result.reused,
      flaggedReview: result.flaggedReview,
    });

    return NextResponse.json(
      { billingAccount: result.billingAccount, reused: result.reused, needsReview: result.flaggedReview },
      { status: result.reused ? 200 : 201 },
    );
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating/attaching billing account for event" });
    return NextResponse.json({ error: "Failed to add billing account" }, { status: 500 });
  }
}
