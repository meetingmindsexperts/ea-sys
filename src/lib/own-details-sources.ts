import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { equalsIgnoringCase } from "@/lib/like-escape";
import { ownRegistrationWhere, type RegistrantScope } from "@/lib/registrant-access";

/**
 * THE rule for "what has this person already told us about themselves", for a
 * form that offers it back (review of 5c66e67d, Nov 10, 2026).
 *
 * The abstract sign-in door and the event's My Details each had their own
 * list of sources and already disagreed (one skipped a cancelled registration,
 * the other read the account's saved details). Both now read this, so the same
 * person is offered the same values on the same day.
 *
 * Only this person's rows. A row found by ADDRESS alone counts only once the
 * address is proven (registrant-access.ts) and only while no other account
 * holds it: an invited speaker's details are theirs until then.
 *
 * In order, the first with a value wins per field:
 *  1. the account's saved details (AccountProfile), the person's own statement;
 *  2. their three latest speaker records, where a bio lives;
 *  3. their three latest registrations that are not cancelled. Three, not one:
 *     a speaker's companion registration is made from a name and an address,
 *     and as the latest it hid every detail given before it.
 */

export const OWN_DETAIL_SELECT = {
  title: true, role: true, firstName: true, lastName: true, additionalEmail: true,
  organization: true, jobTitle: true, phone: true, city: true, state: true, zipCode: true,
  country: true, specialty: true, customSpecialty: true, bio: true,
} as const;

export type OwnDetailKey = keyof typeof OWN_DETAIL_SELECT;
export type OwnDetails = Partial<Record<OwnDetailKey, string | null>>;

const LATEST = 3;

export async function loadOwnDetailSources(args: {
  userId: string;
  /** Null when the account could not be read: linked rows only. */
  scope: RegistrantScope | null;
  /** The event whose own records the caller reads itself, ahead of these. */
  exceptEventId?: string;
}): Promise<OwnDetails[]> {
  const { userId, scope, exceptEventId } = args;
  const proven = scope?.confirmed && scope.email ? scope.email : null;
  const mySpeakers: Prisma.SpeakerWhereInput = proven
    ? { OR: [{ userId }, { userId: null, email: equalsIgnoringCase(proven) }] }
    : { userId };
  const [profile, speakers, registrations] = await Promise.all([
    db.accountProfile.findUnique({ where: { userId } }),
    db.speaker.findMany({
      where: { ...mySpeakers, ...(exceptEventId && { eventId: { not: exceptEventId } }) },
      orderBy: { updatedAt: "desc" },
      take: LATEST,
      select: OWN_DETAIL_SELECT,
    }),
    db.registration.findMany({
      where: { status: { not: "CANCELLED" }, ...(scope ? ownRegistrationWhere(scope) : { userId }) },
      orderBy: { createdAt: "desc" },
      take: LATEST,
      select: { attendee: { select: OWN_DETAIL_SELECT } },
    }),
  ]);
  return [...(profile ? [profile as OwnDetails] : []), ...speakers, ...registrations.map((r) => r.attendee)];
}

/** The first source holding a value for `key`, trimmed; "" when none does. */
export function firstGiven(sources: Array<OwnDetails | null | undefined>, key: OwnDetailKey): string {
  for (const source of sources) {
    const value = source?.[key]?.toString().trim();
    if (value) return value;
  }
  return "";
}
