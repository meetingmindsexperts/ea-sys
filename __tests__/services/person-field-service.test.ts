/**
 * The organisation's own Specialty answers (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). The rules live in the service, not on the screen:
 * an answer people hold is retired and never removed, "Others" is a switch and
 * not an answer, and a save touches nothing but the Specialty answers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    organization: { update: vi.fn() },
    contact: { groupBy: vi.fn() },
    attendee: { groupBy: vi.fn() },
    speaker: { groupBy: vi.fn() },
    event: { groupBy: vi.fn() },
  };
  return { tx, mockDb: { $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)), auditLog: { create: vi.fn() } } };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (cb: (t: unknown) => unknown) => mockDb.$transaction(cb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { planSpecialtyAnswers, savePersonFieldSwitches, saveSpecialtyAnswers, switchesOf } from "@/services/person-field-service";
import { defaultPersonFields, PERSON_FIELDS_SETTING, readPersonFields } from "@/lib/person-fields";

const DEFAULT_COUNT = defaultPersonFields().specialty.options.length;
const asInput = (answers: string[]) => answers.map((answer) => ({ answer }));
const defaults = () => defaultPersonFields().specialty.options.map((o) => ({ answer: o.key }));
// The list the screen loaded and the edit started from: with nothing saved, today's list.
const BASE = { organizationId: "org1", actorUserId: "u1", allowOther: true, expected: { answers: defaults(), allowOther: true } };
const use = (rows: Record<string, number>) => Object.entries(rows).map(([specialty, n]) => ({ specialty, _count: { _all: n } }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
  tx.$queryRaw.mockResolvedValue([{ settings: { zoom: { enabled: true } } }]);
  tx.organization.update.mockResolvedValue({});
  for (const table of [tx.contact, tx.attendee, tx.speaker, tx.event]) table.groupBy.mockResolvedValue([]);
});

describe("planSpecialtyAnswers", () => {
  it("trims, keeps the order, and stores the text itself as the key", () => {
    const plan = planSpecialtyAnswers([{ answer: "  Sleep Medicine " }, { answer: "Cardiology", retired: true }]);
    expect(plan).toEqual({
      ok: true,
      next: [{ key: "Sleep Medicine", label: "Sleep Medicine", retired: false }, { key: "Cardiology", label: "Cardiology", retired: true }],
    });
  });

  it.each([
    ["a blank answer", asInput(["Cardiology", "  "]), "INVALID_ANSWER"],
    ["a tab or a line break inside an answer", asInput(["Sleep\tMedicine"]), "INVALID_ANSWER"],
    ["a NUL, which the database would refuse for the whole setting", asInput(["Sleep\u0000"]), "INVALID_ANSWER"],
    ["an answer that is too long", asInput(["x".repeat(101)]), "INVALID_ANSWER"],
    ["Others, in any case: it is a switch, not an answer", asInput(["OTHERS"]), "RESERVED_ANSWER"],
    ["the same answer twice, whatever its case", asInput(["Cardiology", "cardiology"]), "DUPLICATE_ANSWER"],
    ["more than 200", asInput(Array.from({ length: 201 }, (_, i) => `A${i}`)), "TOO_MANY"],
  ])("refuses %s", (_name, input, code) => {
    const plan = planSpecialtyAnswers(input);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.result).toMatchObject({ ok: false, code });
  });

  it("an empty list is allowed while Others is offered: an organisation may take free text only", () => {
    expect(planSpecialtyAnswers([], true)).toEqual({ ok: true, next: [] });
  });

  it("refuses a list that would offer nothing: every answer retired, or none, with Others off", () => {
    // The forms require a specialty, so an empty picker makes every one of them unsubmittable.
    for (const input of [[], [{ answer: "Cardiology", retired: true }]]) {
      const plan = planSpecialtyAnswers(input, false);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.result).toMatchObject({ code: "NOTHING_OFFERED" });
    }
    expect(planSpecialtyAnswers([{ answer: "Cardiology" }], false).ok).toBe(true);
  });
});

describe("saveSpecialtyAnswers", () => {
  it("the first save writes the whole list and leaves every other setting as it was", async () => {
    const result = await saveSpecialtyAnswers({ ...BASE, answers: [...defaults(), { answer: "Sleep Medicine" }] });
    expect(result.ok).toBe(true);
    const written = tx.organization.update.mock.calls[0][0].data.settings;
    expect(written.zoom).toEqual({ enabled: true });
    const specialty = written[PERSON_FIELDS_SETTING].specialty;
    expect(specialty.options).toHaveLength(DEFAULT_COUNT + 1);
    expect(specialty.options.at(-1)).toEqual({ key: "Sleep Medicine", label: "Sleep Medicine", retired: false });
    // The label and the on/off switch are not this save's to change.
    expect(specialty).toMatchObject({ enabled: true, label: "Specialty", allowOther: true });
  });

  it("keeps what is saved for Title and Role, and the Specialty label and switch", async () => {
    const role = { label: "What you do", options: [{ key: "DEV", label: "Developer" }] };
    tx.$queryRaw.mockResolvedValue([{ settings: { [PERSON_FIELDS_SETTING]: { role, specialty: { enabled: false, label: "Area", options: [{ key: "Cloud", label: "Cloud" }], allowOther: false } } } }]);
    const result = await saveSpecialtyAnswers({ ...BASE, allowOther: false, answers: asInput(["Cloud", "Data"]), expected: { answers: asInput(["Cloud"]), allowOther: false } });
    expect(result.ok).toBe(true);
    const saved = tx.organization.update.mock.calls[0][0].data.settings[PERSON_FIELDS_SETTING];
    expect(saved.role).toEqual(role);
    expect(saved.specialty).toMatchObject({ enabled: false, label: "Area", allowOther: false });
    expect(saved.specialty.options.map((o: { key: string }) => o.key)).toEqual(["Cloud", "Data"]);
  });

  it("refuses to remove an answer people hold, says how many, and writes nothing", async () => {
    tx.contact.groupBy.mockResolvedValue(use({ Cardiology: 3000 }));
    tx.attendee.groupBy.mockResolvedValue(use({ Cardiology: 700 }));
    tx.speaker.groupBy.mockResolvedValue(use({ Cardiology: 88 }));
    const result = await saveSpecialtyAnswers({ ...BASE, answers: defaults().filter((a) => a.answer !== "Cardiology") });
    expect(result).toMatchObject({ ok: false, code: "ANSWER_IN_USE", inUse: [{ answer: "Cardiology", records: 3788 }] });
    expect(tx.organization.update).not.toHaveBeenCalled();
    // Only the removed answers are counted, and only inside this organisation, on each of the four tables.
    const wanted = { in: ["Cardiology"] };
    expect(tx.contact.groupBy.mock.calls[0][0].where).toEqual({ organizationId: "org1", specialty: wanted });
    expect(tx.attendee.groupBy.mock.calls[0][0].where).toEqual({ specialty: wanted, registrations: { some: { event: { organizationId: "org1" } } } });
    expect(tx.speaker.groupBy.mock.calls[0][0].where).toEqual({ specialty: wanted, event: { organizationId: "org1" } });
    expect(tx.event.groupBy.mock.calls[0][0].where).toEqual({ organizationId: "org1", specialty: wanted });
  });

  it("the same answer may be retired while people hold it: nothing is counted and it stays on the list", async () => {
    tx.contact.groupBy.mockResolvedValue(use({ Cardiology: 3000 }));
    const result = await saveSpecialtyAnswers({ ...BASE, answers: defaults().map((a) => (a.answer === "Cardiology" ? { ...a, retired: true } : a)) });
    expect(result.ok).toBe(true);
    const options = tx.organization.update.mock.calls[0][0].data.settings[PERSON_FIELDS_SETTING].specialty.options;
    expect(options.find((o: { key: string }) => o.key === "Cardiology")).toMatchObject({ retired: true });
    expect(tx.contact.groupBy).not.toHaveBeenCalled();
  });

  it("an answer nobody holds can be removed", async () => {
    const result = await saveSpecialtyAnswers({ ...BASE, answers: defaults().filter((a) => a.answer !== "Thalassemia") });
    expect(result.ok).toBe(true);
    expect(tx.organization.update).toHaveBeenCalledTimes(1);
  });

  it("a save made from a list somebody else has changed since is refused, and writes nothing", async () => {
    // A colleague added "Sleep Medicine" after this screen loaded. Saving this
    // screen's whole list would silently remove it.
    const stored = [...defaultPersonFields().specialty.options, { key: "Sleep Medicine", label: "Sleep Medicine", retired: false }];
    tx.$queryRaw.mockResolvedValue([{ settings: { [PERSON_FIELDS_SETTING]: { specialty: { label: "Specialty", options: stored, allowOther: true } } } }]);
    const result = await saveSpecialtyAnswers({ ...BASE, answers: [...defaults(), { answer: "Dental Surgery" }] });
    expect(result).toMatchObject({ ok: false, code: "LIST_CHANGED" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it.each([
    ["an answer the colleague retired", (e: { answer: string; retired?: boolean }[]) => e.map((a, i) => (i === 0 ? { ...a, retired: true } : a)), true],
    ["the Others switch the colleague turned off", (e: { answer: string; retired?: boolean }[]) => e, false],
    ["a different order", (e: { answer: string; retired?: boolean }[]) => [e[1], e[0], ...e.slice(2)], true],
  ])("the comparison sees %s", async (_name, change, allowOther) => {
    const result = await saveSpecialtyAnswers({ ...BASE, answers: defaults(), expected: { answers: change(defaults()), allowOther } });
    expect(result).toMatchObject({ ok: false, code: "LIST_CHANGED" });
  });

  it("refuses a save that would offer nothing, before the organisation is locked", async () => {
    const result = await saveSpecialtyAnswers({ ...BASE, allowOther: false, answers: defaults().map((a) => ({ ...a, retired: true })) });
    expect(result).toMatchObject({ ok: false, code: "NOTHING_OFFERED" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("an invalid list is refused before the organisation is locked or read", async () => {
    const result = await saveSpecialtyAnswers({ ...BASE, answers: asInput(["Others"]) });
    expect(result).toMatchObject({ ok: false, code: "RESERVED_ANSWER" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("ORGANIZATION_NOT_FOUND when the organisation is gone", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await saveSpecialtyAnswers({ ...BASE, answers: defaults() })).toMatchObject({ ok: false, code: "ORGANIZATION_NOT_FOUND" });
  });

  it("writes who changed the list, with the list before and after", async () => {
    await saveSpecialtyAnswers({ ...BASE, answers: [...defaults().filter((a) => a.answer !== "Thalassemia"), { answer: "Sleep Medicine", retired: true }] });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ userId: "u1", action: "UPDATE", entityType: "Organization", entityId: "org1" });
    expect(audit.changes.specialtyAnswers.before).toContain("Thalassemia");
    expect(audit.changes.specialtyAnswers.after).not.toContain("Thalassemia");
    expect(audit.changes.specialtyAnswers.after).toContain("Sleep Medicine (retired)");
  });

  it("a database failure is an UNKNOWN result, never a throw", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error("boom"));
    expect(await saveSpecialtyAnswers({ ...BASE, answers: defaults() })).toMatchObject({ ok: false, code: "UNKNOWN" });
  });
});

describe("savePersonFieldSwitches (step 2: asked or not, demanded or not)", () => {
  const ON = { enabled: true, required: true };
  const ALL_ON = { title: ON, role: ON, specialty: ON };
  const NEXT = { title: { enabled: false, required: true }, role: { enabled: true, required: false }, specialty: ON };
  const base = { organizationId: "org1", actorUserId: "u1" };

  it("with nothing saved, every switch reads on", () => {
    expect(switchesOf(defaultPersonFields())).toEqual(ALL_ON);
  });

  // Review of f0899baf: this save used to write each field whole, which froze
  // today's titles, roles and 44 specialties into the organisation's settings
  // the first time anyone flipped a switch.
  it("writes ONLY the switches: an organisation with no list of its own gets none, and keeps following today's", async () => {
    const result = await savePersonFieldSwitches({ ...base, switches: NEXT, expected: ALL_ON });
    expect(result).toEqual({ ok: true, switches: NEXT });
    const written = tx.organization.update.mock.calls[0][0].data.settings;
    expect(written.zoom).toEqual({ enabled: true });
    expect(written[PERSON_FIELDS_SETTING]).toEqual({
      title: { enabled: false, required: true },
      role: { enabled: true, required: false },
      specialty: { enabled: true, required: true },
    });
    // What was stored reads back as those switches over today's lists.
    const read = readPersonFields(written);
    expect(switchesOf(read)).toEqual(NEXT);
    expect(read.specialty.options).toHaveLength(DEFAULT_COUNT);
    expect(read.role.options).toEqual(defaultPersonFields().role.options);
  });

  it("Title is on or off only: a request cannot change whether it is demanded", async () => {
    const asked = { ...ALL_ON, title: { enabled: true, required: false } };
    const result = await savePersonFieldSwitches({ ...base, switches: asked, expected: ALL_ON });
    expect(result).toEqual({ ok: true, switches: ALL_ON });
    expect(tx.organization.update.mock.calls[0][0].data.settings[PERSON_FIELDS_SETTING].title).toEqual({ enabled: true, required: true });
  });

  it("keeps an organisation's own Specialty list when only a switch changes", async () => {
    const own = { enabled: true, required: true, label: "Area", options: [{ key: "Cloud", label: "Cloud", retired: true }], allowOther: false };
    tx.$queryRaw.mockResolvedValue([{ settings: { [PERSON_FIELDS_SETTING]: { specialty: own } } }]);
    await savePersonFieldSwitches({ ...base, switches: { ...ALL_ON, specialty: { enabled: true, required: false } }, expected: ALL_ON });
    expect(tx.organization.update.mock.calls[0][0].data.settings[PERSON_FIELDS_SETTING].specialty).toEqual({ ...own, required: false });
  });

  it("switches somebody else changed since the screen loaded: refused, nothing written", async () => {
    tx.$queryRaw.mockResolvedValue([{ settings: { [PERSON_FIELDS_SETTING]: { role: { enabled: false, label: "Role", options: [{ key: "DEV", label: "Developer" }] } } } }]);
    const result = await savePersonFieldSwitches({ ...base, switches: NEXT, expected: ALL_ON });
    expect(result).toMatchObject({ ok: false, code: "SWITCHES_CHANGED" });
    expect(tx.organization.update).not.toHaveBeenCalled();
  });

  it("writes who changed them, before and after", async () => {
    await savePersonFieldSwitches({ ...base, switches: NEXT, expected: ALL_ON });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toEqual({ personFieldSwitches: { before: ALL_ON, after: NEXT } });
  });

  it("ORGANIZATION_NOT_FOUND, and a database failure is UNKNOWN, never a throw", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await savePersonFieldSwitches({ ...base, switches: NEXT, expected: ALL_ON })).toMatchObject({ ok: false, code: "ORGANIZATION_NOT_FOUND" });
    mockDb.$transaction.mockRejectedValueOnce(new Error("boom"));
    expect(await savePersonFieldSwitches({ ...base, switches: NEXT, expected: ALL_ON })).toMatchObject({ ok: false, code: "UNKNOWN" });
  });
});

describe("saving the Specialty answers keeps the switches", () => {
  it("required and enabled are not this save's to change", async () => {
    tx.$queryRaw.mockResolvedValue([{ settings: { [PERSON_FIELDS_SETTING]: { specialty: { enabled: true, required: false, label: "Specialty", options: [{ key: "Cloud", label: "Cloud" }], allowOther: true } } } }]);
    const result = await saveSpecialtyAnswers({ organizationId: "org1", actorUserId: "u1", allowOther: true, answers: [{ answer: "Cloud" }, { answer: "Data" }], expected: { answers: [{ answer: "Cloud" }], allowOther: true } });
    expect(result.ok).toBe(true);
    expect(tx.organization.update.mock.calls[0][0].data.settings[PERSON_FIELDS_SETTING].specialty).toMatchObject({ enabled: true, required: false });
  });
});
