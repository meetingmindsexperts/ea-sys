import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generatePDFForInvoice } from "@/lib/invoice-service";
import { checkRateLimit } from "@/lib/security";

/**
 * GET /api/registrant/my-group/[groupId]/invoice/[invoiceId]
 *
 * The coordinator's own copy of a consolidated group invoice. Authorized on
 * `coordinatorUserId` (org-null REGISTRANT — the `/api/registrant/*` identity
 * convention), and the invoice is bound to the group in the SAME query so a
 * foreign invoiceId can't be rendered against an owned group.
 */
interface RouteParams {
  params: Promise<{ groupId: string; invoiceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ groupId, invoiceId }, session] = await Promise.all([params, auth()]);
    if (!session?.user?.id) {
      apiLogger.warn({ msg: "my-group-invoice:unauthorized", groupId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // PDF generation is CPU-bound; cap a coordinator hammering refresh.
    const limit = checkRateLimit({
      key: `my-group-invoice:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      apiLogger.warn({ msg: "my-group-invoice:rate-limited", userId: session.user.id });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    // Ownership + binding in one predicate: the invoice must belong to a group
    // this user coordinates. A miss is a 404, never a 403 — no existence leak.
    const invoice = await db.invoice.findFirst({
      where: {
        id: invoiceId,
        groupId,
        group: { coordinatorUserId: session.user.id },
      },
      select: { id: true, invoiceNumber: true },
    });
    if (!invoice) {
      apiLogger.warn({
        msg: "my-group-invoice:not-found-or-not-owned",
        groupId,
        invoiceId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const pdf = await generatePDFForInvoice(invoice.id);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${invoice.invoiceNumber}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "my-group-invoice:failed" });
    return NextResponse.json({ error: "Failed to generate the invoice" }, { status: 500 });
  }
}
