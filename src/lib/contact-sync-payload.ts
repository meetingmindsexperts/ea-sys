/**
 * What a contact sync is told: the payload and the builders that make it from
 * a row (Nov 13, 2026; step 0b of docs/ORG_FIELDS_PLAN.md). Pure: no database
 * import, so a route test that stubs the write in contact-sync.ts still runs
 * the real builders. The write itself is `syncToContact` in contact-sync.ts.
 */
import type { Attendee, Speaker } from "@prisma/client";
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
type ContactSyncKeyWritten = (typeof CONTACT_SYNC_OPTIONAL_FIELDS)[number] | "organizationId" | "email" | "firstName" | "lastName" | "eventId";
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
   * Send only these fields (the ones this write changed). A row also holds
   * values the caller did not touch, such as a photo and bio copied in when
   * the registration was made, and sending those would put an old value over
   * a newer one on the contact: the sync replaces a value with any other
   * non-blank value. Left out, every field goes: right for a row just created.
   */
  only?: readonly string[];
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
  return {
    organizationId: options.organizationId,
    eventId: options.eventId,
    email: attendee.email,
    firstName: attendee.firstName,
    lastName: attendee.lastName,
    ...copied,
    registrationType: contactCategoryOf(options.category),
  };
}

/** The copied fields a Speaker row has, read from the one declaration; member and student IDs and the association are an attendee's. */
const ON_SPEAKER = new Set<string>(personFieldsOn("speaker"));
const SPEAKER_COPIED_FIELDS = COPIED_FIELDS.filter((field) => ON_SPEAKER.has(field));
type SpeakerContactField = Extract<CopiedField, keyof Speaker>;

/** The columns a contact sync needs from a Speaker row. */
export type SpeakerContactSource = Pick<Speaker, "email" | "firstName" | "lastName" | "registrationType" | SpeakerContactField>;

/**
 * The contact sync payload for a Speaker row. The category goes through
 * `contactCategoryOf`: a speaker's type is "Faculty" for the speakers API, and
 * only a different word (an older speaker typed "Physician") is a category.
 */
export function contactSyncFromSpeaker(speaker: SpeakerContactSource, target: ContactSyncTarget): ContactSyncData {
  const copied = Object.fromEntries(SPEAKER_COPIED_FIELDS.map((field) => [field, speaker[field as SpeakerContactField]])) as Partial<Pick<SpeakerContactSource, SpeakerContactField>>;
  return {
    organizationId: target.organizationId,
    eventId: target.eventId,
    email: speaker.email,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    ...copied,
    registrationType: contactCategoryOf(speaker.registrationType),
  };
}

/**
 * A speaker about to be created, as `createMany` takes it: a field the input
 * leaves out is one the new row will not have either, so there is nothing to
 * demand. For a row read back from the database use `contactSyncFromSpeaker`,
 * whose type refuses a select that left a column out.
 */
export type SpeakerInputContactSource = Pick<Speaker, "email" | "firstName" | "lastName"> & {
  [K in "registrationType" | SpeakerContactField]?: Speaker[K] | null;
};

export function contactSyncFromSpeakerInput(input: SpeakerInputContactSource, target: ContactSyncTarget): ContactSyncData {
  return contactSyncFromSpeaker(input as SpeakerContactSource, target);
}
