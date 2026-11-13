import { describe, it, expect, vi } from "vitest";

// Only the field lists are read; no query runs. CI has no database or .env.
vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { readPrismaSchema } from "../../prisma/schema-text";
import {
  PERSON_FIELD_RECORDS,
  PERSON_RECORDS,
  PERSON_RECORD_MODELS,
  personFieldsOn,
  personFieldsShared,
  type PersonRecord,
} from "@/lib/person-field-contract";
import { SYNCED_PERSON_FIELDS } from "@/lib/person-details-sync";
import { PROFILE_FIELDS } from "@/lib/registrant-details";
import { CONTACT_SYNC_OPTIONAL_FIELDS } from "@/lib/contact-sync";
import { personalDetailsFields, presenterDetailsSchema } from "@/lib/schemas";

/**
 * Step 0 of docs/ORG_FIELDS_PLAN.md. A person is stored on four records, and
 * the fields they share were listed by hand wherever details are copied
 * between them. These tests make the Prisma schema, the one declaration
 * (person-field-contract.ts) and each hand-written list agree, so a new field
 * cannot reach one record and silently miss another.
 */

const schema = readPrismaSchema();
const MODEL_NAMES = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]));

/** Every column on a model: scalars and enums, never a relation to another model. */
function columnsOf(model: string): string[] {
  const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  if (!block) throw new Error(`model ${model} not found in the Prisma schema`);
  const columns: string[] = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^(\w+)\s+(\w+)/.exec(line);
    if (!m || MODEL_NAMES.has(m[2])) continue;
    columns.push(m[1]);
  }
  return columns;
}

/**
 * Columns that are NOT a person's profile, per record, each with why. A new
 * column lands here only when it describes the row and not the person.
 */
const NOT_A_PERSON_FIELD: Record<PersonRecord, Record<string, string>> = {
  attendee: {
    id: "row identity",
    organizationId: "tenant",
    externalId: "the EventsAir import's key for the row",
    createdAt: "row timestamp",
    updatedAt: "row timestamp",
  },
  speaker: {
    id: "row identity",
    eventId: "the event the speaker belongs to",
    userId: "the linked account",
    organizationId: "tenant",
    externalId: "the EventsAir import's key for the row",
    sourceRegistrationId: "pointer to the registration it was made from",
    status: "programme fact: invited, confirmed, declined",
    submitterSource: "which door made the row",
    honorariumAmount: "programme money",
    honorariumCurrency: "programme money",
    reimbursementClaimItems: "programme money",
    agreementAcceptedAt: "speaker agreement record",
    agreementAcceptedIp: "speaker agreement record",
    agreementAcceptedBy: "speaker agreement record",
    agreementTextSnapshot: "speaker agreement record",
    presenterAgreementAcceptedAt: "presenter agreement record",
    presenterAgreementAcceptedIp: "presenter agreement record",
    presenterAgreementAcceptedBy: "presenter agreement record",
    presenterAgreementTextSnapshot: "presenter agreement record",
    createdAt: "row timestamp",
    updatedAt: "row timestamp",
  },
  contact: {
    id: "row identity",
    organizationId: "tenant",
    eventIds: "which events the contact came through",
    notes: "staff notes about the contact, not the person's own details",
    createdAt: "row timestamp",
    updatedAt: "row timestamp",
  },
  account: {
    userId: "the account the profile belongs to",
    marketingConsentAt: "consent record",
    marketingConsentIp: "consent record",
    marketingConsentWording: "consent record",
    marketingConsentWithdrawnAt: "consent record",
    signedUpAt: "marks an account made at /signup",
    createdAt: "row timestamp",
    updatedAt: "row timestamp",
  },
};

describe("the schema and the declaration agree", () => {
  for (const record of PERSON_RECORDS) {
    const model = PERSON_RECORD_MODELS[record];

    it(`every column on ${model} is a declared person field or a named exception`, () => {
      const declared = new Set<string>(personFieldsOn(record));
      const unclassified = columnsOf(model).filter((c) => !declared.has(c) && !(c in NOT_A_PERSON_FIELD[record]));
      // If this fails you added a column to a model that holds a person.
      // If it describes the person, declare it in person-field-contract.ts
      // under every record that has it, then follow the failures below to the
      // copies that must carry it. If it describes the row, name it above.
      expect(unclassified).toEqual([]);
    });

    it(`every field declared for ${model} is a real column`, () => {
      const columns = new Set(columnsOf(model));
      expect(personFieldsOn(record).filter((f) => !columns.has(f))).toEqual([]);
    });

    it(`no exception for ${model} names a column that is gone or one that is declared`, () => {
      const columns = new Set(columnsOf(model));
      const declared = new Set<string>(personFieldsOn(record));
      const stale = Object.keys(NOT_A_PERSON_FIELD[record]).filter((c) => !columns.has(c) || declared.has(c));
      expect(stale).toEqual([]);
    });
  }

  it("declares every field under at least one record", () => {
    const empty = Object.entries(PERSON_FIELD_RECORDS).filter(([, records]) => (records as readonly string[]).length === 0).map(([f]) => f);
    expect(empty).toEqual([]);
  });
});

/** `actual` must be exactly `shared` less the named exceptions, and no exception may be stale. */
function expectCarries(actual: readonly string[], shared: readonly string[], exceptions: Record<string, string>) {
  const expected = shared.filter((f) => !(f in exceptions));
  expect([...actual].sort()).toEqual([...expected].sort());
  expect(Object.keys(exceptions).filter((f) => !shared.includes(f))).toEqual([]);
}

describe("each copy between two records carries what they share", () => {
  it("speaker and registration: SYNCED_PERSON_FIELDS", () => {
    expectCarries(SYNCED_PERSON_FIELDS, personFieldsShared("attendee", "speaker"), {
      email: "has its own change flow (email-change.ts)",
      tags: "kept in step by person-tag-sync.ts",
      registrationType: "copied once when one record is made from the other, not kept in step on edit: it follows the registration's type",
    });
  });

  it("the contact sync: CONTACT_SYNC_OPTIONAL_FIELDS", () => {
    expectCarries(CONTACT_SYNC_OPTIONAL_FIELDS, personFieldsShared("attendee", "contact"), {
      email: "the contact's key, written by the sync itself",
      firstName: "always written by the sync itself",
      lastName: "always written by the sync itself",
      tags: "a contact's tags are its own; event tags are not copied onto it",
    });
  });

  it("the contact sync accepts everything a speaker shares with a contact", () => {
    const accepted = new Set<string>([...CONTACT_SYNC_OPTIONAL_FIELDS, "email", "firstName", "lastName", "tags"]);
    expect(personFieldsShared("speaker", "contact").filter((f) => !accepted.has(f))).toEqual([]);
  });

  it("the account's details: PROFILE_FIELDS", () => {
    // The account's name is on User, which the same save writes.
    expectCarries(PROFILE_FIELDS, personFieldsOn("account"), {});
  });
});

describe("the forms ask only for declared fields", () => {
  it("personalDetailsFields is the account's fields plus the name", () => {
    expect(Object.keys(personalDetailsFields).sort()).toEqual([...PROFILE_FIELDS, "firstName", "lastName"].sort());
  });

  it("the presenter doors ask only for fields a speaker has", () => {
    const onSpeaker = new Set<string>(personFieldsOn("speaker"));
    expect(Object.keys(presenterDetailsSchema.shape).filter((f) => !onSpeaker.has(f))).toEqual([]);
  });
});
