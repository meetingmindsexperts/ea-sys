/**
 * What a contact sync is told: the payload and the builders that make it from
 * a row (Nov 13, 2026; step 0b of docs/ORG_FIELDS_PLAN.md). Pure: no database
 * import, so a route test that stubs the write in contact-sync.ts still runs
 * the real builders. The write itself is `syncToContact` in contact-sync.ts.
 */
import type { Attendee, Prisma, Speaker } from "@prisma/client";
import { contactCategoryOf } from "@/lib/faculty-filter";
import { personFieldsOn } from "@/lib/person-field-contract";

export interface ContactSyncData {
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  eventId?: string | null;
  title?: string | null;
  role?: string | null;
  additionalEmail?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  photo?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  bio?: string | null;
  specialty?: string | null;
  customSpecialty?: string | null;
  registrationType?: string | null;
  associationName?: string | null;
  memberId?: string | null;
  studentId?: string | null;
  studentIdExpiry?: Date | null;
  /**
   * Fields the row holds that this write did NOT change. The sync writes one
   * of these only where the contact's own column is empty, never over a value
   * (Nov 13, 2026). An edit used to re-send its whole row, so opening an old
   * registration and changing its status put that row's older phone and photo
   * over newer ones on the contact; sending the changed fields alone fixed
   * that and stopped a contact's blanks from ever filling. This does both.
   * Consequence to know: a field an organiser blanks on the Contacts page
   * fills again at the next sync, from the row. That was already so when the
   * whole row replaced it.
   */
  fillBlanks?: Partial<Omit<ContactSyncData, "organizationId" | "email" | "firstName" | "lastName" | "eventId" | "fillBlanks" | "registrationType">>;
}

/**
 * The Contact columns a sync may fill, beside the name and email it always
 * writes. A list, not an object literal inside the function, so
 * person-field-contract.test.ts can hold it against the declared person
 * fields: a field a Contact shares with an Attendee or a Speaker cannot be
 * left out of here without a named exception. It says what the sync ACCEPTS.
 * A caller builds its payload with `contactSyncFromAttendee` or
 * `contactSyncFromSpeaker` below; the ones not yet moved to them still type
 * their own and can leave a field out (docs/ORG_FIELDS_PLAN.md, step 0b).
 */
export const CONTACT_SYNC_OPTIONAL_FIELDS = [
  "title",
  "role",
  "additionalEmail",
  "organization",
  "jobTitle",
  "phone",
  "photo",
  "city",
  "state",
  "zipCode",
  "country",
  "bio",
  "specialty",
  "customSpecialty",
  "registrationType",
  "associationName",
  "memberId",
  "studentId",
  "studentIdExpiry",
] as const satisfies readonly (keyof ContactSyncData)[];

/** Compile-time: every key of ContactSyncData is written by the sync, here or by name below. */
type ContactSyncKeyWritten = (typeof CONTACT_SYNC_OPTIONAL_FIELDS)[number] | "organizationId" | "email" | "firstName" | "lastName" | "eventId" | "fillBlanks";
const _everyContactSyncKeyIsWritten: Exclude<keyof ContactSyncData, ContactSyncKeyWritten> extends never ? true : never = true;
void _everyContactSyncKeyIsWritten;

export type ContactSyncOptionalField = (typeof CONTACT_SYNC_OPTIONAL_FIELDS)[number];

/**
 * A contact's category (`registrationType`) is never copied off a row: the
 * caller says it. An attendee row on the Faculty type says "Faculty", and so
 * does every speaker, and that word must never replace a contact's own
 * category ("Physician"), which feeds `registration_type` in
 * contacts_centralv1 and from there Mailchimp.
 */
type CopiedField = Exclude<ContactSyncOptionalField, "registrationType">;
const COPIED_FIELDS = CONTACT_SYNC_OPTIONAL_FIELDS.filter((field): field is CopiedField => field !== "registrationType");

/** Which organisation's contact, and through which event the person came. */
export interface ContactSyncTarget {
  organizationId: string;
  eventId?: string | null;
}

export interface AttendeeContactOptions extends ContactSyncTarget {
  /**
   * The category to write on the contact: the registration type's name for a
   * delegate, and null for the Faculty type or when this write does not decide
   * the type (null leaves the contact's category as it is). Required, so no
   * caller sends an attendee row's "Faculty" by not thinking about it.
   */
  category: string | null;
  /**
   * The fields this write changed: they replace the contact's values. A row
   * also holds values the caller did not touch, such as a photo and bio copied
   * in when the registration was made; those go as `fillBlanks`, written only
   * where the contact has nothing. Left out, every field replaces: right for a
   * row just created.
   */
  only?: readonly string[];
}

/** One value, for comparing two rows: trimmed, a Date as its instant, and null, undefined and "" all as nothing. */
function comparable(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.trim();
  return value === null || value === undefined ? "" : String(value);
}

/**
 * The copied fields whose value differs between a row before and after a
 * write: what that write changed, whatever the caller's request carried. The
 * dashboard sends its whole form on every save, so the request's keys say
 * nothing about what changed.
 */
export function changedContactFields(before: Partial<Record<CopiedField, unknown>>, after: Partial<Record<CopiedField, unknown>>): CopiedField[] {
  return COPIED_FIELDS.filter((field) => comparable(before[field]) !== comparable(after[field]));
}

/**
 * The columns a contact sync needs from an Attendee row: the name, the email
 * and EVERY optional field the sync copies. A caller that selected fewer
 * columns does not compile, which is the point: until Nov 13, 2026 each caller
 * typed its own payload and most left fields out (a person's own edit never
 * sent their Role; docs/ORG_FIELDS_PLAN.md section 3a).
 */
export type AttendeeContactSource = Pick<Attendee, "email" | "firstName" | "lastName" | CopiedField>;

/** The contact sync payload for an Attendee row: no field typed by hand. */
export function contactSyncFromAttendee(attendee: AttendeeContactSource, options: AttendeeContactOptions): ContactSyncData {
  const only = options.only ? new Set(options.only) : null;
  const fields = only ? COPIED_FIELDS.filter((field) => only.has(field)) : COPIED_FIELDS;
  const copied = Object.fromEntries(fields.map((field) => [field, attendee[field]])) as Partial<Pick<AttendeeContactSource, CopiedField>>;
  const untouched = only ? COPIED_FIELDS.filter((field) => !only.has(field)) : [];
  return {
    organizationId: options.organizationId,
    eventId: options.eventId,
    email: attendee.email,
    firstName: attendee.firstName,
    lastName: attendee.lastName,
    ...copied,
    registrationType: contactCategoryOf(options.category),
    ...(untouched.length > 0 && { fillBlanks: Object.fromEntries(untouched.map((field) => [field, attendee[field]])) }),
  };
}

/** The copied fields a Speaker row has, read from the one declaration; member and student IDs and the association are an attendee's. */
const ON_SPEAKER = new Set<string>(personFieldsOn("speaker"));
const SPEAKER_COPIED_FIELDS = COPIED_FIELDS.filter((field) => ON_SPEAKER.has(field));
type SpeakerContactField = Extract<CopiedField, keyof Speaker>;

export interface SpeakerContactOptions extends ContactSyncTarget {
  /**
   * Send only these fields (the ones this edit changed), for the same reason
   * as the attendee builder's `only`. "registrationType" among them sends the
   * category; without it an edit leaves the contact's category unsaid. Left
   * out, every field goes: right for a row just created.
   */
  only?: readonly string[];
}

/** The columns a contact sync needs from a Speaker row. */
export type SpeakerContactSource = Pick<Speaker, "email" | "firstName" | "lastName" | "registrationType" | SpeakerContactField>;

/**
 * The contact sync payload for a Speaker row. The category goes through
 * `contactCategoryOf`: a speaker's type is "Faculty" for the speakers API, and
 * only a different word (an older speaker typed "Physician") is a category.
 */
export function contactSyncFromSpeaker(speaker: SpeakerContactSource, options: SpeakerContactOptions): ContactSyncData {
  const only = options.only ? new Set(options.only) : null;
  const fields = only ? SPEAKER_COPIED_FIELDS.filter((field) => only.has(field)) : SPEAKER_COPIED_FIELDS;
  const copied = Object.fromEntries(fields.map((field) => [field, speaker[field as SpeakerContactField]])) as Partial<Pick<SpeakerContactSource, SpeakerContactField>>;
  const saysCategory = !only || only.has("registrationType");
  const untouched = only ? SPEAKER_COPIED_FIELDS.filter((field) => !only.has(field)) : [];
  return {
    organizationId: options.organizationId,
    eventId: options.eventId,
    email: speaker.email,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    ...copied,
    ...(saysCategory && { registrationType: contactCategoryOf(speaker.registrationType) }),
    ...(untouched.length > 0 && { fillBlanks: Object.fromEntries(untouched.map((field) => [field, speaker[field as SpeakerContactField]])) }),
  };
}

/**
 * A speaker about to be created, as `createMany` takes it: a field the input
 * leaves out is one the new row will not have either, so there is nothing to
 * demand. Typed as the create input (it needs `eventId`), so a row read back
 * from the database with a narrow select is not accepted here by accident:
 * for a row use `contactSyncFromSpeaker`, whose type refuses a select that
 * left a column out.
 */
export function contactSyncFromSpeakerInput(input: Prisma.SpeakerCreateManyInput, target: ContactSyncTarget): ContactSyncData {
  return contactSyncFromSpeaker(input as SpeakerContactSource, target);
}
