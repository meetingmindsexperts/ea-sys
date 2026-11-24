/**
 * THE rule for presentation types (Nov 24, 2026; docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md):
 * the organisation's list (`readPresentationTypes`), what an event offers
 * (`offeredPresentationTypes`) and what a form lists (`presentationTypeChoices`).
 * The per-event offering it replaced dates from July 13, 2026; its cases are kept.
 */
import { describe, it, expect } from "vitest";
import {
  BUILT_IN_PRESENTATION_TYPE_KEYS,
  defaultPresentationTypes,
  eventPresentationTypes,
  inDecisionOrder,
  isPresentationTypeOffered,
  offeredPresentationTypeNames,
  offeredPresentationTypes,
  presentationTypeChoices,
  presentationTypeLabel,
  readPresentationTypes,
} from "@/lib/abstract-presentation-types";

const keys = (list: { key: string }[]) => list.map((t) => t.key);
const DEFAULTS = defaultPresentationTypes();

describe("readPresentationTypes: the organisation's list", () => {
  it("an organisation that never edited it has the five, by the names used everywhere until now", () => {
    for (const settings of [undefined, null, {}, { presentationTypes: "ORAL" }, { presentationTypes: [] }]) {
      expect(readPresentationTypes(settings)).toEqual(DEFAULTS);
    }
    expect(DEFAULTS.map((t) => `${t.key}=${t.label}`)).toEqual([
      "ORAL_POSTER=Oral or Poster",
      "ORAL=Oral",
      "POSTER=Poster",
      "VIDEO=Video",
      "WORKSHOP=Workshop",
    ]);
    expect(DEFAULTS.every((t) => t.builtIn && !t.retired)).toBe(true);
  });

  it("keeps a built-in's new name and its retired mark, in the built-ins' own order", () => {
    const list = readPresentationTypes({
      presentationTypes: [
        { key: "POSTER", label: "E-poster", retired: false },
        { key: "VIDEO", label: "Video", retired: true },
      ],
    });
    expect(keys(list)).toEqual([...BUILT_IN_PRESENTATION_TYPE_KEYS]);
    expect(presentationTypeLabel(list, "POSTER")).toBe("E-poster");
    expect(list.find((t) => t.key === "VIDEO")?.retired).toBe(true);
  });

  it("puts the organisation's own types after the built-ins, in the order they were added", () => {
    const list = readPresentationTypes({
      presentationTypes: [
        { key: "SYMPOSIUM", label: "Symposium" },
        { key: "ORAL", label: "Oral" },
        { key: "CASE_REPORT", label: "Case report" },
      ],
    });
    expect(keys(list)).toEqual([...BUILT_IN_PRESENTATION_TYPE_KEYS, "SYMPOSIUM", "CASE_REPORT"]);
    expect(list.find((t) => t.key === "SYMPOSIUM")).toEqual({ key: "SYMPOSIUM", label: "Symposium", retired: false, builtIn: false });
  });

  it("puts back a built-in the stored list lost, and drops anything malformed, duplicated or reserved", () => {
    const list = readPresentationTypes({
      presentationTypes: [
        { key: "symposium", label: "lower-case key" },
        { key: "BLANK", label: "   " },
        { key: "NEITHER", label: "Neither" },
        { key: "DUP", label: "First" },
        { key: "DUP", label: "Second" },
        42,
        null,
      ],
    });
    expect(keys(list)).toEqual([...BUILT_IN_PRESENTATION_TYPE_KEYS, "DUP"]);
    expect(presentationTypeLabel(list, "DUP")).toBe("First");
  });

  it("a name is trimmed and its inner spaces collapsed", () => {
    const list = readPresentationTypes({ presentationTypes: [{ key: "ORAL", label: "  Oral \n talk " }] });
    expect(presentationTypeLabel(list, "ORAL")).toBe("Oral talk");
  });

  it("a key the list does not know shows as itself, never as nothing", () => {
    expect(presentationTypeLabel(DEFAULTS, "LIGHTNING")).toBe("LIGHTNING");
    expect(presentationTypeLabel(DEFAULTS, null)).toBe("");
  });
});

describe("offeredPresentationTypes: what an event's forms offer", () => {
  it("nothing ticked, or nothing usable ticked: the built-in five", () => {
    for (const settings of [undefined, null, {}, { abstractPresentationTypes: "ORAL" }, { abstractPresentationTypes: [] }, { abstractPresentationTypes: ["KEYNOTE"] }]) {
      expect(keys(offeredPresentationTypes(settings, DEFAULTS))).toEqual([...BUILT_IN_PRESENTATION_TYPE_KEYS]);
    }
  });

  it("the ticked types, in the list's order whatever order they were saved in", () => {
    expect(keys(offeredPresentationTypes({ abstractPresentationTypes: ["VIDEO", "ORAL"] }, DEFAULTS))).toEqual(["ORAL", "VIDEO"]);
    expect(keys(offeredPresentationTypes({ abstractPresentationTypes: ["ORAL", "KEYNOTE", 42] }, DEFAULTS))).toEqual(["ORAL"]);
  });

  it("an organisation's own type is offered only where it is ticked", () => {
    const list = readPresentationTypes({ presentationTypes: [{ key: "SYMPOSIUM", label: "Symposium" }] });
    expect(keys(offeredPresentationTypes({}, list))).not.toContain("SYMPOSIUM");
    expect(keys(offeredPresentationTypes({ abstractPresentationTypes: ["SYMPOSIUM", "ORAL"] }, list))).toEqual(["ORAL", "SYMPOSIUM"]);
  });

  it("a retired type is offered nowhere, ticked or not; an event left with nothing falls back to the live built-ins", () => {
    const list = readPresentationTypes({ presentationTypes: [{ key: "VIDEO", label: "Video", retired: true }] });
    expect(keys(offeredPresentationTypes({}, list))).toEqual(["ORAL_POSTER", "ORAL", "POSTER", "WORKSHOP"]);
    expect(keys(offeredPresentationTypes({ abstractPresentationTypes: ["VIDEO", "POSTER"] }, list))).toEqual(["POSTER"]);
    expect(keys(offeredPresentationTypes({ abstractPresentationTypes: ["VIDEO"] }, list))).toEqual(["ORAL_POSTER", "ORAL", "POSTER", "WORKSHOP"]);
  });

  it("isPresentationTypeOffered and the refusal's list say the same", () => {
    const settings = { abstractPresentationTypes: ["ORAL", "VIDEO"] };
    expect(isPresentationTypeOffered(settings, DEFAULTS, "VIDEO")).toBe(true);
    expect(isPresentationTypeOffered(settings, DEFAULTS, "WORKSHOP")).toBe(false);
    expect(isPresentationTypeOffered(undefined, DEFAULTS, "WORKSHOP")).toBe(true);
    expect(offeredPresentationTypeNames(settings, DEFAULTS)).toBe("Oral (ORAL), Video (VIDEO)");
  });

  it("the page's list marks each type offered or not, retired ones included so a stored type keeps its name", () => {
    const list = readPresentationTypes({ presentationTypes: [{ key: "VIDEO", label: "Video", retired: true }] });
    const marked = eventPresentationTypes({ abstractPresentationTypes: ["ORAL"] }, list);
    expect(marked.map((t) => `${t.key}:${t.offered}`)).toEqual(["ORAL_POSTER:false", "ORAL:true", "POSTER:false", "VIDEO:false", "WORKSHOP:false"]);
  });
});

describe("presentationTypeChoices: a form's dropdown", () => {
  const offered = offeredPresentationTypes({ abstractPresentationTypes: ["ORAL_POSTER", "ORAL"] }, DEFAULTS);

  it("lists the offered types by name", () => {
    expect(presentationTypeChoices(offered, DEFAULTS)).toEqual([
      { value: "ORAL_POSTER", label: "Oral or Poster" },
      { value: "ORAL", label: "Oral" },
    ]);
  });

  it("keeps the type an abstract already holds, marked, when the event no longer offers it", () => {
    const choices = presentationTypeChoices(offered, DEFAULTS, "WORKSHOP");
    expect(choices.map((c) => c.value)).toEqual(["ORAL_POSTER", "ORAL", "WORKSHOP"]);
    expect(choices[2].label).toBe("Workshop (no longer offered)");
  });

  it("adds nothing when the held type is still offered", () => {
    expect(presentationTypeChoices(offered, DEFAULTS, "ORAL")).toHaveLength(2);
  });
});

describe("inDecisionOrder: where decisions are counted", () => {
  it("puts the either-way choice after Oral and Poster and keeps the rest in the list's order", () => {
    const list = readPresentationTypes({ presentationTypes: [{ key: "SYMPOSIUM", label: "Symposium" }] });
    expect(keys(inDecisionOrder(list))).toEqual(["ORAL", "POSTER", "ORAL_POSTER", "VIDEO", "WORKSHOP", "SYMPOSIUM"]);
  });
});

// Review of 89d803698.
describe("edges the review found", () => {
  it("a built-in shows by its usual name while a page's list is still loading", () => {
    expect(presentationTypeLabel([], "ORAL_POSTER")).toBe("Oral or Poster");
    expect(presentationTypeLabel([], "SYMPOSIUM")).toBe("SYMPOSIUM");
  });

  it("a form offers nothing while its list loads, rather than marking the abstract's type no longer offered", () => {
    expect(presentationTypeChoices([], [], "ORAL")).toEqual([]);
  });

  it("an event is never left with nothing to offer while any type is live", () => {
    const allBuiltInsRetired = readPresentationTypes({
      presentationTypes: [
        ...BUILT_IN_PRESENTATION_TYPE_KEYS.map((key) => ({ key, label: key, retired: true })),
        { key: "SYMPOSIUM", label: "Symposium" },
      ],
    });
    expect(keys(offeredPresentationTypes({}, allBuiltInsRetired))).toEqual(["SYMPOSIUM"]);
  });
});
