import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

const { mockDb } = vi.hoisted(() => ({ mockDb: { organization: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { personFieldProblems, withPersonFieldRules } from "@/lib/person-field-check";
import { loadPersonFieldRules, personFieldRefusal } from "@/lib/person-field-rules";
import { DEFAULT_PERSON_FIELD_RULES, PERSON_FIELDS_SETTING, personFieldRules, type PersonFieldRules } from "@/lib/person-fields";

/**
 * Step 2 of docs/ORG_FIELDS_PLAN.md: ONE check of Title, Role and Specialty,
 * asked by every server door and every form. With nothing saved it demands
 * exactly what the eight routes each demanded by themselves before.
 */

const on = { enabled: true, required: true };
const optional = { enabled: true, required: false };
const off = { enabled: false, required: true };
const rules = (over: Partial<Record<"title" | "role" | "specialty", { enabled: boolean; required: boolean }>>): PersonFieldRules =>
  personFieldRules({ title: on, role: on, specialty: on, ...over });
const paths = (values: Record<string, unknown>, r: PersonFieldRules, opts = {}) => personFieldProblems(values, r, opts).map((p) => p.path);

describe("personFieldProblems", () => {
  it("today's rules: Role and Specialty are demanded, with the messages the routes gave", () => {
    expect(personFieldProblems({}, DEFAULT_PERSON_FIELD_RULES)).toEqual([
      { path: "role", message: "Role is required" },
      { path: "specialty", message: "Specialty is required" },
    ]);
    expect(paths({ role: "PHYSICIAN", specialty: "Cardiology" }, DEFAULT_PERSON_FIELD_RULES)).toEqual([]);
    expect(paths({ role: "  ", specialty: "" }, DEFAULT_PERSON_FIELD_RULES)).toEqual(["role", "specialty"]);
  });

  it("Others needs the typed specialty beside it", () => {
    expect(personFieldProblems({ role: "PHYSICIAN", specialty: "Others" }, DEFAULT_PERSON_FIELD_RULES)).toEqual([
      { path: "customSpecialty", message: "Please specify your specialty" },
    ]);
    expect(paths({ role: "PHYSICIAN", specialty: "Others", customSpecialty: "Sleep medicine" }, DEFAULT_PERSON_FIELD_RULES)).toEqual([]);
  });

  it("an optional field is not demanded, and Others still needs its text while Specialty is asked", () => {
    const r = rules({ role: optional, specialty: optional });
    expect(paths({}, r)).toEqual([]);
    expect(paths({ specialty: "Others" }, r)).toEqual(["customSpecialty"]);
  });

  it("a field that is switched off demands nothing, not even the text beside Others", () => {
    const r = rules({ role: off, specialty: off });
    expect(paths({}, r)).toEqual([]);
    expect(paths({ specialty: "Others" }, r)).toEqual([]);
  });

  it("Title is demanded only where the door says so (the desk), and only while the organisation demands it", () => {
    expect(paths({ role: "PHYSICIAN", specialty: "Cardiology" }, DEFAULT_PERSON_FIELD_RULES)).toEqual([]);
    expect(paths({ role: "PHYSICIAN", specialty: "Cardiology" }, DEFAULT_PERSON_FIELD_RULES, { demandTitle: true })).toEqual(["title"]);
    expect(paths({ role: "PHYSICIAN", specialty: "Cardiology" }, rules({ title: optional }), { demandTitle: true })).toEqual([]);
    expect(paths({ role: "PHYSICIAN", specialty: "Cardiology" }, rules({ title: off }), { demandTitle: true })).toEqual([]);
  });
});

describe("withPersonFieldRules: a schema with its organisation's demands", () => {
  const base = z.object({ role: z.string().optional(), specialty: z.string().optional(), customSpecialty: z.string().optional() });

  it("the refusals come back as the schema's own field errors", () => {
    const parsed = withPersonFieldRules(base, DEFAULT_PERSON_FIELD_RULES).safeParse({ specialty: "Others" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.flatten().fieldErrors).toEqual({ role: ["Role is required"], customSpecialty: ["Please specify your specialty"] });
  });

  it("the same input passes for an organisation that switched both off", () => {
    expect(withPersonFieldRules(base, rules({ role: off, specialty: off })).safeParse({}).success).toBe(true);
  });
});

describe("loadPersonFieldRules and personFieldRefusal (the server's read)", () => {
  it("with nothing saved, or no organisation, today's rules", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    expect(await loadPersonFieldRules("org1")).toEqual(DEFAULT_PERSON_FIELD_RULES);
    expect(await loadPersonFieldRules(null)).toEqual(DEFAULT_PERSON_FIELD_RULES);
  });

  it("reads the organisation's switches", async () => {
    mockDb.organization.findUnique.mockResolvedValue({
      settings: { [PERSON_FIELDS_SETTING]: { specialty: { enabled: false, label: "Specialty", options: [], allowOther: true } } },
    });
    expect((await loadPersonFieldRules("org1")).specialty).toEqual({ shown: false, required: false });
    expect(await personFieldRefusal("org1", { role: "PHYSICIAN" })).toBeNull();
  });

  it("a refusal has the shape of a schema's field errors", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    expect(await personFieldRefusal("org1", { role: "PHYSICIAN" })).toEqual({ formErrors: [], fieldErrors: { specialty: ["Specialty is required"] } });
  });

  it("when the read fails, demands what was always demanded, and says so in the log", async () => {
    mockDb.organization.findUnique.mockRejectedValue(new Error("db down"));
    expect(await loadPersonFieldRules("org1")).toEqual(DEFAULT_PERSON_FIELD_RULES);
    const { apiLogger } = await import("@/lib/logger");
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "person-field-rules:read-failed", organizationId: "org1" }));
  });
});
