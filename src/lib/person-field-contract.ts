/**
 * The ONE declaration of a person's profile fields and which records hold a
 * column for each (Nov 13, 2026; step 0 of docs/ORG_FIELDS_PLAN.md).
 *
 * One person is stored on up to four records: the Attendee behind a
 * registration, a Speaker, the organisation's Contact, and the account's own
 * AccountProfile. Until now nothing said which fields those records share.
 * The same list was typed out by hand wherever details are copied between
 * them (the speaker and registration sync, the contact sync and its callers,
 * the account's details), so a field added to one record reached the others
 * only where somebody remembered, and a missed place is silent: the answer is
 * simply not saved there. Adding Role in July 2026 meant wiring it by hand
 * into every one of them.
 *
 * This file changes that into something a test can hold:
 *   - a column added to one of the four models fails
 *     `person-field-contract.test.ts` until it is declared here, or listed
 *     there as not a person field, with the reason;
 *   - every hand-written list of person fields is compared with what this file
 *     says the two records share, so a declared field cannot be left out of a
 *     copy without a named exception.
 *
 * Pure and client-safe: names only, no database import.
 */

export const PERSON_RECORDS = ["attendee", "speaker", "contact", "account"] as const;
export type PersonRecord = (typeof PERSON_RECORDS)[number];

/** The Prisma model behind each record. */
export const PERSON_RECORD_MODELS: Record<PersonRecord, string> = {
  attendee: "Attendee",
  speaker: "Speaker",
  contact: "Contact",
  account: "AccountProfile",
};

const ALL = ["attendee", "speaker", "contact", "account"] as const;
/** The three that hold a full person; the account's name and email are on User. */
const PEOPLE = ["attendee", "speaker", "contact"] as const;

/**
 * Every profile field, and the records that have a column for it. A field is
 * listed under a record only when that model really has the column: the test
 * checks both directions against the Prisma schema.
 */
export const PERSON_FIELD_RECORDS = {
  title: ALL,
  role: ALL,
  email: PEOPLE,
  additionalEmail: PEOPLE,
  firstName: PEOPLE,
  lastName: PEOPLE,
  organization: ALL,
  jobTitle: ALL,
  phone: ALL,
  photo: PEOPLE,
  city: ALL,
  state: ALL,
  zipCode: ALL,
  country: ALL,
  bio: PEOPLE,
  specialty: ALL,
  customSpecialty: ALL,
  registrationType: PEOPLE,
  tags: PEOPLE,
  dietaryReqs: ["attendee"],
  associationName: ["attendee", "contact"],
  memberId: ["attendee", "contact"],
  studentId: ["attendee", "contact"],
  studentIdExpiry: ["attendee", "contact"],
  customFields: ["attendee"],
  website: ["speaker"],
  socialLinks: ["speaker"],
} as const satisfies Record<string, readonly PersonRecord[]>;

export type PersonField = keyof typeof PERSON_FIELD_RECORDS;

export const PERSON_FIELDS = Object.keys(PERSON_FIELD_RECORDS) as PersonField[];

/** The person fields a record has a column for, in declaration order. */
export function personFieldsOn(record: PersonRecord): PersonField[] {
  return PERSON_FIELDS.filter((field) => (PERSON_FIELD_RECORDS[field] as readonly PersonRecord[]).includes(record));
}

/** The person fields two records both hold: what a copy between them can carry. */
export function personFieldsShared(a: PersonRecord, b: PersonRecord): PersonField[] {
  const onB = new Set<PersonField>(personFieldsOn(b));
  return personFieldsOn(a).filter((field) => onB.has(field));
}
