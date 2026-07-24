import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
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
      apiLogger.warn({ msg: "public/event:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const { slug } = await params;

    // Support both slug and event ID lookup (tenant-scoped by request host)
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, {
        allowIdFallback: true,
        statuses: ["PUBLISHED", "LIVE"],
      }),
      select: {
        id: true,
        name: true,
        slug: true,
        eventType: true,
        description: true,
        startDate: true,
        endDate: true,
        timezone: true,
        venue: true,
        address: true,
        city: true,
        country: true,
        bannerImage: true,
        bannerImageMobile: true,
        footerHtml: true,
        supportEmail: true,
        taxRate: true,
        taxLabel: true,
        registrationTermsHtml: true,
        registrationWelcomeHtml: true,
        abstractWelcomeHtml: true,
        registrationConfirmationHtml: true,
        settings: true,
        maxAttendees: true,
        seatCount: true,
        organization: {
          select: {
            name: true,
            logo: true,
          },
        },
        ticketTypes: {
          where: {
            isActive: true,
            // Hide the internal Faculty type (speaker companion registrations)
            // from public registration.
            isFaculty: false,
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
            virtualPrice: true,
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

    // Check if event has active promo codes mapped to ticket types
    const promoCodeCount = await db.promoCode.count({
      where: {
        eventId: event.id,
        isActive: true,
        ticketTypes: { some: {} },
        OR: [
          { validUntil: null },
          { validUntil: { gte: now } },
        ],
      },
    });
    const hasPromoCodes = promoCodeCount > 0;

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
      // Raw counters stay private — the public payload carries only the flag.
      maxAttendees: undefined,
      seatCount: undefined,
      // Event-wide attendee cap reached (Settings → Registration → Maximum
      // Attendees). The register pages show a "Registration Full" state; the
      // register POST enforces it atomically regardless.
      eventFull: event.maxAttendees != null && event.seatCount >= event.maxAttendees,
      ticketTypes,
      hasPromoCodes,
      abstractSettings: {
        allowAbstractSubmissions: settings.allowAbstractSubmissions === true,
        abstractDeadline: settings.abstractDeadline || null,
      },
      agendaPublished: settings.agendaPublished === true || settings.programmePublished === true,
      // Master registration switch (Settings → Registration). Default OPEN when
      // the field is absent so existing events aren't accidentally closed.
      // When false, the public register flow shows "Registration Closed"
      // regardless of individual tier (standard/onsite) states.
      registrationOpen: settings.registrationOpen !== false,
      // "Show Remaining Tickets" (Settings → Registration). Opt-IN (=== true,
      // hidden by default): the register page only renders "N seats left" when
      // the organizer explicitly enabled it AND the tier/type has a real seat
      // limit (quantity < 999999 sentinel).
      showRemainingTickets: settings.showRemainingTickets === true,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching public event" });
    return NextResponse.json(
      { error: "Failed to fetch event" },
      { status: 500 }
    );
  }
}
