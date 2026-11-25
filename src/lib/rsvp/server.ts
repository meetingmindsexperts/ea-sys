/**
 * RSVP — server-only lookup helpers shared by the organizer routes.
 *
 * Every organizer route needs the same two steps: resolve the event through
 * the route's `gate.eventWhere` (from `requirePermission`, so the lookup comes
 * from the grant that let the caller in), then bind the campaign to that event. Six routes need
 * it, so it lives here rather than being retyped per route — a hand-copied
 * scoping check is exactly how one of them ends up org-scoped-only.
 *
 * Docs: docs/RSVP.md.
 */
import { db } from "@/lib/db";
import { findGatedEvent, type EventGate } from "@/lib/tenant/event-tenant";
import { equalsIgnoringCase } from "@/lib/like-escape";

export interface RsvpEventRef {
  id: string;
  organizationId: string;
}

/**
 * The event behind the caller's permission gate (read inside the caller's lane: findGatedEvent). Returns null (→ 404, never
 * 403) so a foreign eventId is not an existence oracle.
 */
export async function loadRsvpEvent(gate: EventGate): Promise<RsvpEventRef | null> {
  const event = await findGatedEvent(gate, {
    select: { id: true, organizationId: true },
  });
  return event as RsvpEventRef | null;
}

/**
 * A campaign bound to its event. The `eventId` in the where is what stops a
 * campaign id from one event resolving against another event's URL — call
 * this INSIDE the tenant lane.
 */
export async function loadRsvpCampaign(campaignId: string, eventId: string) {
  return db.rsvpCampaign.findFirst({
    where: { id: campaignId, eventId },
    select: {
      id: true,
      eventId: true,
      organizationId: true,
      name: true,
      description: true,
      questionText: true,
      questionHelpText: true,
      thankYouText: true,
      selectionMode: true,
      allowGuests: true,
      collectDietary: true,
      isActive: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export type RsvpCampaignRow = NonNullable<Awaited<ReturnType<typeof loadRsvpCampaign>>>;

/**
 * The invitee's title ("DR", "PROF") for the thank-you's greeting (owner, Nov 25, 2026: "Thank you,
 * Hadeel Ammar! this can be system but with title"). An invite holds a name and an address only, so
 * the title is read from the person's own record on THIS event: the speaker or registration the
 * invite was imported from, else one on the same address (a speaker first: faculty are the people a
 * dinner is for; a cancelled registration never answers). A speaker who declined or was cancelled is
 * still the same person, so their title is used whatever their status. Null when the event knows no
 * title for them, and the greeting is then the name alone. Call it INSIDE the event's tenant lane.
 */
export async function loadInviteeTitle(invite: {
  eventId: string;
  inviteeEmail: string;
  registrationId: string | null;
  speakerId: string | null;
}): Promise<string | null> {
  const sameAddress = equalsIgnoringCase(invite.inviteeEmail);
  const [linkedSpeaker, linkedRegistration] = await Promise.all([
    // A linked record counts only while it still carries the invitee's own address (review of
    // 3b8d4f365): the ids arrive from the browser when invitees are added, and a record can change
    // hands, so the id alone must never put another person's title on this name.
    invite.speakerId
      ? db.speaker.findFirst({ where: { id: invite.speakerId, eventId: invite.eventId, email: sameAddress }, select: { title: true } })
      : null,
    invite.registrationId
      ? db.registration.findFirst({
          where: { id: invite.registrationId, eventId: invite.eventId, status: { not: "CANCELLED" }, attendee: { email: sameAddress } },
          select: { attendee: { select: { title: true } } },
        })
      : null,
  ]);
  const linked = linkedSpeaker?.title ?? linkedRegistration?.attendee.title ?? null;
  if (linked) return linked;

  const [speaker, registration] = await Promise.all([
    db.speaker.findFirst({
      where: { eventId: invite.eventId, email: sameAddress, title: { not: null } },
      select: { title: true },
    }),
    db.registration.findFirst({
      where: { eventId: invite.eventId, status: { not: "CANCELLED" }, attendee: { email: sameAddress, title: { not: null } } },
      orderBy: { createdAt: "desc" },
      select: { attendee: { select: { title: true } } },
    }),
  ]);
  return speaker?.title ?? registration?.attendee.title ?? null;
}
