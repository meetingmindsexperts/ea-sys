/**
 * The organisation's own answers for a person field (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). Today: Specialty. The list is replaced as a whole,
 * like the organisation's sponsor tiers.
 *
 * Rules, all enforced here and not only on the screen:
 *   - An answer's text is what is stored on every registration, speaker and
 *     contact that chose it, so it is never edited. To change one, retire it
 *     and add another.
 *   - An answer stored on a record cannot be removed, only retired: a
 *     retired one is no longer offered and still reads correctly wherever it
 *     is stored. "Stored" is counted on contacts, registrations, speakers and
 *     events; an account's own profile and an abstract are not counted, and an
 *     answer held only there still displays after it is removed.
 *   - "Others" is not an answer on the list: it is the switch that offers
 *     free text beside the list.
 *   - Something must be offered: a list with every answer retired and Others
 *     off would leave a required picker empty on every form.
 *   - The save says which list it was edited from. The whole list is replaced,
 *     so a save made from an older copy would silently undo someone else's
 *     change; it is refused instead (`LIST_CHANGED`).
 *
 * Read, plan, in-use check and write happen in ONE transaction holding the
 * organisation row lock, the same lock every other settings writer takes, so
 * the comparison with the stored list and the write cannot be separated, and
 * no other settings key is lost. The caller must be inside the organisation's
 * tenant lane (the route enters it).
 */
import type { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  CONFIGURABLE_PERSON_FIELDS,
  MAX_PERSON_FIELD_ANSWER,
  MAX_PERSON_FIELD_LABEL,
  MAX_PERSON_FIELD_OPTIONS,
  OTHER_ANSWER,
  PERSON_FIELDS_SETTING,
  looseForm,
  readPersonFields,
  type ConfigurablePersonField,
  type PersonFieldConfig,
  type PersonFieldOption,
  type PersonFieldsConfig,
} from "@/lib/person-fields";

export type SaveSpecialtyAnswersErrorCode =
  | "ORGANIZATION_NOT_FOUND"
  | "TOO_MANY"
  | "INVALID_ANSWER"
  | "RESERVED_ANSWER"
  | "DUPLICATE_ANSWER"
  | "NOTHING_OFFERED"
  | "LIST_CHANGED"
  | "ANSWER_IN_USE"
  | "UNKNOWN";

export interface AnswerInUse {
  answer: string;
  /** Rows that store it: one person can be several (a contact, a speaker, two registrations). */
  records: number;
}

export type SaveSpecialtyAnswersResult =
  | { ok: true; field: PersonFieldConfig }
  | { ok: false; code: SaveSpecialtyAnswersErrorCode; message: string; inUse?: AnswerInUse[] };

const fail = (code: SaveSpecialtyAnswersErrorCode, message: string, inUse?: AnswerInUse[]): SaveSpecialtyAnswersResult => ({
  ok: false,
  code,
  message,
  ...(inUse ? { inUse } : {}),
});

export interface SpecialtyAnswerInput {
  answer: string;
  retired?: boolean;
}

/** Tabs, line breaks and the like: never part of an answer, and a NUL makes the database refuse the whole setting. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** What a save was edited from, compared with what is stored. */
export interface SpecialtyListSnapshot {
  answers: { answer: string; retired?: boolean }[];
  allowOther: boolean;
}

function sameList(field: PersonFieldConfig, expected: SpecialtyListSnapshot): boolean {
  if (field.allowOther !== expected.allowOther || field.options.length !== expected.answers.length) return false;
  return field.options.every((o, i) => o.key === expected.answers[i].answer && o.retired === (expected.answers[i].retired === true));
}

/** The next list, or the reason the input cannot become one. Pure: no database. */
export function planSpecialtyAnswers(
  input: SpecialtyAnswerInput[],
  allowOther = true,
): { ok: true; next: PersonFieldOption[] } | { ok: false; result: SaveSpecialtyAnswersResult } {
  if (input.length > MAX_PERSON_FIELD_OPTIONS) {
    return { ok: false, result: fail("TOO_MANY", `At most ${MAX_PERSON_FIELD_OPTIONS} answers.`) };
  }
  const seen = new Set<string>();
  const next: PersonFieldOption[] = [];
  for (const entry of input) {
    const text = typeof entry.answer === "string" ? entry.answer.trim() : "";
    if (!text || text.length > MAX_PERSON_FIELD_ANSWER || CONTROL_CHARACTER.test(text)) {
      return { ok: false, result: fail("INVALID_ANSWER", `An answer needs 1 to ${MAX_PERSON_FIELD_ANSWER} characters.`) };
    }
    if (text.toLowerCase() === OTHER_ANSWER.toLowerCase()) {
      return { ok: false, result: fail("RESERVED_ANSWER", `"${OTHER_ANSWER}" is not an answer on the list. Switch "Offer ${OTHER_ANSWER}" on to let people type their own.`) };
    }
    if (seen.has(text.toLowerCase())) {
      return { ok: false, result: fail("DUPLICATE_ANSWER", `"${text}" is in the list twice.`) };
    }
    seen.add(text.toLowerCase());
    next.push({ key: text, label: text, retired: entry.retired === true });
  }
  if (!allowOther && next.every((o) => o.retired)) {
    return {
      ok: false,
      result: fail("NOTHING_OFFERED", `Offer at least one answer, or switch "Offer ${OTHER_ANSWER}" on: the forms require a specialty, and an empty picker cannot be answered.`),
    };
  }
  return { ok: true, next };
}

type Tx = Prisma.TransactionClient;

/**
 * How many records in this organisation store each of these answers: its
 * contacts, the attendees and speakers of its events, and an event's own
 * topic. Records, not people: one person can be a contact, a speaker and two
 * registrations.
 */
export async function countSpecialtyUse(tx: Tx | typeof db, organizationId: string, answers: string[]): Promise<Map<string, number>> {
  const use = new Map<string, number>();
  if (answers.length === 0) return use;
  const add = (rows: { specialty: string | null; _count: { _all: number } }[]) => {
    for (const row of rows) {
      if (row.specialty) use.set(row.specialty, (use.get(row.specialty) ?? 0) + row._count._all);
    }
  };
  const [contacts, attendees, speakers, events] = await Promise.all([
    tx.contact.groupBy({ by: ["specialty"], where: { organizationId, specialty: { in: answers } }, _count: { _all: true } }),
    tx.attendee.groupBy({
      by: ["specialty"],
      where: { specialty: { in: answers }, registrations: { some: { event: { organizationId } } } },
      _count: { _all: true },
    }),
    tx.speaker.groupBy({ by: ["specialty"], where: { specialty: { in: answers }, event: { organizationId } }, _count: { _all: true } }),
    tx.event.groupBy({ by: ["specialty"], where: { organizationId, specialty: { in: answers } }, _count: { _all: true } }),
  ]);
  add(contacts);
  add(attendees);
  add(speakers);
  add(events);
  return use;
}

type SaveOutcome =
  | { saved: false; result: SaveSpecialtyAnswersResult }
  | { saved: true; before: PersonFieldConfig; after: PersonFieldConfig; removed: string[] };

export async function saveSpecialtyAnswers(input: {
  organizationId: string;
  actorUserId: string;
  answers: SpecialtyAnswerInput[];
  allowOther: boolean;
  /** The list this edit started from, as the screen loaded it. */
  expected: SpecialtyListSnapshot;
}): Promise<SaveSpecialtyAnswersResult> {
  try {
    const plan = planSpecialtyAnswers(input.answers, input.allowOther);
    if (!plan.ok) return plan.result;

    // In the caller's tenant lane: the in-use count reads contacts, attendees
    // and speakers, which sit behind a row policy on the platform. Outside the
    // lane those reads come back empty, and a held answer would look unused.
    const outcome = await tenantTransaction(async (tx): Promise<SaveOutcome> => {
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false, result: fail("ORGANIZATION_NOT_FOUND", "Organisation not found") };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const before = readPersonFields(settings).specialty;
      if (!sameList(before, input.expected)) {
        return {
          saved: false,
          result: fail("LIST_CHANGED", "Someone else changed this list after you opened it. It has been reloaded: make your change again."),
        };
      }

      const kept = new Set(plan.next.map((o) => o.key));
      const removed = before.options.map((o) => o.key).filter((key) => !kept.has(key));
      const use = await countSpecialtyUse(tx, input.organizationId, removed);
      const inUse = removed.flatMap((answer) => {
        const records = use.get(answer) ?? 0;
        return records > 0 ? [{ answer, records }] : [];
      });
      if (inUse.length > 0) {
        const names = inUse.map((a) => `${a.answer} (${a.records})`).join(", ");
        return {
          saved: false,
          result: fail("ANSWER_IN_USE", `These answers are stored on records, so they can be retired and not removed: ${names}.`, inUse),
        };
      }

      // The label and the on/off and required switches are kept as they are: this save is the answers.
      const after: PersonFieldConfig = { enabled: before.enabled, required: before.required, label: before.label, options: plan.next, allowOther: input.allowOther };
      const saved = (settings[PERSON_FIELDS_SETTING] && typeof settings[PERSON_FIELDS_SETTING] === "object" ? settings[PERSON_FIELDS_SETTING] : {}) as Record<string, unknown>;
      await tx.organization.update({
        where: { id: input.organizationId },
        data: { settings: { ...settings, [PERSON_FIELDS_SETTING]: { ...saved, specialty: after } } as unknown as Prisma.InputJsonValue },
      });
      return { saved: true, before, after, removed };
    });

    if (!outcome.saved) return outcome.result;
    const texts = (field: PersonFieldConfig) => field.options.map((o) => (o.retired ? `${o.key} (retired)` : o.key));
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: {
            specialtyAnswers: {
              before: texts(outcome.before),
              after: texts(outcome.after),
              allowOtherBefore: outcome.before.allowOther,
              allowOtherAfter: outcome.after.allowOther,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "person-fields:audit-failed"));
    apiLogger.info(
      { organizationId: input.organizationId, by: input.actorUserId, count: outcome.after.options.length, removed: outcome.removed },
      "person-fields:specialty-saved",
    );
    return { ok: true, field: outcome.after };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "person-fields:specialty-save-failed");
    return fail("UNKNOWN", "Failed to save the specialty answers");
  }
}

/**
 * Whether the organisation asks Title, Role and Specialty at all, and whether
 * an answer is demanded (Nov 13, 2026; step 2 of docs/ORG_FIELDS_PLAN.md).
 * Every form and every server door reads these through `personFieldRules`.
 *
 * Only the two switches change: a field's label and answers are kept. The save
 * says which switches it was edited from and is refused when they have changed
 * since, for the same reason the answers' save is.
 */
export type PersonFieldSwitches = Record<ConfigurablePersonField, { enabled: boolean; required: boolean }>;

export type SavePersonFieldSwitchesResult =
  | { ok: true; switches: PersonFieldSwitches }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" | "SWITCHES_CHANGED" | "UNKNOWN"; message: string };

export function switchesOf(config: PersonFieldsConfig): PersonFieldSwitches {
  const one = (field: PersonFieldConfig) => ({ enabled: field.enabled, required: field.required });
  return { title: one(config.title), role: one(config.role), specialty: one(config.specialty) };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const sameSwitches = (a: PersonFieldSwitches, b: PersonFieldSwitches) =>
  CONFIGURABLE_PERSON_FIELDS.every((f) => a[f].enabled === b[f].enabled && a[f].required === b[f].required);

export async function savePersonFieldSwitches(input: {
  organizationId: string;
  actorUserId: string;
  switches: PersonFieldSwitches;
  /** The switches as the screen loaded them. */
  expected: PersonFieldSwitches;
}): Promise<SavePersonFieldSwitchesResult> {
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false as const, code: "ORGANIZATION_NOT_FOUND" as const };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const config = readPersonFields(settings);
      const before = switchesOf(config);
      if (!sameSwitches(before, input.expected)) return { saved: false as const, code: "SWITCHES_CHANGED" as const };

      // ONLY the two switches are written, onto whatever the field already
      // holds. A field with no list of its own gets none here: it keeps
      // following today's lists (readField in person-fields.ts reads the
      // switches and the list apart).
      const saved = (isPlainObject(settings[PERSON_FIELDS_SETTING]) ? settings[PERSON_FIELDS_SETTING] : {}) as Record<string, unknown>;
      const next = Object.fromEntries(
        CONFIGURABLE_PERSON_FIELDS.map((f) => [
          f,
          // Title is on or off only (owner, Nov 13, 2026): whether it is
          // demanded is not this screen's to change, whatever a request says.
          { ...(isPlainObject(saved[f]) ? saved[f] : {}), enabled: input.switches[f].enabled, required: f === "title" ? before.title.required : input.switches[f].required },
        ]),
      );
      await tx.organization.update({
        where: { id: input.organizationId },
        data: { settings: { ...settings, [PERSON_FIELDS_SETTING]: { ...saved, ...next } } as unknown as Prisma.InputJsonValue },
      });
      return { saved: true as const, before, after: switchesOf(readPersonFields({ [PERSON_FIELDS_SETTING]: { ...saved, ...next } })) };
    });

    if (!outcome.saved) {
      return outcome.code === "ORGANIZATION_NOT_FOUND"
        ? { ok: false, code: "ORGANIZATION_NOT_FOUND", message: "Organisation not found" }
        : { ok: false, code: "SWITCHES_CHANGED", message: "Someone else changed these switches after you opened them. They have been reloaded: make your change again." };
    }
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: { personFieldSwitches: { before: outcome.before, after: outcome.after } } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "person-fields:audit-failed"));
    apiLogger.info({ organizationId: input.organizationId, by: input.actorUserId, switches: outcome.after }, "person-fields:switches-saved");
    return { ok: true, switches: outcome.after };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "person-fields:switches-save-failed");
    return { ok: false, code: "UNKNOWN", message: "Failed to save the form fields" };
  }
}

/* ─────────────────────────────── Role answers ─────────────────────────────── */

/**
 * The organisation's own Role answers (step 1d of docs/ORG_FIELDS_PLAN.md).
 * Unlike Specialty, Role stores a KEY and shows a label, so an answer can be
 * relabelled without touching a single record; the key never changes.
 *
 * Rules, all enforced here:
 *   - A new answer gets a key made once from its label (`roleKeyFor`), never
 *     changed after; an existing answer is named by its key.
 *   - An answer held by any record (a contact, an attendee or a speaker of the
 *     organisation's events) is retired, never removed.
 *   - No two answers may read the same once case, accents and punctuation are
 *     ignored, key or label: a file or a person typing could not tell them
 *     apart (`answerKeyFor` refuses a tie). The key "__none__" is the
 *     contacts filter's "Not recorded" and is never an answer.
 *   - Something must be offered: Role has no free-text "Others".
 *   - A save made from an older copy of the list is refused (LIST_CHANGED).
 *   - A RELABEL marks every contact holding that answer as updated in the
 *     same transaction, so the contacts feed (contacts_centralv1, read by
 *     Mailchimp through n8n, which keys segments on the label) re-sends them
 *     with the new word on its next run, instead of holding old and new words
 *     side by side.
 */
export type SaveRoleAnswersErrorCode =
  | "ORGANIZATION_NOT_FOUND"
  | "TOO_MANY"
  | "INVALID_ANSWER"
  | "UNKNOWN_KEY"
  | "DUPLICATE_ANSWER"
  | "NOTHING_OFFERED"
  | "LIST_CHANGED"
  | "ANSWER_IN_USE"
  | "UNKNOWN";

export type SaveRoleAnswersResult =
  | { ok: true; field: PersonFieldConfig; relabelled: string[] }
  | { ok: false; code: SaveRoleAnswersErrorCode; message: string; inUse?: AnswerInUse[] };

const roleFail = (code: SaveRoleAnswersErrorCode, message: string, inUse?: AnswerInUse[]): SaveRoleAnswersResult => ({
  ok: false,
  code,
  message,
  ...(inUse ? { inUse } : {}),
});

export interface RoleAnswerInput {
  /** An existing answer's key; absent for a new answer. */
  key?: string;
  label: string;
  retired?: boolean;
}

export interface RoleListSnapshot {
  answers: { key: string; label: string; retired?: boolean }[];
}

/** The reserved "Not recorded" choice of the contacts filter (contact-filters.ts NOT_SET). */
const RESERVED_ROLE_KEY = "__none__";

/**
 * A new answer's key: its label in capitals, letters and digits joined by "_"
 * ("Software engineer" → SOFTWARE_ENGINEER), made unique among `taken`. Made
 * once; a later relabel keeps it.
 */
export function roleKeyFor(label: string, taken: Set<string>): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "ANSWER";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}_${n}`;
    if (!taken.has(next)) return next;
  }
}

function sameRoleList(field: PersonFieldConfig, expected: RoleListSnapshot): boolean {
  if (field.options.length !== expected.answers.length) return false;
  return field.options.every((o, i) => {
    const e = expected.answers[i];
    return o.key === e.key && o.label === e.label && o.retired === (e.retired === true);
  });
}

/** The next Role list, or why the input cannot become one. Pure: no database. */
export function planRoleAnswers(
  input: RoleAnswerInput[],
  current: PersonFieldOption[],
): { ok: true; next: PersonFieldOption[]; relabelled: string[] } | { ok: false; result: SaveRoleAnswersResult } {
  if (input.length > MAX_PERSON_FIELD_OPTIONS) {
    return { ok: false, result: roleFail("TOO_MANY", `At most ${MAX_PERSON_FIELD_OPTIONS} answers.`) };
  }
  const byKey = new Map(current.map((o) => [o.key, o]));
  const taken = new Set(current.map((o) => o.key));
  const seenKeys = new Set<string>();
  const next: PersonFieldOption[] = [];
  const relabelled: string[] = [];
  for (const entry of input) {
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label || label.length > MAX_PERSON_FIELD_ANSWER || CONTROL_CHARACTER.test(label) || !looseForm(label)) {
      return { ok: false, result: roleFail("INVALID_ANSWER", `An answer needs 1 to ${MAX_PERSON_FIELD_ANSWER} characters, with a letter or a digit.`) };
    }
    let key: string;
    if (entry.key !== undefined) {
      const existing = byKey.get(entry.key);
      if (!existing) return { ok: false, result: roleFail("UNKNOWN_KEY", "An answer in this save is not on the list. Reload and try again.") };
      key = existing.key;
      if (existing.label !== label) relabelled.push(key);
    } else {
      key = roleKeyFor(label, taken);
      taken.add(key);
    }
    if (seenKeys.has(key)) return { ok: false, result: roleFail("DUPLICATE_ANSWER", `"${label}" is in the list twice.`) };
    seenKeys.add(key);
    next.push({ key, label, retired: entry.retired === true });
  }
  // Two answers that read the same, by key or label, once case, accents and punctuation are ignored.
  const owner = new Map<string, string>();
  for (const o of next) {
    for (const form of new Set([looseForm(o.key), looseForm(o.label)])) {
      const other = owner.get(form);
      if (other !== undefined && other !== o.key) {
        const a = next.find((x) => x.key === other)?.label ?? other;
        return { ok: false, result: roleFail("DUPLICATE_ANSWER", `"${o.label}" and "${a}" read the same. Give one a different name.`) };
      }
      owner.set(form, o.key);
    }
    if (o.key === RESERVED_ROLE_KEY) return { ok: false, result: roleFail("INVALID_ANSWER", "That answer name is reserved.") };
  }
  if (next.every((o) => o.retired)) {
    return { ok: false, result: roleFail("NOTHING_OFFERED", "Offer at least one answer: the forms ask for a role, and an empty picker cannot be answered.") };
  }
  return { ok: true, next, relabelled };
}

/**
 * How many records in this organisation hold each of these Role keys: its
 * contacts, and the attendees and speakers of its events. Records, not people.
 * An account's own profile is not counted (it has no organisation); a removed
 * key held only there still displays, as its key.
 */
export async function countRoleUse(tx: Tx | typeof db, organizationId: string, keys: string[]): Promise<Map<string, number>> {
  const use = new Map<string, number>();
  if (keys.length === 0) return use;
  const add = (rows: { role: string | null; _count: { _all: number } }[]) => {
    for (const row of rows) {
      if (row.role) use.set(row.role, (use.get(row.role) ?? 0) + row._count._all);
    }
  };
  const [contacts, attendees, speakers] = await Promise.all([
    tx.contact.groupBy({ by: ["role"], where: { organizationId, role: { in: keys } }, _count: { _all: true } }),
    tx.attendee.groupBy({ by: ["role"], where: { role: { in: keys }, registrations: { some: { event: { organizationId } } } }, _count: { _all: true } }),
    tx.speaker.groupBy({ by: ["role"], where: { role: { in: keys }, event: { organizationId } }, _count: { _all: true } }),
  ]);
  add(contacts);
  add(attendees);
  add(speakers);
  return use;
}

type RoleSaveOutcome =
  | { saved: false; result: SaveRoleAnswersResult }
  | { saved: true; before: PersonFieldConfig; after: PersonFieldConfig; removed: string[]; relabelled: string[]; contactsResent: number };

export async function saveRoleAnswers(input: {
  organizationId: string;
  actorUserId: string;
  answers: RoleAnswerInput[];
  /** The list this edit started from, as the screen loaded it. */
  expected: RoleListSnapshot;
}): Promise<SaveRoleAnswersResult> {
  try {
    // Read, plan, in-use check, write and the contacts' re-send mark in ONE
    // transaction holding the organisation row lock (as the Specialty save).
    const outcome = await tenantTransaction(async (tx): Promise<RoleSaveOutcome> => {
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false, result: roleFail("ORGANIZATION_NOT_FOUND", "Organisation not found") };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const before = readPersonFields(settings).role;
      if (!sameRoleList(before, input.expected)) {
        return { saved: false, result: roleFail("LIST_CHANGED", "Someone else changed this list after you opened it. It has been reloaded: make your change again.") };
      }
      const plan = planRoleAnswers(input.answers, before.options);
      if (!plan.ok) return { saved: false, result: plan.result };

      const kept = new Set(plan.next.map((o) => o.key));
      const removed = before.options.map((o) => o.key).filter((key) => !kept.has(key));
      const use = await countRoleUse(tx, input.organizationId, removed);
      const inUse = removed.flatMap((key) => {
        const records = use.get(key) ?? 0;
        const label = before.options.find((o) => o.key === key)?.label ?? key;
        return records > 0 ? [{ answer: label, records }] : [];
      });
      if (inUse.length > 0) {
        const names = inUse.map((a) => `${a.answer} (${a.records})`).join(", ");
        return { saved: false, result: roleFail("ANSWER_IN_USE", `These answers are held by records, so they can be retired and not removed: ${names}.`, inUse) };
      }

      // The label, the switches and Others are kept: this save is the answers.
      const after: PersonFieldConfig = { enabled: before.enabled, required: before.required, label: before.label, options: plan.next, allowOther: false };
      const saved = (settings[PERSON_FIELDS_SETTING] && typeof settings[PERSON_FIELDS_SETTING] === "object" ? settings[PERSON_FIELDS_SETTING] : {}) as Record<string, unknown>;
      await tx.organization.update({
        where: { id: input.organizationId },
        data: { settings: { ...settings, [PERSON_FIELDS_SETTING]: { ...saved, role: after } } as unknown as Prisma.InputJsonValue },
      });
      // A relabel: the contacts holding the answer are marked updated, so the
      // contacts feed re-sends them with the new label on its next run.
      const resent = plan.relabelled.length
        ? await tx.contact.updateMany({ where: { organizationId: input.organizationId, role: { in: plan.relabelled } }, data: { updatedAt: new Date() } })
        : { count: 0 };
      return { saved: true, before, after, removed, relabelled: plan.relabelled, contactsResent: resent.count };
    });

    if (!outcome.saved) return outcome.result;
    const describe = (field: PersonFieldConfig) => field.options.map((o) => `${o.key}=${o.label}${o.retired ? " (retired)" : ""}`);
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: { roleAnswers: { before: describe(outcome.before), after: describe(outcome.after), relabelled: outcome.relabelled } } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "person-fields:audit-failed"));
    apiLogger.info(
      {
        organizationId: input.organizationId,
        by: input.actorUserId,
        count: outcome.after.options.length,
        removed: outcome.removed,
        relabelled: outcome.relabelled,
        contactsResent: outcome.contactsResent,
      },
      "person-fields:role-saved",
    );
    return { ok: true, field: outcome.after, relabelled: outcome.relabelled };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "person-fields:role-save-failed");
    return roleFail("UNKNOWN", "Failed to save the role answers");
  }
}

/* ─────────────────────────────── Field names ──────────────────────────────── */

/**
 * The names of the Role and Specialty fields as every form and screen shows
 * them (step 1d of docs/ORG_FIELDS_PLAN.md), for example "Profession" for
 * Role. Title keeps its name (owner, Nov 13, 2026: Title is on or off only).
 * Only the `label` key is written: the answers and switches stay as they are,
 * and a field with no list of its own keeps following today's list. Exports
 * keep their fixed column headings (a renamed field must still read back
 * into the imports). Same lock, stale-save refusal and audit as the other
 * saves here.
 */
export const RENAMEABLE_PERSON_FIELDS = ["role", "specialty"] as const;
export type RenameablePersonField = (typeof RENAMEABLE_PERSON_FIELDS)[number];
export type PersonFieldLabels = Record<RenameablePersonField, string>;

export type SaveFieldLabelsResult =
  | { ok: true; labels: PersonFieldLabels }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" | "INVALID_LABEL" | "LABELS_CHANGED" | "UNKNOWN"; message: string };

export function labelsOf(config: PersonFieldsConfig): PersonFieldLabels {
  return { role: config.role.label, specialty: config.specialty.label };
}

export async function saveFieldLabels(input: {
  organizationId: string;
  actorUserId: string;
  labels: PersonFieldLabels;
  /** The names as the screen loaded them. */
  expected: PersonFieldLabels;
}): Promise<SaveFieldLabelsResult> {
  const next = {} as PersonFieldLabels;
  for (const field of RENAMEABLE_PERSON_FIELDS) {
    const label = typeof input.labels[field] === "string" ? input.labels[field].trim() : "";
    if (!label || label.length > MAX_PERSON_FIELD_LABEL || CONTROL_CHARACTER.test(label) || !looseForm(label)) {
      return { ok: false, code: "INVALID_LABEL", message: `A field's name needs 1 to ${MAX_PERSON_FIELD_LABEL} characters, with a letter or a digit.` };
    }
    next[field] = label;
  }
  if (looseForm(next.role) === looseForm(next.specialty)) {
    return { ok: false, code: "INVALID_LABEL", message: "The two fields cannot have the same name." };
  }
  try {
    const outcome = await tenantTransaction(async (tx) => {
      const rows = await tx.$queryRaw<{ settings: Prisma.JsonValue | null }[]>`SELECT "settings" FROM "Organization" WHERE "id" = ${input.organizationId} FOR UPDATE`;
      if (rows.length === 0) return { saved: false as const, code: "ORGANIZATION_NOT_FOUND" as const };
      const settings = (rows[0].settings ?? {}) as Record<string, unknown>;
      const before = labelsOf(readPersonFields(settings));
      if (before.role !== input.expected.role || before.specialty !== input.expected.specialty) return { saved: false as const, code: "LABELS_CHANGED" as const };
      const saved = (isPlainObject(settings[PERSON_FIELDS_SETTING]) ? settings[PERSON_FIELDS_SETTING] : {}) as Record<string, unknown>;
      const written = Object.fromEntries(
        RENAMEABLE_PERSON_FIELDS.map((f) => [f, { ...(isPlainObject(saved[f]) ? saved[f] : {}), label: next[f] }]),
      );
      await tx.organization.update({
        where: { id: input.organizationId },
        data: { settings: { ...settings, [PERSON_FIELDS_SETTING]: { ...saved, ...written } } as unknown as Prisma.InputJsonValue },
      });
      return { saved: true as const, before };
    });
    if (!outcome.saved) {
      return outcome.code === "ORGANIZATION_NOT_FOUND"
        ? { ok: false, code: "ORGANIZATION_NOT_FOUND", message: "Organisation not found" }
        : { ok: false, code: "LABELS_CHANGED", message: "Someone else renamed these fields after you opened them. They have been reloaded: make your change again." };
    }
    db.auditLog
      .create({
        data: {
          userId: input.actorUserId,
          action: "UPDATE",
          entityType: "Organization",
          entityId: input.organizationId,
          changes: { personFieldLabels: { before: outcome.before, after: next } } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) => apiLogger.warn({ err, organizationId: input.organizationId }, "person-fields:audit-failed"));
    apiLogger.info({ organizationId: input.organizationId, by: input.actorUserId, labels: next }, "person-fields:labels-saved");
    return { ok: true, labels: next };
  } catch (err) {
    apiLogger.error({ err, organizationId: input.organizationId }, "person-fields:labels-save-failed");
    return { ok: false, code: "UNKNOWN", message: "Failed to save the field names" };
  }
}
