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

import { planSpecialtyAnswers, saveSpecialtyAnswers } from "@/services/person-field-service";
import { defaultPersonFields, PERSON_FIELDS_SETTING } from "@/lib/person-fields";

const BASE = { organizationId: "org1", actorUserId: "u1", allowOther: true };
const DEFAULT_COUNT = defaultPersonFields().specialty.options.length;
const asInput = (answers: string[]) => answers.map((answer) => ({ answer }));
const defaults = () => defaultPersonFields().specialty.options.map((o) => ({ answer: o.key }));
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
    ["an answer that is too long", asInput(["x".repeat(101)]), "INVALID_ANSWER"],
    ["Others, in any case: it is a switch, not an answer", asInput(["OTHERS"]), "RESERVED_ANSWER"],
    ["the same answer twice, whatever its case", asInput(["Cardiology", "cardiology"]), "DUPLICATE_ANSWER"],
    ["more than 200", asInput(Array.from({ length: 201 }, (_, i) => `A${i}`)), "TOO_MANY"],
  ])("refuses %s", (_name, input, code) => {
    const plan = planSpecialtyAnswers(input);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.result).toMatchObject({ ok: false, code });
  });

  it("an empty list is allowed: an organisation may offer free text only", () => {
    expect(planSpecialtyAnswers([])).toEqual({ ok: true, next: [] });
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
    const result = await saveSpecialtyAnswers({ ...BASE, allowOther: false, answers: asInput(["Cloud", "Data"]) });
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
    expect(result).toMatchObject({ ok: false, code: "ANSWER_IN_USE", inUse: [{ answer: "Cardiology", people: 3788 }] });
    expect(tx.organization.update).not.toHaveBeenCalled();
    // Only the removed answers are counted, and only inside this organisation.
    const where = tx.contact.groupBy.mock.calls[0][0].where;
    expect(where).toEqual({ organizationId: "org1", specialty: { in: ["Cardiology"] } });
    expect(tx.speaker.groupBy.mock.calls[0][0].where).toEqual({ specialty: { in: ["Cardiology"] }, event: { organizationId: "org1" } });
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
