import { describe, it, expect } from "vitest";
import {
  OTHER_ANSWER,
  PERSON_FIELDS_SETTING,
  answerLabel,
  defaultPersonFields,
  isOfferedAnswer,
  offeredAnswers,
  readPersonFields,
} from "@/lib/person-fields";
import { ATTENDEE_ROLE_LABELS, ATTENDEE_ROLE_ORDER } from "@/lib/schemas";

/**
 * Step 1a of docs/ORG_FIELDS_PLAN.md. The organisation's own Title, Role and
 * Specialty lists are read through person-fields.ts, and an organisation that
 * has saved nothing must get exactly the form it had: these lists are what
 * the pickers offered on Nov 13, 2026, written out here on purpose.
 */

const SPECIALTIES_AS_THEY_WERE = [
  "Anesthesia & Pain Medicine",
  "Cardiology",
  "Clinical Simulation",
  "Critical Care",
  "Dental",
  "Dermatology",
  "Diabetes",
  "Emergency Medicine",
  "Endocrinology",
  "Endoscopy",
  "Family Medicine",
  "Gastroenterology",
  "General Practice",
  "Genetics",
  "Health Economics",
  "Hematology",
  "Hepatology",
  "Immunology",
  "Infectious Disease",
  "Internal Medicine",
  "Laboratory",
  "Medical Education",
  "Nephrology",
  "Neurology",
  "Nursing",
  "Obstetrics & Gynecology",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Otolaryngology",
  "Parenteral Nutrition",
  "Pathology",
  "Pediatrics",
  "Pediatric Rehabilitation",
  "Pharmacy",
  "Preventative Medicine",
  "Psychiatry",
  "Public Health",
  "Radiology",
  "Rheumatology",
  "Respiratory Medicine",
  "Surgery",
  "Thalassemia",
  "Urology",
  "Others",
];

describe("nothing saved means today's form", () => {
  const fields = readPersonFields({});

  it("Specialty offers the same 45 answers in the same order, Others last", () => {
    expect(offeredAnswers(fields.specialty).map((o) => o.key)).toEqual(SPECIALTIES_AS_THEY_WERE);
    expect(offeredAnswers(fields.specialty).map((o) => o.label)).toEqual(SPECIALTIES_AS_THEY_WERE);
    expect(fields.specialty).toMatchObject({ enabled: true, label: "Specialty", allowOther: true });
  });

  it("Role offers the nine stored values with their labels, in order", () => {
    expect(offeredAnswers(fields.role).map((o) => o.key)).toEqual(ATTENDEE_ROLE_ORDER);
    expect(offeredAnswers(fields.role).map((o) => o.label)).toEqual(ATTENDEE_ROLE_ORDER.map((k) => ATTENDEE_ROLE_LABELS[k]));
    expect(fields.role).toMatchObject({ enabled: true, label: "Role", allowOther: false });
  });

  it("Title offers the five, as the picker showed them", () => {
    expect(offeredAnswers(fields.title).map((o) => [o.key, o.label])).toEqual([["DR", "Dr."], ["MR", "Mr."], ["MRS", "Mrs."], ["MS", "Ms."], ["PROF", "Prof."]]);
  });

  it("is what null, a string, an array or an unrelated setting give too", () => {
    for (const settings of [null, undefined, "x", [], { other: 1 }, { [PERSON_FIELDS_SETTING]: "x" }, { [PERSON_FIELDS_SETTING]: [] }]) {
      expect(readPersonFields(settings)).toEqual(defaultPersonFields());
    }
  });
});

describe("an organisation's own lists", () => {
  const tech = {
    [PERSON_FIELDS_SETTING]: {
      role: {
        label: "What you do",
        options: [{ key: "DEVELOPER", label: "Developer" }, { key: "DESIGNER", label: "Designer", retired: true }, { key: "FOUNDER", label: "Founder" }],
      },
      specialty: { enabled: false, label: "Area", options: [], allowOther: false },
    },
  };

  it("replace the default for the fields that were saved, and leave the others as they were", () => {
    const fields = readPersonFields(tech);
    expect(fields.role.label).toBe("What you do");
    expect(offeredAnswers(fields.role).map((o) => o.key)).toEqual(["DEVELOPER", "FOUNDER"]);
    expect(fields.specialty.enabled).toBe(false);
    expect(fields.title).toEqual(defaultPersonFields().title);
  });

  it("a retired answer is not offered and is still read by its label", () => {
    const { role } = readPersonFields(tech);
    expect(isOfferedAnswer(role, "DESIGNER")).toBe(false);
    expect(answerLabel(role, "DESIGNER")).toBe("Designer");
  });

  it("an answer that is not on the list is shown as it is, never dropped", () => {
    const { role, specialty } = readPersonFields({});
    expect(answerLabel(role, "PHYSICIAN")).toBe("Physician");
    expect(answerLabel(specialty, "Sleep medicine")).toBe("Sleep medicine");
    expect(answerLabel(role, null)).toBe("");
  });

  it("Others is offered only where the field allows it", () => {
    const fields = readPersonFields({});
    expect(isOfferedAnswer(fields.specialty, OTHER_ANSWER)).toBe(true);
    expect(isOfferedAnswer(fields.title, OTHER_ANSWER)).toBe(false);
    expect(offeredAnswers(readPersonFields(tech).role).some((o) => o.key === OTHER_ANSWER)).toBe(false);
  });
});

describe("a setting that cannot be used falls back whole, never half", () => {
  const withRole = (role: unknown) => readPersonFields({ [PERSON_FIELDS_SETTING]: { role } }).role;
  const fallback = defaultPersonFields().role;
  const good = { label: "Role", options: [{ key: "A", label: "A" }] };

  it.each([
    ["no label", { ...good, label: " " }],
    ["a label that is too long", { ...good, label: "x".repeat(61) }],
    ["options that are not a list", { ...good, options: "A,B" }],
    ["an answer with no key", { ...good, options: [{ key: "A", label: "A" }, { label: "B" }] }],
    ["an answer with no label", { ...good, options: [{ key: "A", label: "" }] }],
    ["two answers with one key", { ...good, options: [{ key: "A", label: "A" }, { key: "A", label: "Again" }] }],
    ["more answers than allowed", { ...good, options: Array.from({ length: 201 }, (_, i) => ({ key: `K${i}`, label: `L${i}` })) }],
  ])("%s", (_name, role) => {
    expect(withRole(role)).toEqual(fallback);
  });

  it("a usable one is read: trimmed, on unless switched off, no Others unless asked", () => {
    expect(withRole({ label: " Job ", options: [{ key: " DEV ", label: " Developer " }] })).toEqual({
      enabled: true, required: true, label: "Job", options: [{ key: "DEV", label: "Developer", retired: false }], allowOther: false,
    });
    // Both switches are on unless saved off.
    expect(withRole({ ...good, enabled: false, required: false })).toMatchObject({ enabled: false, required: false });
  });
});

describe("what a public form is handed", () => {
  it("only the answers on offer, with their labels, Others last: no retired answer, no settings", async () => {
    const { publicPersonFields } = await import("@/lib/person-fields");
    const fields = publicPersonFields(
      readPersonFields({
        [PERSON_FIELDS_SETTING]: {
          specialty: { label: "Area", options: [{ key: "Cloud", label: "Cloud" }, { key: "Legacy", label: "Legacy", retired: true }], allowOther: true },
        },
      }),
    );
    expect(fields.specialty).toEqual({ enabled: true, required: true, label: "Area", answers: [{ key: "Cloud", label: "Cloud" }, { key: "Others", label: "Others" }] });
    expect(Object.keys(fields).sort()).toEqual(["role", "specialty", "title"]);
  });
});

describe("the rule every form and every door asks", () => {
  it("today's form: all three shown and demanded", async () => {
    const { DEFAULT_PERSON_FIELD_RULES } = await import("@/lib/person-fields");
    expect(DEFAULT_PERSON_FIELD_RULES).toEqual({
      title: { shown: true, required: true }, role: { shown: true, required: true }, specialty: { shown: true, required: true },
    });
  });

  it("a field that is off is not shown and never demanded, whatever its required flag says", async () => {
    const { personFieldRules, publicPersonFields } = await import("@/lib/person-fields");
    const config = readPersonFields({
      [PERSON_FIELDS_SETTING]: {
        specialty: { enabled: false, required: true, label: "Specialty", options: [], allowOther: true },
        role: { enabled: true, required: false, label: "Role", options: [{ key: "DEV", label: "Developer" }] },
      },
    });
    expect(personFieldRules(config)).toEqual({
      title: { shown: true, required: true }, role: { shown: true, required: false }, specialty: { shown: false, required: false },
    });
    // The public page is told the same.
    expect(publicPersonFields(config).specialty).toMatchObject({ enabled: false, required: false });
  });
});
