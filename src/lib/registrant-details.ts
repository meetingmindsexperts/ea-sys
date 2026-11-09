import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { syncToContact } from "@/lib/contact-sync";
import { ownRegistrationWhere, type RegistrantScope } from "@/lib/registrant-access";
import { MARKETING_CONSENT_WORDING_VERSION } from "@/lib/marketing-consent";

/**
 * A person's own details: the account's (AccountProfile, Nov 9, 2026) and the
 * write onto a registration's Attendee that both the per-event self-edit and
 * My Details use. docs/ACCOUNT_SIGNUP_PLAN.md.
 */

/** The fields an account holds, in the order the forms ask them. */
export const PROFILE_FIELDS = [
  "title",
  "role",
  "organization",
  "jobTitle",
  "phone",
  "city",
  "state",
  "zipCode",
  "country",
  "specialty",
  "customSpecialty",
] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

export type AccountDetails = {
  firstName: string;
  lastName: string;
} & { [K in ProfileField]: string | null };

const ATTENDEE_PROFILE_SELECT = {
  firstName: true,
  lastName: true,
  ...(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, true])) as Record<ProfileField, true>),
} as const;

function blankToNull(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : null;
}

/**
 * The person's details as My Details shows them: the account's own profile
 * when they have saved one (or signed up with one), otherwise what they gave
 * on their latest registration (by the portal's rule, ownRegistrationWhere),
 * otherwise just the account's name.
 */
export async function readAccountDetails(scope: RegistrantScope): Promise<{
  details: AccountDetails;
  source: "account" | "registration" | "none";
  marketing: { consented: boolean; since: Date | null };
}> {
  const [user, profile] = await Promise.all([
    db.user.findUnique({ where: { id: scope.userId }, select: { firstName: true, lastName: true } }),
    db.accountProfile.findUnique({ where: { userId: scope.userId } }),
  ]);
  const name = { firstName: user?.firstName ?? "", lastName: user?.lastName ?? "" };
  const marketing = {
    consented: !!profile?.marketingConsentAt && !profile.marketingConsentWithdrawnAt,
    since: profile?.marketingConsentWithdrawnAt ? null : (profile?.marketingConsentAt ?? null),
  };
  // A profile with no details is only a consent record (a person who ticked
  // the box but never filled in details): fall through to the registration.
  if (profile && PROFILE_FIELDS.some((f) => profile[f] !== null)) {
    return { details: { ...name, ...pickProfile(profile) }, source: "account", marketing };
  }
  const latest = await db.registration.findFirst({
    where: ownRegistrationWhere(scope),
    orderBy: { createdAt: "desc" },
    select: { attendee: { select: ATTENDEE_PROFILE_SELECT } },
  });
  if (latest) return { details: { ...name, ...pickProfile(latest.attendee) }, source: "registration", marketing };
  return { details: { ...name, ...pickProfile({}) }, source: "none", marketing };
}

function pickProfile(row: Partial<Record<ProfileField, string | null>>): Record<ProfileField, string | null> {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f, row[f] ?? null])) as Record<ProfileField, string | null>;
}

/**
 * Write a registration's Attendee row and touch the registration(s) on it, so
 * a staff screen opened earlier sees the change: staff edits carry the
 * registration's updatedAt as their token, and an attendee-only write never
 * moved it, so staff silently overwrote the attendee's own edit (Oct 29,
 * 2026). Then the organisation's contact store follows. The ONE attendee write
 * for a person's own edits: the per-event self-edit and My Details.
 */
export async function writeOwnAttendee(
  registration: { attendeeId: string; eventId: string },
  data: Prisma.AttendeeUpdateInput,
) {
  const attendee = await tenantTransaction(async (tx) => {
    // Rows in id order, as the bulk paths take them (review of a10e8058, L7).
    await tx.$queryRaw`SELECT id FROM "Registration" WHERE "attendeeId" = ${registration.attendeeId} ORDER BY id FOR UPDATE`;
    await tx.registration.updateMany({ where: { attendeeId: registration.attendeeId }, data: { updatedAt: new Date() } });
    return tx.attendee.update({ where: { id: registration.attendeeId }, data });
  });
  const event = await db.event.findFirst({ where: { id: registration.eventId }, select: { organizationId: true } });
  if (event) {
    await syncToContact({
      organizationId: event.organizationId,
      eventId: registration.eventId,
      email: attendee.email,
      additionalEmail: attendee.additionalEmail,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      title: attendee.title,
      organization: attendee.organization,
      jobTitle: attendee.jobTitle,
      phone: attendee.phone,
      city: attendee.city,
      country: attendee.country,
      specialty: attendee.specialty,
      registrationType: attendee.registrationType,
      associationName: attendee.associationName,
      memberId: attendee.memberId,
      studentId: attendee.studentId,
      studentIdExpiry: attendee.studentIdExpiry,
    });
  }
  return attendee;
}

/** The details a save carries, already validated (personalDetailsFields). */
export interface DetailsInput {
  title?: string | null;
  role?: string | null;
  firstName: string;
  lastName: string;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  specialty?: string | null;
  customSpecialty?: string | null;
}

/** Trimmed, blanks as null: how both sides are compared and stored. */
export function normalizeDetails(input: DetailsInput): AccountDetails {
  return {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    ...(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, blankToNull(input[f])])) as Record<ProfileField, string | null>),
  };
}

/** The fields whose value differs, comparing normalised values. */
export function changedFields(before: AccountDetails, after: AccountDetails): (keyof AccountDetails)[] {
  const keys: (keyof AccountDetails)[] = ["firstName", "lastName", ...PROFILE_FIELDS];
  return keys.filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}

/** Prisma data for an AccountProfile from details (enum fields typed by the caller's validation). */
function profileData(d: AccountDetails) {
  return {
    title: d.title as Prisma.AccountProfileCreateInput["title"],
    role: d.role as Prisma.AccountProfileCreateInput["role"],
    organization: d.organization,
    jobTitle: d.jobTitle,
    phone: d.phone,
    city: d.city,
    state: d.state,
    zipCode: d.zipCode,
    country: d.country,
    specialty: d.specialty,
    customSpecialty: d.customSpecialty,
  };
}

/** Consent as given now, or withdrawn now, or left as it is. */
function consentData(consent: boolean | undefined, current: { marketingConsentAt: Date | null; marketingConsentWithdrawnAt: Date | null } | null, ip: string | null) {
  if (consent === undefined) return {};
  const consented = !!current?.marketingConsentAt && !current.marketingConsentWithdrawnAt;
  if (consent && !consented) {
    return { marketingConsentAt: new Date(), marketingConsentIp: ip, marketingConsentWording: MARKETING_CONSENT_WORDING_VERSION, marketingConsentWithdrawnAt: null };
  }
  if (!consent && consented) return { marketingConsentWithdrawnAt: new Date() };
  return {};
}

/** A new account's profile, created with the account at /signup. */
export function newAccountProfileData(details: AccountDetails, consent: boolean, ip: string | null) {
  return { ...profileData(details), ...consentData(consent, null, ip) };
}

/** Create or replace the account's profile (My Details). */
export async function saveAccountProfile(userId: string, details: AccountDetails, consent: boolean | undefined, ip: string | null) {
  const current = await db.accountProfile.findUnique({
    where: { userId },
    select: { marketingConsentAt: true, marketingConsentWithdrawnAt: true },
  });
  const data = { ...profileData(details), ...consentData(consent, current, ip) };
  await db.$transaction([
    db.accountProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data }),
    db.user.update({
      where: { id: userId },
      data: { firstName: details.firstName, lastName: details.lastName, specialty: details.specialty },
    }),
  ]);
}

/**
 * Copy the fields this edit CHANGED onto the person's upcoming registrations
 * (owner, Nov 9, 2026: My Details also updates upcoming registrations).
 *
 *  - Only registrations LINKED to the account (userId), never one matched by
 *    address alone, the same ownership the per-event self-edit requires.
 *  - Only upcoming: the event has not started, and the registration is not
 *    checked in or cancelled. A past registration keeps what its badge,
 *    certificate and invoice were made from.
 *  - Only the changed fields (delta, as person-details-sync.ts): a save that
 *    leaves organisation alone never overwrites a registration that was
 *    deliberately made under another organisation.
 *  - Never a shared Attendee row (legacy rows back registrations at several
 *    events, writing one would rewrite another event's registration): skipped
 *    and logged.
 *  - Never a speaker record: a registrant's own edit does not reach a speaker
 *    profile (person-details-sync.ts, review H1/H2).
 *
 * Best-effort per registration: one failing logs and the rest continue.
 */
export async function copyToUpcomingRegistrations(
  userId: string,
  changed: (keyof AccountDetails)[],
  details: AccountDetails,
  now: Date,
): Promise<{ updated: number; skipped: number; failed: number }> {
  if (changed.length === 0) return { updated: 0, skipped: 0, failed: 0 };
  const registrations = await db.registration.findMany({
    where: { userId, status: { in: ["PENDING", "CONFIRMED", "WAITLISTED"] }, event: { startDate: { gt: now } } },
    select: { id: true, attendeeId: true, eventId: true, attendee: { select: { _count: { select: { registrations: true } } } } },
  });
  const data: Prisma.AttendeeUpdateInput = Object.fromEntries(changed.map((k) => [k, details[k]]));
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of registrations) {
    if (r.attendee._count.registrations > 1) {
      skipped += 1;
      apiLogger.warn({ msg: "registrant-details:shared-attendee-skipped", userId, registrationId: r.id, attendeeId: r.attendeeId });
      continue;
    }
    try {
      await writeOwnAttendee(r, data);
      updated += 1;
    } catch (err) {
      failed += 1;
      apiLogger.error({ err, msg: "registrant-details:copy-failed", userId, registrationId: r.id });
    }
  }
  return { updated, skipped, failed };
}
