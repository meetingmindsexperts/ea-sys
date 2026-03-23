import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Fetch source event with all structural data
    const source = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      include: {
        ticketTypes: { include: { pricingTiers: true } },
        speakers: true,
        tracks: true,
        hotels: { include: { roomTypes: true } },
        eventSessions: { include: { speakers: true } },
      },
    });

    if (!source) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Generate unique slug
    const baseSlug = `${source.slug}-copy`;
    let slug = baseSlug;
    const existing = await db.event.findFirst({
      where: { organizationId: source.organizationId, slug },
      select: { id: true },
    });
    if (existing) {
      slug = `${baseSlug}-${Date.now()}`;
    }

    // Clone settings but reset reviewerUserIds
    const settings =
      typeof source.settings === "object" && source.settings !== null
        ? { ...(source.settings as Record<string, unknown>), reviewerUserIds: [] }
        : {};

    // Use 30s timeout — default 5s is too short on Vercel/pgbouncer when cloning
    // events with many related records (each is a sequential create).
    const newEvent = await db.$transaction(
      async (tx) => {
        // 1. Create the event
        const event = await tx.event.create({
          data: {
            organizationId: source.organizationId,
            name: `${source.name} (Copy)`,
            slug,
            description: source.description,
            startDate: source.startDate,
            endDate: source.endDate,
            timezone: source.timezone,
            venue: source.venue,
            address: source.address,
            city: source.city,
            country: source.country,
            eventType: source.eventType,
            tag: source.tag,
            specialty: source.specialty,
            status: "DRAFT",
            settings,
            bannerImage: source.bannerImage,
            footerHtml: source.footerHtml,
          },
        });

        // 2. Clone ticket types + pricing tiers (old ID → new ID map)
        const ticketMap = new Map<string, string>();
        for (const tt of source.ticketTypes) {
          const created = await tx.ticketType.create({
            data: {
              eventId: event.id,
              name: tt.name,
              description: tt.description,
              isDefault: tt.isDefault,
              isActive: tt.isActive,
              sortOrder: tt.sortOrder,
              price: tt.price,
              currency: tt.currency,
              quantity: tt.quantity,
              soldCount: 0,
              maxPerOrder: tt.maxPerOrder,
              salesStart: tt.salesStart,
              salesEnd: tt.salesEnd,
              requiresApproval: tt.requiresApproval,
              pricingTiers: {
                create: tt.pricingTiers.map((tier) => ({
                  name: tier.name,
                  price: tier.price,
                  currency: tier.currency,
                  quantity: tier.quantity,
                  soldCount: 0,
                  maxPerOrder: tier.maxPerOrder,
                  salesStart: tier.salesStart,
                  salesEnd: tier.salesEnd,
                  isActive: tier.isActive,
                  requiresApproval: tier.requiresApproval,
                  sortOrder: tier.sortOrder,
                })),
              },
            },
          });
          ticketMap.set(tt.id, created.id);
        }

        // 3. Clone speakers (old ID → new ID map, clear userId)
        const speakerMap = new Map<string, string>();
        for (const sp of source.speakers) {
          const created = await tx.speaker.create({
            data: {
              eventId: event.id,
              title: sp.title,
              email: sp.email,
              firstName: sp.firstName,
              lastName: sp.lastName,
              bio: sp.bio,
              organization: sp.organization,
              jobTitle: sp.jobTitle,
              phone: sp.phone,
              website: sp.website,
              photo: sp.photo,
              city: sp.city,
              country: sp.country,
              specialty: sp.specialty,
              registrationType: sp.registrationType,
              tags: sp.tags,
              socialLinks: sp.socialLinks ?? {},
              status: "INVITED",
            },
          });
          speakerMap.set(sp.id, created.id);
        }

        // 4. Clone tracks (old ID → new ID map)
        const trackMap = new Map<string, string>();
        for (const tr of source.tracks) {
          const created = await tx.track.create({
            data: {
              eventId: event.id,
              name: tr.name,
              description: tr.description,
              color: tr.color,
              sortOrder: tr.sortOrder,
            },
          });
          trackMap.set(tr.id, created.id);
        }

        // 5. Clone hotels + room types
        for (const hotel of source.hotels) {
          const newHotel = await tx.hotel.create({
            data: {
              eventId: event.id,
              name: hotel.name,
              address: hotel.address,
              description: hotel.description,
              contactEmail: hotel.contactEmail,
              contactPhone: hotel.contactPhone,
              stars: hotel.stars,
              images: hotel.images ?? [],
              isActive: hotel.isActive,
            },
          });
          for (const rt of hotel.roomTypes) {
            await tx.roomType.create({
              data: {
                hotelId: newHotel.id,
                name: rt.name,
                description: rt.description,
                pricePerNight: rt.pricePerNight,
                currency: rt.currency,
                capacity: rt.capacity,
                totalRooms: rt.totalRooms,
                bookedRooms: 0,
                amenities: rt.amenities ?? [],
                images: rt.images ?? [],
                isActive: rt.isActive,
              },
            });
          }
        }

        // 6. Clone sessions + session-speaker links
        for (const sess of source.eventSessions) {
          const newSession = await tx.eventSession.create({
            data: {
              eventId: event.id,
              trackId: sess.trackId ? trackMap.get(sess.trackId) ?? null : null,
              name: sess.name,
              description: sess.description,
              startTime: sess.startTime,
              endTime: sess.endTime,
              location: sess.location,
              capacity: sess.capacity,
              status: "SCHEDULED",
            },
          });

          // Re-link speakers to new session
          for (const ss of sess.speakers) {
            const newSpeakerId = speakerMap.get(ss.speakerId);
            if (newSpeakerId) {
              await tx.sessionSpeaker.create({
                data: {
                  sessionId: newSession.id,
                  speakerId: newSpeakerId,
                  role: ss.role,
                },
              });
            }
          }
        }

        return event;
      },
      { timeout: 30000 }
    );

    apiLogger.info({
      msg: "Event cloned",
      sourceEventId: eventId,
      newEventId: newEvent.id,
      userId: session.user.id,
    });

    return NextResponse.json(
      { id: newEvent.id, name: newEvent.name, slug: newEvent.slug },
      { status: 201 }
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error cloning event" });
    return NextResponse.json(
      { error: "Failed to clone event" },
      { status: 500 }
    );
  }
}
