import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

// Get public event details (supports both slug and event ID)
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    // Support both slug and event ID lookup
    const event = await db.event.findFirst({
      where: {
        OR: [{ slug }, { id: slug }],
        status: { in: ["PUBLISHED", "LIVE"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        startDate: true,
        endDate: true,
        timezone: true,
        venue: true,
        address: true,
        city: true,
        country: true,
        bannerImage: true,
        organization: {
          select: {
            name: true,
            logo: true,
          },
        },
        ticketTypes: {
          where: {
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            description: true,
            price: true,
            currency: true,
            quantity: true,
            soldCount: true,
            maxPerOrder: true,
            salesStart: true,
            salesEnd: true,
          },
          orderBy: { price: "asc" },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Calculate ticket availability
    const ticketTypes = event.ticketTypes.map((ticket) => {
      const now = new Date();
      const available = ticket.quantity - ticket.soldCount;
      const salesStarted = !ticket.salesStart || new Date(ticket.salesStart) <= now;
      const salesEnded = ticket.salesEnd && new Date(ticket.salesEnd) < now;

      return {
        ...ticket,
        available,
        soldOut: available <= 0,
        salesStarted,
        salesEnded,
        canPurchase: available > 0 && salesStarted && !salesEnded,
      };
    });

    return NextResponse.json({
      ...event,
      ticketTypes,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching public event" });
    return NextResponse.json(
      { error: "Failed to fetch event" },
      { status: 500 }
    );
  }
}
