/**
 * The organisation's own Role answers (step 1d of docs/ORG_FIELDS_PLAN.md):
 * the pure planning of a save. A key is made once from a label and never
 * changes; a relabel is reported (it re-sends contacts to the contacts feed);
 * answers that read the same are refused; something must be offered.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { planRoleAnswers, roleKeyFor } from "@/services/person-field-service";
import { defaultPersonFields } from "@/lib/person-fields";

const NINE = defaultPersonFields().role.options;
const asInput = NINE.map((o) => ({ key: o.key, label: o.label, retired: o.retired }));

describe("roleKeyFor", () => {
  it("makes a key from the label once, unique among the taken keys", () => {
    expect(roleKeyFor("Software engineer", new Set())).toBe("SOFTWARE_ENGINEER");
    expect(roleKeyFor("Médecin généraliste", new Set())).toBe("MEDECIN_GENERALISTE");
    expect(roleKeyFor("Nurse", new Set(["NURSE"]))).toBe("NURSE_2");
    expect(roleKeyFor("!!!", new Set())).toBe("ANSWER");
  });
});

describe("planRoleAnswers", () => {
  it("keeps today's nine unchanged: nothing relabelled", () => {
    const plan = planRoleAnswers(asInput, NINE);
    expect(plan.ok && plan.next).toEqual(NINE);
    expect(plan.ok && plan.relabelled).toEqual([]);
  });

  it("adds an answer with a new key and keeps every existing key", () => {
    const plan = planRoleAnswers([...asInput, { label: "Nurse" }], NINE);
    expect(plan.ok && plan.next.at(-1)).toEqual({ key: "NURSE", label: "Nurse", retired: false });
    expect(plan.ok && plan.next.slice(0, 9).map((o) => o.key)).toEqual(NINE.map((o) => o.key));
  });

  it("relabels an answer under the same key, and reports it", () => {
    const input = asInput.map((a) => (a.key === "PHYSICIAN" ? { ...a, label: "Doctor" } : a));
    const plan = planRoleAnswers(input, NINE);
    expect(plan.ok && plan.next.find((o) => o.key === "PHYSICIAN")?.label).toBe("Doctor");
    expect(plan.ok && plan.relabelled).toEqual(["PHYSICIAN"]);
  });

  it("refuses a key the list does not have (an old screen, or a made-up key)", () => {
    const plan = planRoleAnswers([...asInput, { key: "ASTRONAUT", label: "Astronaut" }], NINE);
    expect(!plan.ok && plan.result).toMatchObject({ code: "UNKNOWN_KEY" });
  });

  it("refuses two answers that read the same, by label or by another's key", () => {
    const twin = planRoleAnswers([...asInput, { label: "physician" }], NINE);
    expect(!twin.ok && twin.result).toMatchObject({ code: "DUPLICATE_ANSWER" });
    const keyLike = planRoleAnswers([...asInput, { label: "Allied-health" }], NINE);
    expect(!keyLike.ok && keyLike.result).toMatchObject({ code: "DUPLICATE_ANSWER" });
  });

  it("refuses a blank or punctuation-only answer, and a list that offers nothing", () => {
    expect(planRoleAnswers([...asInput, { label: "  " }], NINE)).toMatchObject({ ok: false });
    expect(planRoleAnswers([...asInput, { label: "---" }], NINE)).toMatchObject({ ok: false });
    const allRetired = planRoleAnswers(asInput.map((a) => ({ ...a, retired: true })), NINE);
    expect(!allRetired.ok && allRetired.result).toMatchObject({ code: "NOTHING_OFFERED" });
  });

  it("retires an answer without touching its key", () => {
    const input = asInput.map((a) => (a.key === "SPEAKER" ? { ...a, retired: true } : a));
    const plan = planRoleAnswers(input, NINE);
    expect(plan.ok && plan.next.find((o) => o.key === "SPEAKER")).toEqual({ key: "SPEAKER", label: "Speaker", retired: true });
  });
});
