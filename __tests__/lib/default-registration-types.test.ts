/**
 * The per-organisation starting registration types: the Settings → General
 * list, validated on save and read tolerantly at event creation.
 */
import { describe, it, expect } from "vitest";
import {
  defaultRegistrationTypesSchema,
  readDefaultRegistrationTypes,
  MAX_DEFAULT_REG_TYPES,
} from "@/lib/default-registration-types";

describe("defaultRegistrationTypesSchema", () => {
  it("accepts and trims a list, keeping its order", () => {
    expect(defaultRegistrationTypesSchema.parse([" Delegate ", "Exhibitor"])).toEqual(["Delegate", "Exhibitor"]);
  });

  it("accepts an empty list (no starting types)", () => {
    expect(defaultRegistrationTypesSchema.safeParse([]).success).toBe(true);
  });

  it.each([
    ["a blank name", ["Delegate", "  "]],
    ["a duplicate, case-insensitively", ["Delegate", "delegate"]],
    ["a name over 100 characters", ["x".repeat(101)]],
    ["too many names", Array.from({ length: MAX_DEFAULT_REG_TYPES + 1 }, (_, i) => `Type ${i}`)],
  ])("refuses %s", (_label, names) => {
    expect(defaultRegistrationTypesSchema.safeParse(names).success).toBe(false);
  });
});

describe("readDefaultRegistrationTypes", () => {
  it("reads the org's list", () => {
    expect(readDefaultRegistrationTypes({ defaultRegistrationTypes: ["Delegate"] })).toEqual(["Delegate"]);
  });

  it.each([null, undefined, "x", {}, { defaultRegistrationTypes: "Delegate" }, { defaultRegistrationTypes: ["a", "A"] }])(
    "reads %j as none",
    (settings) => {
      expect(readDefaultRegistrationTypes(settings)).toEqual([]);
    },
  );
});
