/**
 * Per-event presentation-type offering (July 13, 2026) — the organizer picks
 * which types the abstract form offers (Event.settings.abstractPresentationTypes);
 * absent/empty/invalid config = ALL types (owner decision: unconfigured events
 * behave exactly as before). The forms filter their dropdowns through
 * `enabledPresentationTypeOptions`; the create/update routes enforce it with
 * `isPresentationTypeEnabled` (keep-existing always allowed on edit).
 */
import { describe, it, expect } from "vitest";

import {
  ALL_PRESENTATION_TYPE_VALUES,
  isPresentationTypeEnabled,
  readEnabledPresentationTypes,
} from "@/lib/abstract-presentation-types";
import { enabledPresentationTypeOptions } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";

describe("readEnabledPresentationTypes", () => {
  it("absent / null / non-array config → all five types (unconfigured = unchanged)", () => {
    expect(readEnabledPresentationTypes(undefined)).toEqual(ALL_PRESENTATION_TYPE_VALUES);
    expect(readEnabledPresentationTypes(null)).toEqual(ALL_PRESENTATION_TYPE_VALUES);
    expect(readEnabledPresentationTypes({})).toEqual(ALL_PRESENTATION_TYPE_VALUES);
    expect(readEnabledPresentationTypes({ abstractPresentationTypes: "ORAL" })).toEqual(
      ALL_PRESENTATION_TYPE_VALUES,
    );
  });

  it("a configured subset is honored, in canonical display order", () => {
    expect(
      readEnabledPresentationTypes({ abstractPresentationTypes: ["VIDEO", "ORAL"] }),
    ).toEqual(["ORAL", "VIDEO"]);
  });

  it("unknown values are dropped; a fully-invalid or empty list falls back to all", () => {
    expect(
      readEnabledPresentationTypes({ abstractPresentationTypes: ["ORAL", "KEYNOTE", 42] }),
    ).toEqual(["ORAL"]);
    expect(readEnabledPresentationTypes({ abstractPresentationTypes: ["KEYNOTE"] })).toEqual(
      ALL_PRESENTATION_TYPE_VALUES,
    );
    // Empty offering would make submission impossible (type is mandatory to
    // submit) — falls back to all.
    expect(readEnabledPresentationTypes({ abstractPresentationTypes: [] })).toEqual(
      ALL_PRESENTATION_TYPE_VALUES,
    );
  });
});

describe("isPresentationTypeEnabled", () => {
  const settings = { abstractPresentationTypes: ["ORAL_POSTER", "VIDEO"] };

  it("true for enabled, false for disabled, all-true when unconfigured", () => {
    expect(isPresentationTypeEnabled(settings, "VIDEO")).toBe(true);
    expect(isPresentationTypeEnabled(settings, "WORKSHOP")).toBe(false);
    expect(isPresentationTypeEnabled(undefined, "WORKSHOP")).toBe(true);
  });
});

describe("enabledPresentationTypeOptions (the form dropdowns)", () => {
  const settings = { abstractPresentationTypes: ["ORAL", "POSTER"] };

  it("filters the option list to the enabled set", () => {
    expect(enabledPresentationTypeOptions(settings).map((o) => o.value)).toEqual([
      "ORAL",
      "POSTER",
    ]);
  });

  it("keeps an abstract's existing disabled type selectable, annotated", () => {
    const options = enabledPresentationTypeOptions(settings, "WORKSHOP");
    expect(options.map((o) => o.value)).toEqual(["ORAL", "POSTER", "WORKSHOP"]);
    expect(options.find((o) => o.value === "WORKSHOP")?.label).toContain("(no longer offered)");
  });

  it("an enabled current value is not duplicated or annotated", () => {
    const options = enabledPresentationTypeOptions(settings, "ORAL");
    expect(options.map((o) => o.value)).toEqual(["ORAL", "POSTER"]);
    expect(options[0].label).not.toContain("no longer offered");
  });

  it("unconfigured event offers everything", () => {
    expect(enabledPresentationTypeOptions(undefined).map((o) => o.value)).toEqual(
      ALL_PRESENTATION_TYPE_VALUES,
    );
  });
});
