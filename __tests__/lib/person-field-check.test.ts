import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

const { mockDb } = vi.hoisted(() => ({ mockDb: { organization: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { askedOnly, blankUnaskedFields, personFieldProblems, withPersonFieldRules } from "@/lib/person-field-check";
import { personalDetailsFields, presenterDetailsSchema } from "@/lib/schemas";
import { checkEventPersonFields, loadEventPersonFieldRules, loadOrganizationPersonFieldRules, personFieldRefusal } from "@/lib/person-field-rules";
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

  // Review of f0899baf. Zod skips an object's refinements while any field has
  // an error, so with one refinement the three messages appeared only on the
  // second press, once the terms box was ticked and every other field was
  // valid. The forms' schemas all have such fields (terms, a second email).
  it("says what is missing on the FIRST press, whatever else on the form is wrong", () => {
    const form = base.extend({ agreeTerms: z.literal(true), additionalEmail: z.string().email().optional() });
    const parsed = withPersonFieldRules(form, DEFAULT_PERSON_FIELD_RULES).safeParse({ specialty: "Others", additionalEmail: "nope" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const errors = parsed.error.flatten().fieldErrors as Record<string, string[]>;
      expect(errors.role).toEqual(["Role is required"]);
      expect(errors.customSpecialty).toEqual(["Please specify your specialty"]);
      expect(Object.keys(errors).sort()).toEqual(["additionalEmail", "agreeTerms", "customSpecialty", "role"]);
    }
  });

  it("a field with an error of its own keeps that one and gets no second message", () => {
    const strict = base.extend({ role: z.enum(["PHYSICIAN"]).optional() });
    const parsed = withPersonFieldRules(strict, DEFAULT_PERSON_FIELD_RULES).safeParse({ role: "SUPERHERO", specialty: "Cardiology" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const errors = parsed.error.flatten().fieldErrors as Record<string, string[]>;
      expect(errors.role).toHaveLength(1);
      expect(errors.role[0]).not.toBe("Role is required");
    }
  });

  it("a later refinement of the caller's still runs once the rules are met", () => {
    const withOwn = withPersonFieldRules(base, DEFAULT_PERSON_FIELD_RULES).refine((d) => d.specialty !== "Banned", { path: ["specialty"], message: "own rule" });
    const parsed = withOwn.safeParse({ role: "PHYSICIAN", specialty: "Banned" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.flatten().fieldErrors).toEqual({ specialty: ["own rule"] });
  });

  it("something that is not an object is refused by the schema itself, without a throw", () => {
    expect(withPersonFieldRules(base, DEFAULT_PERSON_FIELD_RULES).safeParse(null).success).toBe(false);
  });
});

describe("blankUnaskedFields: what a form that creates a record sends", () => {
  const filled = { title: "DR", role: "PHYSICIAN", specialty: "Others", customSpecialty: "Sleep medicine", firstName: "A" };

  it("with everything asked, exactly what the form holds", () => {
    expect(blankUnaskedFields(filled, DEFAULT_PERSON_FIELD_RULES)).toEqual(filled);
  });

  it("a switched-off field goes blank, with the typed specialty when Specialty is off; nothing else changes", () => {
    expect(blankUnaskedFields(filled, rules({ specialty: off }))).toEqual({ ...filled, specialty: "", customSpecialty: "" });
    expect(blankUnaskedFields(filled, rules({ title: off, role: off }))).toEqual({ ...filled, title: "", role: "" });
  });

  it("an optional field is still asked, so what the person answered is sent", () => {
    expect(blankUnaskedFields(filled, rules({ title: optional, role: optional, specialty: optional }))).toEqual(filled);
  });
});

// Review of f0899baf: the shared schemas the doors build on.
describe("the lenient fields the doors' schemas take", () => {
  const details = {
    firstName: "A", lastName: "B", organization: "Org", jobTitle: "Lead", phone: "1", city: "Dubai", country: "UAE",
  };

  it("a request with NO title key is taken: what a form sends once Title is switched off", () => {
    expect(presenterDetailsSchema.safeParse(details).success).toBe(true);
    expect(z.object(personalDetailsFields).safeParse(details).success).toBe(true);
    // A title that is not one of the five is still refused.
    expect(presenterDetailsSchema.safeParse({ ...details, title: "SIR" }).success).toBe(false);
  });

  it("a blank specialty is no answer: never stored as an empty text", () => {
    for (const specialty of ["", "   "]) {
      const parsed = presenterDetailsSchema.safeParse({ ...details, specialty });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.specialty).toBeUndefined();
    }
    const kept = presenterDetailsSchema.safeParse({ ...details, specialty: "Cardiology" });
    expect(kept.success && kept.data.specialty).toBe("Cardiology");
  });

  it("and a blank one is still refused where the organisation demands Specialty", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    const parsed = presenterDetailsSchema.safeParse({ ...details, role: "PHYSICIAN", specialty: " " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(await personFieldRefusal({ organizationId: "org1", settings: {} }, parsed.data)).toEqual({ formErrors: [], fieldErrors: { specialty: ["Specialty is required"] } });
  });
});

describe("the server's read: an event's rules, and an organisation's where there is no event", () => {
  const event = (settings: unknown = {}) => ({ organizationId: "org1", settings });
  const orgSaved = (personFields: unknown) => mockDb.organization.findUnique.mockResolvedValue({ settings: { [PERSON_FIELDS_SETTING]: personFields } });

  it("with nothing saved, or no organisation, today's rules", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    expect(await loadOrganizationPersonFieldRules("org1")).toEqual(DEFAULT_PERSON_FIELD_RULES);
    expect(await loadOrganizationPersonFieldRules(null)).toEqual(DEFAULT_PERSON_FIELD_RULES);
    expect(await loadEventPersonFieldRules(event())).toEqual(DEFAULT_PERSON_FIELD_RULES);
    expect(await loadEventPersonFieldRules({ organizationId: null, settings: {} })).toEqual(DEFAULT_PERSON_FIELD_RULES);
  });

  it("reads the organisation's switches", async () => {
    orgSaved({ specialty: { enabled: false, label: "Specialty", options: [], allowOther: true } });
    expect((await loadOrganizationPersonFieldRules("org1")).specialty).toEqual({ shown: false, required: false });
    expect(await personFieldRefusal(event(), { role: "PHYSICIAN" })).toBeNull();
  });

  // Step 2, the event part (owner, Nov 13, 2026: the organisation is the ceiling).
  it("an event's own choice is laid over its organisation's: not asked, optional, required", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    const rules = await loadEventPersonFieldRules(event({ personFieldChoices: { title: "off", role: "optional", specialty: "off" } }));
    expect(rules).toEqual({ title: { shown: false, required: false }, role: { shown: true, required: false }, specialty: { shown: false, required: false } });
    // The same request the organisation's own rules refuse is taken on this event.
    expect(await personFieldRefusal(event({ personFieldChoices: { role: "optional", specialty: "off" } }), {})).toBeNull();
    expect(await personFieldRefusal(event(), {})).not.toBeNull();
  });

  it("an event may demand a field its organisation left optional", async () => {
    orgSaved({ role: { enabled: true, required: false } });
    expect(await personFieldRefusal(event(), { specialty: "Cardiology" })).toBeNull();
    expect(await personFieldRefusal(event({ personFieldChoices: { role: "required" } }), { specialty: "Cardiology" })).toEqual({
      formErrors: [],
      fieldErrors: { role: ["Role is required"] },
    });
  });

  it("THE CEILING: a field the organisation switched off is off on every event, whatever the event saved", async () => {
    orgSaved({ specialty: { enabled: false }, title: { enabled: false } });
    const rules = await loadEventPersonFieldRules(event({ personFieldChoices: { specialty: "required", title: "required" } }));
    expect(rules.specialty).toEqual({ shown: false, required: false });
    expect(rules.title).toEqual({ shown: false, required: false });
  });

  it("Title is on or off only: an event cannot make it optional or required", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    for (const choice of ["optional", "required", "nonsense"]) {
      expect((await loadEventPersonFieldRules(event({ personFieldChoices: { title: choice } }))).title).toEqual(DEFAULT_PERSON_FIELD_RULES.title);
    }
  });

  it("a choice that is not one of the three, or a setting of the wrong shape, is no choice", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    for (const settings of [{ personFieldChoices: { role: "OFF", specialty: true } }, { personFieldChoices: "off" }, { personFieldChoices: null }, null, "x"]) {
      expect(await loadEventPersonFieldRules(event(settings))).toEqual(DEFAULT_PERSON_FIELD_RULES);
    }
  });

  it("the check hands back the rules it used, so a door can drop what was not asked", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    const check = await checkEventPersonFields(event({ personFieldChoices: { specialty: "off" } }), { role: "PHYSICIAN", specialty: "Cardiology", customSpecialty: "x" });
    expect(check.refusal).toBeNull();
    expect(askedOnly({ title: "DR", role: "PHYSICIAN", specialty: "Cardiology", customSpecialty: "x" }, check.rules)).toEqual({
      title: "DR", role: "PHYSICIAN", specialty: undefined, customSpecialty: undefined,
    });
  });

  it("a refusal has the shape of a schema's field errors", async () => {
    mockDb.organization.findUnique.mockResolvedValue({ settings: {} });
    expect(await personFieldRefusal(event(), { role: "PHYSICIAN" })).toEqual({ formErrors: [], fieldErrors: { specialty: ["Specialty is required"] } });
  });

  it("when the read fails, demands what was always demanded, and says so in the log", async () => {
    mockDb.organization.findUnique.mockRejectedValue(new Error("db down"));
    expect(await loadOrganizationPersonFieldRules("org1")).toEqual(DEFAULT_PERSON_FIELD_RULES);
    // The event's own choice is already in hand, so it still applies, over
    // today's rules: the route must not demand a field this event's form hides
    // (review of 5dd9cd5f).
    expect(await loadEventPersonFieldRules(event({ personFieldChoices: { specialty: "off", role: "optional" } }))).toEqual({
      ...DEFAULT_PERSON_FIELD_RULES,
      role: { shown: true, required: false },
      specialty: { shown: false, required: false },
    });
    expect(await loadEventPersonFieldRules(event())).toEqual(DEFAULT_PERSON_FIELD_RULES);
    const { apiLogger } = await import("@/lib/logger");
    expect(apiLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "person-field-rules:read-failed", organizationId: "org1" }));
  });
});

describe("askedOnly: what a door that creates a record keeps", () => {
  const sent = { title: "DR", role: "PHYSICIAN", specialty: "Others", customSpecialty: "Sleep medicine" };

  it("with everything asked, everything", () => {
    expect(askedOnly(sent, DEFAULT_PERSON_FIELD_RULES)).toEqual(sent);
    expect(askedOnly(sent, rules({ title: optional, role: optional, specialty: optional }))).toEqual(sent);
  });

  it("a field that is not asked is not kept, and the typed specialty goes with Specialty", () => {
    expect(askedOnly(sent, rules({ specialty: off }))).toEqual({ title: "DR", role: "PHYSICIAN", specialty: undefined, customSpecialty: undefined });
    expect(askedOnly(sent, rules({ title: off, role: off }))).toEqual({ title: undefined, role: undefined, specialty: "Others", customSpecialty: "Sleep medicine" });
  });
});
