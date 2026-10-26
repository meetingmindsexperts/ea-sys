/**
 * Optional attendee fields (src/lib/registration-form-fields.ts, Oct 26 2026):
 * State, Zip and dietary requirements are shown unless an organiser unticked
 * them, so every event saved before the setting existed keeps its form.
 */
import { describe, it, expect } from "vitest";
import { ALL_FORM_FIELDS_SHOWN, OPTIONAL_FORM_FIELDS, readFormFields, showsField } from "@/lib/registration-form-fields";

describe("readFormFields", () => {
  it("shows every field for an event that never set it, or set it badly", () => {
    for (const settings of [undefined, null, {}, { formFields: null }, { formFields: "no" }, { formFields: [] }]) {
      expect(readFormFields(settings)).toEqual(ALL_FORM_FIELDS_SHOWN);
    }
  });

  it("hides only a field switched off with exactly false", () => {
    expect(readFormFields({ formFields: { state: false, zipCode: 0, dietaryReqs: "false" } })).toEqual({ state: false, zipCode: true, dietaryReqs: true });
    expect(readFormFields({ formFields: { state: false, zipCode: false, dietaryReqs: false } })).toEqual({ state: false, zipCode: false, dietaryReqs: false });
  });

  it("ignores keys that are not optional fields", () => {
    expect(Object.keys(readFormFields({ formFields: { email: false, city: false } })).sort()).toEqual(["dietaryReqs", "state", "zipCode"]);
  });

  it("offers exactly State, Zip and dietary requirements, with labels", () => {
    expect(OPTIONAL_FORM_FIELDS.map((f) => f.key)).toEqual(["state", "zipCode", "dietaryReqs"]);
  });
});

describe("showsField", () => {
  it("shows a field when the response predates the setting", () => {
    expect(showsField(undefined, "state")).toBe(true);
    expect(showsField(null, "dietaryReqs")).toBe(true);
    expect(showsField({}, "zipCode")).toBe(true);
    expect(showsField({ zipCode: false }, "zipCode")).toBe(false);
  });
});
