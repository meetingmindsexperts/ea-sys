import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

/**
 * GET /api/registrant/registrations/[registrationId]/invoices
 * List invoices for a registration (registrant or org member).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        ...(session.user.role === "REGISTRANT"
          ? { userId: session.user.id }
          : { event: { organizationId: session.user.organizationId! } }),
      },
      select: { id: true },
    });
    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const invoices = await db.invoice.findMany({
      where: { registrationId },
      select: {
        id: true,
        type: true,
        invoiceNumber: true,
        status: true,
        issueDate: true,
        total: true,
        currency: true,
        sentAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(invoices);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing registration invoices" });
    return NextResponse.json({ error: "Failed to list invoices" }, { status: 500 });
  }
}
