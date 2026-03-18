import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ slug: string; registrationId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug, registrationId } = await params;

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        event: {
          OR: [{ slug }, { id: slug }],
        },
      },
      select: {
        paymentStatus: true,
        ticketType: {
          select: {
            name: true,
            price: true,
            currency: true,
          },
        },
      },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const response = NextResponse.json({
      paymentStatus: registration.paymentStatus,
      ticketName: registration.ticketType.name,
      ticketPrice: Number(registration.ticketType.price),
      ticketCurrency: registration.ticketType.currency,
    });

    // Short cache to allow polling but reduce DB load
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=5");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching payment status" });
    return NextResponse.json(
      { error: "Failed to fetch payment status" },
      { status: 500 }
    );
  }
}
