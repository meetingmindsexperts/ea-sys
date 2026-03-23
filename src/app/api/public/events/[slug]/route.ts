import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

// Get public event details (supports both slug and event ID)
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const clientIp = getClientIp(req);
    const ipRateLimit = checkRateLimit({
      key: `public-event:ip:${clientIp}`,
      limit: 60,
      windowMs: 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

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
        footerHtml: true,
        supportEmail: true,
        settings: true,
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
            isDefault: true,
            sortOrder: true,
            // Legacy fields for backward compat
            category: true,
            price: true,
            currency: true,
            quantity: true,
            soldCount: true,
            maxPerOrder: true,
            salesStart: true,
            salesEnd: true,
            // New pricing tiers
            pricingTiers: {
              where: { isActive: true },
              select: {
                id: true,
                name: true,
                price: true,
                currency: true,
                quantity: true,
                soldCount: true,
                maxPerOrder: true,
                salesStart: true,
                salesEnd: true,
                requiresApproval: true,
                sortOrder: true,
              },
              orderBy: { sortOrder: "asc" },
            },
          },
          orderBy: { sortOrder: "asc" },
        },
        tracks: {
          select: {
            id: true,
            name: true,
            description: true,
          },
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const now = new Date();

    // Calculate availability for each registration type and its pricing tiers
    const ticketTypes = event.ticketTypes.map((ticket) => {
      // Compute availability per pricing tier
      const pricingTiers = ticket.pricingTiers.map((tier) => {
        const available = tier.quantity - tier.soldCount;
        const salesStarted = !tier.salesStart || new Date(tier.salesStart) <= now;
        const salesEnded = tier.salesEnd ? new Date(tier.salesEnd) < now : false;
        return {
          ...tier,
          available,
          soldOut: available <= 0,
          salesStarted,
          salesEnded,
          canPurchase: available > 0 && salesStarted && !salesEnded,
        };
      });

      // Legacy: compute from old fields for backward compat (pre-migration data)
      const legacyAvailable = ticket.quantity - ticket.soldCount;
      const legacySalesStarted = !ticket.salesStart || new Date(ticket.salesStart) <= now;
      const legacySalesEnded = ticket.salesEnd ? new Date(ticket.salesEnd) < now : false;

      return {
        ...ticket,
        pricingTiers,
        // Legacy availability fields
        available: legacyAvailable,
        soldOut: legacyAvailable <= 0,
        salesStarted: legacySalesStarted,
        salesEnded: legacySalesEnded,
        canPurchase: legacyAvailable > 0 && legacySalesStarted && !legacySalesEnded,
      };
    });

    const settings = (event.settings || {}) as Record<string, unknown>;

    return NextResponse.json({
      ...event,
      settings: undefined,
      ticketTypes,
      abstractSettings: {
        allowAbstractSubmissions: settings.allowAbstractSubmissions === true,
        abstractDeadline: settings.abstractDeadline || null,
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching public event" });
    return NextResponse.json(
      { error: "Failed to fetch event" },
      { status: 500 }
    );
  }
}
