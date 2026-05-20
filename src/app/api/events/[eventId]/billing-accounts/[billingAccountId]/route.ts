import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, denyFinance } from "@/lib/auth-guards";

/**
 * Attach / detach a BillingAccount to an Event via the
 * EventBillingAccount junction — the per-event scoping for "charge to
 * another account" pickers. Both ids come from the URL, so each handler
 * org-binds the event AND the BillingAccount before touching the
 * junction (IDOR-safe: a user in org A cannot link or unlink org B's
 * payer to org B's event). Finance-gated; junction is finance data.
 *
 * - POST: idempotent attach (upsert on the `(eventId, billingAccountId)`
 *   unique → 200 on first attach, 200 on re-attach). Records the
 *   attaching user for audit.
 * - DELETE: idempotent detach (deleteMany — 200 whether the row
 *   existed or not). Cascading the junction does NOT delete the
 *   BillingAccount itself, only the link; existing registrations that
 *   already reference this payer keep their `billingAccountId` because
 *   the Registration→BillingAccount FK is RESTRICT.
 */

interface RouteParams {
  params: Promise<{ eventId: string; billingAccountId: string }>;
}

async function gateAndScope(req: Request, params: RouteParams["params"]) {
  const [{ eventId, billingAccountId }, session] = await Promise.all([params, auth()]);
  if (!session?.user) {
    return {
      err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    } as const;
  }
  const denied = denyReviewer(session);
  if (denied) return { err: denied } as const;
  const noFinance = denyFinance(session);
  if (noFinance) return { err: noFinance } as const;

  // Org-bind both ends before doing anything to the junction.
  const [event, billingAccount] = await Promise.all([
    db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    }),
    db.billingAccount.findFirst({
      where: { id: billingAccountId, organizationId: session.user.organizationId! },
      select: { id: true, isActive: true },
    }),
  ]);
  if (!event) {
    return {
      err: NextResponse.json({ error: "Event not found" }, { status: 404 }),
    } as const;
  }
  if (!billingAccount) {
    return {
      err: NextResponse.json({ error: "Billing account not found" }, { status: 404 }),
    } as const;
  }
  return { ok: true as const, session, eventId, billingAccountId, billingAccount };
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const r = await gateAndScope(req, params);
    if ("err" in r) return r.err;

    if (!r.billingAccount.isActive) {
      return NextResponse.json(
        { error: "Cannot attach an inactive billing account. Reactivate it first.", code: "BILLING_ACCOUNT_INACTIVE" },
        { status: 400 },
      );
    }

    // Idempotent — upsert on the `(eventId, billingAccountId)` unique.
    // Returning the row lets the client know who attached + when.
    const row = await db.eventBillingAccount.upsert({
      where: {
        eventId_billingAccountId: {
          eventId: r.eventId,
          billingAccountId: r.billingAccountId,
        },
      },
      create: {
        eventId: r.eventId,
        billingAccountId: r.billingAccountId,
        addedByUserId: r.session.user.id,
      },
      update: {}, // no-op on re-attach
    });

    db.auditLog
      .create({
        data: {
          eventId: r.eventId,
          userId: r.session.user.id,
          action: "UPDATE",
          entityType: "BillingAccount",
          entityId: r.billingAccountId,
          changes: { source: "rest", action: "attach-to-event", eventId: r.eventId },
        },
      })
      .catch((err) => apiLogger.error({ err }, "billing-account-attach:audit-log-failed"));

    return NextResponse.json(row);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error attaching billing account to event" });
    return NextResponse.json({ error: "Failed to attach billing account" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const r = await gateAndScope(req, params);
    if ("err" in r) return r.err;

    // Detach is idempotent — deleteMany returns count regardless.
    // NOTE: Registrations already pointing at this payer keep their
    // `billingAccountId` (Registration→BillingAccount FK is RESTRICT).
    // The payer simply stops appearing in the event's picker.
    const res = await db.eventBillingAccount.deleteMany({
      where: { eventId: r.eventId, billingAccountId: r.billingAccountId },
    });

    db.auditLog
      .create({
        data: {
          eventId: r.eventId,
          userId: r.session.user.id,
          action: "UPDATE",
          entityType: "BillingAccount",
          entityId: r.billingAccountId,
          changes: {
            source: "rest",
            action: "detach-from-event",
            eventId: r.eventId,
            removed: res.count > 0,
          },
        },
      })
      .catch((err) => apiLogger.error({ err }, "billing-account-detach:audit-log-failed"));

    return NextResponse.json({ removed: res.count > 0 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error detaching billing account from event" });
    return NextResponse.json({ error: "Failed to detach billing account" }, { status: 500 });
  }
}
