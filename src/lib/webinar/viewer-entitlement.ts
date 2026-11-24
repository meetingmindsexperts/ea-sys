/**
 * Who may watch a webinar and take part in it, and whether its room is open (security review,
 * Nov 5, 2026, W-01 and W-02). One rule for every attendee route: zoom-join, stream-status,
 * presence, Q&A, polls, handouts, the recording and the end-of-webinar survey.
 *
 * Before this each route checked only "not CANCELLED", so a registration waiting for approval
 * (the "Physician" types on CURE2026, ESH-MM and gcchef carry one) or one with the fee unpaid could
 * watch. Owner ruling, Nov 5, 2026: a pending registration cannot watch.
 *
 * The payment half is "paid, or nothing owed on its type and rate", not "paymentStatus is PAID":
 * free registrations are not reliably COMPLIMENTARY (prod has UNPAID and UNASSIGNED rows on free
 * types), and those must keep working.
 *
 * Applies to WEBINAR events only. A conference's Zoom sessions keep the old rule: an in-person
 * delegate paying at the desk must still open the session link, and the approval types belong to
 * the webinars.
 *
 * WHOSE registration (owner, Nov 24, 2026): one in the viewer's account, or, on a free webinar
 * registration only, one on the account's own address that no account holds. Every route asks
 * `viewerAccessWhere`; the reasons and the limits are on it.
 */
import type { Prisma, RegistrationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { equalsIgnoringCase } from "@/lib/like-escape";
import { readWebinarSettings } from "@/lib/webinar";

export const WEBINAR_VIEWER_STATUSES: RegistrationStatus[] = ["CONFIRMED", "CHECKED_IN"];
const SETTLED_PAYMENT_STATUSES = ["PAID", "COMPLIMENTARY", "INCLUSIVE"] as const;

/** Nothing is charged on the registration: its rate is free, or it has no rate and its type is free
 *  (a rate's price wins over its type's, as in the register route; review L2: a free rate on a paid
 *  type, imported as UNASSIGNED, was refused). */
const NOTHING_OWED: Prisma.RegistrationWhereInput = {
  OR: [
    { pricingTier: { price: 0 } },
    { pricingTierId: null, OR: [{ ticketTypeId: null }, { ticketType: { price: 0 } }] },
  ],
};

/**
 * The standing half of the rule: the status and payment a registration needs, whoever holds it.
 * For a caller that decides WHOSE registration it is by another rule (the portal's replay page,
 * registrant-replays.ts); everything else uses viewerRegistrationWhere below.
 */
export function viewerStandingWhere(eventType: string | null | undefined): Prisma.RegistrationWhereInput {
  if (eventType !== "WEBINAR") return { status: { not: "CANCELLED" } };
  return {
    status: { in: WEBINAR_VIEWER_STATUSES },
    OR: [{ paymentStatus: { in: [...SETTLED_PAYMENT_STATUSES] } }, NOTHING_OWED],
  };
}

/**
 * A registration IN the viewer's account, with the standing to watch. `eventType` picks the rule
 * (see the header). This is half of who may watch: a route asks `viewerAccessWhere` below, which
 * adds the free-webinar allowance. A test keeps this name out of every route.
 */
export function viewerRegistrationWhere(
  eventId: string,
  userId: string,
  eventType: string | null | undefined,
): Prisma.RegistrationWhereInput {
  return { eventId, userId, ...viewerStandingWhere(eventType) };
}

/**
 * THE filter a route uses to find the registration someone watches through (owner, Nov 24, 2026).
 *
 * It is `viewerRegistrationWhere` (a registration in their account) and, on a WEBINAR only, one
 * more case: a registration that owes nothing, sits on the account's OWN email address, and is in
 * no account at all. That is someone who has an older account and registered without signing in.
 * Until this day they were told "Register to join" and had to confirm their address with the old
 * account's password first: 6 of the 120 people registered for the webinar of that evening, and
 * the owner's own trial that morning ended at the password box.
 *
 * What the allowance is NOT. It never attaches the registration to the account and it opens
 * nothing but the room: My events, the person's details, payment and certificates still go by
 * registrant-access.ts, which wants the address confirmed. It never applies to a registration
 * with a price (someone could otherwise take a paid seat by making an account on the payer's
 * address), to a conference, or to a registration another account holds.
 *
 * What it gives up, knowingly: an account made on a registered person's address can watch a free
 * webinar as them, their name on a question they ask and the attendance credited to them. On a
 * free webinar that person could have registered themselves, so nothing is gained by it.
 *
 * The address is the ACCOUNT's, read from the database (a session carries the address it signed
 * in with, which a later change of email leaves stale). If it cannot be read the old rule stands.
 */
export async function viewerAccessWhere(
  eventId: string,
  userId: string,
  eventType: string | null | undefined,
): Promise<Prisma.RegistrationWhereInput> {
  const own = viewerRegistrationWhere(eventId, userId, eventType);
  if (eventType !== "WEBINAR") return own;
  const email = await viewerAddress(userId);
  if (!email) return own;
  return {
    eventId,
    AND: [
      viewerStandingWhere(eventType),
      {
        OR: [
          { userId },
          { AND: [{ userId: null }, { attendee: { email: equalsIgnoringCase(email) } }, NOTHING_OWED] },
        ],
      },
    ],
  };
}

// The account's address, kept for a minute per instance: the routes that ask are polled by every
// viewer (stream status, presence), and a second query on each poll is a query per viewer per
// few seconds for an answer that almost never changes.
const addressCache = new Map<string, { email: string | null; at: number }>();
const ADDRESS_TTL_MS = 60_000;
const ADDRESS_CACHE_MAX = 5_000;

/** For tests. */
export function resetViewerAddressCache(): void {
  addressCache.clear();
}

async function viewerAddress(userId: string): Promise<string | null> {
  const cached = addressCache.get(userId);
  if (cached && Date.now() - cached.at < ADDRESS_TTL_MS) return cached.email;
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    const email = user?.email?.trim().toLowerCase() || null;
    if (addressCache.size >= ADDRESS_CACHE_MAX) addressCache.clear();
    addressCache.set(userId, { email, at: Date.now() });
    return email;
  } catch (err) {
    // Not cached: the next request asks again. Without the address only a registration in the
    // account watches, which is the rule as it was.
    apiLogger.warn({ err, msg: "webinar-viewer:address-read-failed", userId });
    return null;
  }
}

export type ViewerRefusal = "PENDING_APPROVAL" | "WAITLISTED" | "PAYMENT_OUTSTANDING";

export const VIEWER_REFUSAL_MESSAGE: Record<ViewerRefusal, string> = {
  PENDING_APPROVAL: "Your registration is awaiting approval. You can join once it has been approved.",
  WAITLISTED: "You are on the waiting list for this webinar. You can join once your place is confirmed.",
  PAYMENT_OUTSTANDING: "Your registration's payment is not complete. Please contact the organisers if you think this is wrong.",
};

/**
 * Why a signed-in person holding a live (not cancelled) registration is not let in, or null when
 * they hold none (then they are simply not registered). Only called on the refusal path.
 */
export async function viewerRefusal(eventId: string, userId: string): Promise<ViewerRefusal | null> {
  const registrations = await db.registration.findMany({
    where: { eventId, userId, status: { not: "CANCELLED" } },
    select: { status: true },
  });
  if (registrations.length === 0) return null;
  if (registrations.some((r) => r.status === "PENDING")) return "PENDING_APPROVAL";
  if (registrations.some((r) => r.status === "WAITLISTED")) return "WAITLISTED";
  return "PAYMENT_OUTSTANDING";
}

/** Per-container micro-cache, like lobby-status: 5k players poll stream-status every ~10 s. */
const roomCache = new Map<string, { open: boolean; at: number }>();
const ROOM_TTL_MS = 3000;

/** Test hook. */
export function resetRoomOpenCache(): void {
  roomCache.clear();
}

/**
 * Whether the producer has opened the webinar's room: its ANCHOR session is LIVE (a DRAFT event
 * opens on its own so organisers can test, as in lobby-status). The anchor is read from the
 * event's settings and bound to the event, so another session's id cannot open the room. True for
 * any other event type, which has no room.
 */
export async function isViewerRoomOpen(
  event: { id: string; status: string; eventType: string | null; settings: unknown },
  sessionId: string,
): Promise<boolean> {
  if (event.eventType !== "WEBINAR") return true;
  if (event.status === "DRAFT") return true;
  const anchorId = readWebinarSettings(event.settings)?.sessionId || sessionId;
  const key = `${event.id}:${anchorId}`;
  const cached = roomCache.get(key);
  if (cached && Date.now() - cached.at < ROOM_TTL_MS) return cached.open;
  let anchor = await db.eventSession.findFirst({
    where: { id: anchorId, eventId: event.id },
    select: { status: true },
  });
  // A dangling anchor pointer (session deleted; the provisioner heals it): the detail route falls
  // through to the URL's own session, and lobby-status reads that one, so this must too, or the
  // room never opens for anyone (review M2).
  if (!anchor && anchorId !== sessionId) {
    anchor = await db.eventSession.findFirst({ where: { id: sessionId, eventId: event.id }, select: { status: true } });
  }
  const open = anchor?.status === "LIVE";
  if (roomCache.size > 5000) roomCache.clear();
  roomCache.set(key, { open, at: Date.now() });
  return open;
}
