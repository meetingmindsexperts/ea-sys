import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";
import { cloneEventSettings } from "@/lib/event-clone-settings";
import { Prisma } from "@prisma/client";

/**
 * What the organizer chose to carry across (Sep 17, 2026). Both default to
 * TRUE so a caller that sends no body (every client before this change) gets
 * exactly the clone it always got.
 *
 * "Agenda" is tracks + sessions (breaks included) + topics: a session's
 * trackId points at a track, so copying one without the other leaves dangling
 * references, and a track list on its own is not a useful thing to clone.
 *
 * The two are INDEPENDENT on purpose. Agenda without speakers copies every
 * session with nobody assigned (the public agenda reads TBA until someone is);
 * speakers without agenda copies the faculty list with no sessions. Both are
 * real ways to start a next edition, so neither is refused.
 */
const cloneOptionsSchema = z.object({
  includeSpeakers: z.boolean().default(true),
  includeAgenda: z.boolean().default(true),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session, { route: "events/[eventId]/clone:POST" });
    if (denied) return denied;

    // An empty body is the historical request and means "copy everything".
    // A body that is present but unreadable is refused rather than defaulted:
    // quietly copying the speakers somebody unticked is exactly the surprise
    // the options exist to prevent.
    const rawBody = await req.text();
    let bodyJson: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        bodyJson = JSON.parse(rawBody);
      } catch {
        apiLogger.warn({ msg: "events/clone:invalid-json", eventId, userId: session.user.id });
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }
    const parsedOptions = cloneOptionsSchema.safeParse(bodyJson);
    if (!parsedOptions.success) {
      apiLogger.warn({
        msg: "events/clone:zod-validation-failed",
        eventId,
        userId: session.user.id,
        errors: parsedOptions.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsedOptions.error.flatten() },
        { status: 400 },
      );
    }
    const { includeSpeakers, includeAgenda } = parsedOptions.data;

    // Tenancy sweep: clone is a staff route, so the org comes from the session
    // (no DB lookup needed). Wrap the WHOLE clone — the source `speakers`
    // include reads the now-RLS'd Speaker table, so it must run inside the
    // tenant store or it fail-closes on the platform; likewise the cloned rows'
    // WITH CHECK. Passthrough on master (flag off).
    return await runWithTenantLane(session.user.organizationId, { route: "events:clone", userId: session.user.id }, async () => {
    // Fetch source event with all structural data
    const source = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      include: {
        ticketTypes: { include: { pricingTiers: true } },
        // Not read at all when the organizer left the box unticked.
        speakers: includeSpeakers,
        tracks: includeAgenda,
        // Sponsors are a TABLE since Sep 2 2026. They used to ride along inside
        // `settings` (the clone allow-list carried "sponsors"), so without this
        // the promotion would have made cloning an event silently DROP its
        // sponsor list: nothing errors, the new event just has none. That is
        // the site in the whole migration that fails quietly rather than loudly.
        sponsors: true,
        // Custom/edited email templates (Communications → Email Templates).
        emailTemplates: true,
        hotels: { include: { roomTypes: true } },
        eventSessions: {
          // `take: 0` rather than `includeAgenda && {...}`: the conditional
          // form erases the nested include from Prisma's result type.
          take: includeAgenda ? undefined : 0,
          include: {
            speakers: true,
            // Per-session agenda items + their per-topic speakers — these
            // were previously dropped, silently losing the detailed agenda
            // on every clone.
            topics: { include: { speakers: true } },
          },
        },
      },
    });

    if (!source) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Guarded twice: the include above skips the read, and these skip the
    // copy, so a future change to one cannot quietly bring the rows back.
    const speakersToClone = includeSpeakers ? (source.speakers ?? []) : [];
    const tracksToClone = includeAgenda ? (source.tracks ?? []) : [];
    const sessionsToClone = includeAgenda ? (source.eventSessions ?? []) : [];

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

    // Copy only the settings keys that are safe + desirable on a clone — an
    // ALLOW-LIST, not a deny-list (see src/lib/event-clone-settings.ts). The old
    // wholesale spread carried the source's webinar anchor sessionId (→ every
    // Zoom attach 409'd), its surveyShareLink (a live token), and its
    // agendaPublished flag (→ the clone's public agenda went live).
    const settings = cloneEventSettings(source.settings) as Prisma.InputJsonValue;

    // Use 30s timeout — default 5s is too short on Vercel/pgbouncer when cloning
    // events with many related records (each is a sequential create).
    // tenantTransaction issues SET LOCAL app.current_org inside the tx (from the
    // enclosing runWithTenant above) so the cloned TicketType / PricingTier /
    // Speaker WITH CHECK passes on the platform; passthrough on master.
    const newEvent = await tenantTransaction(
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
            bannerImageMobile: source.bannerImageMobile,
            footerHtml: source.footerHtml,
            // Newer per-event config that lives in dedicated columns (NOT in
            // the settings JSON). Copied so a clone carries the organizer's
            // full customization instead of silently reverting to defaults.
            // Deliberately NOT copied: `code` (feeds invoice numbering —
            // must regenerate per event), `surveyShareLink` (a live token
            // tied to the source event), and `speakerAgreementTemplate`
            // (file-backed — would share an uploaded .docx; deferred to a
            // file-copy pass).
            emailHeaderImage: source.emailHeaderImage,
            emailFooterImage: source.emailFooterImage,
            emailFooterHtml: source.emailFooterHtml,
            emailFromAddress: source.emailFromAddress,
            emailFromName: source.emailFromName,
            emailCcAddresses: source.emailCcAddresses,
            supportEmail: source.supportEmail,
            registrationTermsHtml: source.registrationTermsHtml,
            registrationWelcomeHtml: source.registrationWelcomeHtml,
            registrationConfirmationHtml: source.registrationConfirmationHtml,
            abstractWelcomeHtml: source.abstractWelcomeHtml,
            sessionProposalWelcomeHtml: source.sessionProposalWelcomeHtml,
            abstractGuidelinesHtml: source.abstractGuidelinesHtml,
            abstractTermsHtml: source.abstractTermsHtml,
            abstractConfirmationHtml: source.abstractConfirmationHtml,
            speakerAgreementHtml: source.speakerAgreementHtml,
            surveyIntroHtml: source.surveyIntroHtml,
            surveyThankYouHtml: source.surveyThankYouHtml,
            surveyConfig: source.surveyConfig ?? undefined,
            taxRate: source.taxRate,
            taxLabel: source.taxLabel,
            bankDetails: source.bankDetails,
            badgeVerticalOffset: source.badgeVerticalOffset,
            cmeHours: source.cmeHours,
            requiresDtcmBarcode: source.requiresDtcmBarcode,
            // Event-wide attendee cap is config → copy; seatCount deliberately
            // NOT copied (the clone starts with zero registrations).
            maxAttendees: source.maxAttendees,
          },
        });

        // 2. Clone ticket types + pricing tiers (old ID → new ID map)
        const ticketMap = new Map<string, string>();
        for (const tt of source.ticketTypes) {
          const created = await tx.ticketType.create({
            data: {
              eventId: event.id,
              organizationId: event.organizationId,
              name: tt.name,
              description: tt.description,
              isDefault: tt.isDefault,
              isActive: tt.isActive,
              // MUST be copied. Dropping it turned the source event's hidden
              // speaker-companion "Faculty" type into a normal, publicly
              // bookable, capacity-counting delegate type on every clone — and
              // adding a speaker to the clone then minted a SECOND "Faculty"
              // type beside it.
              isFaculty: tt.isFaculty,
              sortOrder: tt.sortOrder,
              price: tt.price,
              // The HYBRID virtual-attendance price is config like every other
              // field here; it was silently reset to null (⇒ virtual fell back
              // to the in-person price) on every clone.
              virtualPrice: tt.virtualPrice,
              currency: tt.currency,
              quantity: tt.quantity,
              soldCount: 0,
              maxPerOrder: tt.maxPerOrder,
              salesStart: tt.salesStart,
              salesEnd: tt.salesEnd,
              requiresApproval: tt.requiresApproval,
              // MUST be copied — the THIRD field on this row to be dropped this
              // way (isFaculty and virtualPrice above are the other two). It is
              // also the worst of the three to lose, because the old mechanism
              // hid the bug: the requirement used to travel with the type's
              // NAME, which clone does copy, so cloning preserved it for free.
              // Now the policy is a column, and a clone that drops it means the
              // recurring series (which is how the next edition is built) sells
              // a discounted rate with nothing substantiating it — silently, no
              // error, no log. The positive-field-list test below this file's
              // sibling is what stops a fourth.
              requiresDocument: tt.requiresDocument,
              documentRequired: tt.documentRequired,
              documentLabel: tt.documentLabel,
              documentInstructions: tt.documentInstructions,
              // Identity evidence (Sept 2, 2026) — same reasoning, same trap.
              // The name match this replaced survived a clone for free because
              // the rule lived in the NAME; a column does not, so a cloned
              // "Student" rate would quietly stop verifying anyone.
              requiresMemberId: tt.requiresMemberId,
              requiresStudentId: tt.requiresStudentId,
              requiresStudentIdExpiry: tt.requiresStudentIdExpiry,
              pricingTiers: {
                create: tt.pricingTiers.map((tier) => ({
                  organizationId: event.organizationId,
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
        for (const sp of speakersToClone) {
          const created = await tx.speaker.create({
            data: {
              eventId: event.id,
              organizationId: source.organizationId, // multi-tenancy: Speaker sweep (same-org clone)
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
        for (const tr of tracksToClone) {
          const created = await tx.track.create({
            data: {
              eventId: event.id,
              organizationId: event.organizationId, // multi-tenancy: Sessions sweep
              name: tr.name,
              description: tr.description,
              color: tr.color,
              sortOrder: tr.sortOrder,
            },
          });
          trackMap.set(tr.id, created.id);
        }

        // 4b. Clone sponsors. New ids on purpose: a sponsor row belongs to one
        // event, and Registration.sponsorId / PromoCode.sponsorId are foreign
        // keys, so reusing the source ids would either collide or point a
        // clone's rows at the original event's sponsors.
        for (const sp of source.sponsors) {
          await tx.sponsor.create({
            data: {
              eventId: event.id,
              organizationId: event.organizationId,
              name: sp.name,
              tier: sp.tier,
              logoUrl: sp.logoUrl,
              websiteUrl: sp.websiteUrl,
              description: sp.description,
              sortOrder: sp.sortOrder,
            },
          });
        }

        // 5. Clone hotels + room types
        for (const hotel of source.hotels) {
          const newHotel = await tx.hotel.create({
            data: {
              eventId: event.id,
              organizationId: event.organizationId, // multi-tenancy: Accommodation sweep
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
                organizationId: event.organizationId, // multi-tenancy: Accommodation sweep
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
        for (const sess of sessionsToClone) {
          const newSession = await tx.eventSession.create({
            data: {
              eventId: event.id,
              organizationId: event.organizationId, // multi-tenancy: Sessions sweep
              trackId: sess.trackId ? trackMap.get(sess.trackId) ?? null : null,
              name: sess.name,
              description: sess.description,
              startTime: sess.startTime,
              endTime: sess.endTime,
              location: sess.location,
              capacity: sess.capacity,
              status: "SCHEDULED",
              // MUST be copied. Without it every Coffee Break, Lunch, Workshop
              // and Symposium came out of a clone as a plain SESSION: breaks
              // lost their muted band and started counting in the session
              // totals, and workshops lost their chip. Nothing errored, because
              // SESSION is the column default.
              type: sess.type,
            },
          });

          // Re-link speakers to new session
          for (const ss of sess.speakers) {
            const newSpeakerId = speakerMap.get(ss.speakerId);
            if (newSpeakerId) {
              await tx.sessionSpeaker.create({
                data: {
                  sessionId: newSession.id,
                  organizationId: event.organizationId, // multi-tenancy: Sessions sweep
                  speakerId: newSpeakerId,
                  role: ss.role,
                },
              });
            }
          }

          // Clone agenda topics + their per-topic speakers. abstractId is
          // intentionally NOT cloned — abstracts aren't copied, and the
          // column is @unique so reusing it would dangle/collide.
          for (const topic of sess.topics) {
            const remappedTopicSpeakers = topic.speakers
              .map((ts) => speakerMap.get(ts.speakerId))
              .filter((id): id is string => Boolean(id))
              .map((speakerId) => ({ speakerId, organizationId: event.organizationId })); // multi-tenancy: Sessions sweep
            await tx.sessionTopic.create({
              data: {
                sessionId: newSession.id,
                organizationId: event.organizationId, // multi-tenancy: Sessions sweep
                title: topic.title,
                sortOrder: topic.sortOrder,
                duration: topic.duration,
                speakers:
                  remappedTopicSpeakers.length > 0
                    ? { create: remappedTopicSpeakers }
                    : undefined,
              },
            });
          }
        }

        // 7. Clone custom email templates (Communications → Email Templates).
        // No ID remapping needed — they reference only the event. The new event
        // has no templates yet, so the @@unique([eventId, slug]) can't collide.
        if (source.emailTemplates.length > 0) {
          await tx.emailTemplate.createMany({
            data: source.emailTemplates.map((t) => ({
              eventId: event.id,
              slug: t.slug,
              name: t.name,
              subject: t.subject,
              htmlContent: t.htmlContent,
              textContent: t.textContent,
              isActive: t.isActive,
            })),
          });
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
      includeSpeakers,
      includeAgenda,
    });

    return NextResponse.json(
      { id: newEvent.id, name: newEvent.name, slug: newEvent.slug },
      { status: 201 }
    );
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error cloning event" });
    return NextResponse.json(
      { error: "Failed to clone event" },
      { status: 500 }
    );
  }
}
