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
  applyPresentationTypeChange,
  newPresentationTypeKey,
  storedPresentationTypes,
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

// Step 3 (Nov 24, 2026): the organisation changes its list.
describe("applyPresentationTypeChange: one change to the list", () => {
  const own = readPresentationTypes({ presentationTypes: [{ key: "SYMPOSIUM", label: "Symposium" }] });
  const apply = (change: Parameters<typeof applyPresentationTypeChange>[1], list = own, inUse = 0) => applyPresentationTypeChange(list, change, inUse);

  it("adds a type after the others, with a key made from its name, live and not built in", () => {
    const r = apply({ action: "add", label: "  Case   report " });
    expect(r).toMatchObject({ ok: true, key: "CASE_REPORT" });
    if (!r.ok) throw new Error("refused");
    expect(r.types.at(-1)).toEqual({ key: "CASE_REPORT", label: "Case report", retired: false, builtIn: false });
  });

  it("never reuses a key the list holds, a built-in's or NEITHER", () => {
    expect(newPresentationTypeKey("Poster", own)).toBe("POSTER_2");
    expect(newPresentationTypeKey("Neither", own)).toBe("NEITHER_2");
    expect(newPresentationTypeKey("Symposium", own)).toBe("SYMPOSIUM_2");
    expect(newPresentationTypeKey("مداخلة", own)).toBe("TYPE");
    expect(newPresentationTypeKey("É-poster", own)).toBe("E_POSTER");
  });

  it("refuses a name another type has, whatever its case or spacing, and says when that one is retired", () => {
    expect(apply({ action: "add", label: "oral" })).toMatchObject({ ok: false, code: "LABEL_TAKEN" });
    const retired = readPresentationTypes({ presentationTypes: [{ key: "VIDEO", label: "Video", retired: true }] });
    const r = apply({ action: "add", label: "VIDEO" }, retired);
    expect(r).toMatchObject({ ok: false, code: "LABEL_TAKEN" });
    expect(r.ok ? "" : r.message).toContain("restore it instead");
    expect(apply({ action: "add", label: "   " })).toMatchObject({ ok: false, code: "LABEL_INVALID" });
  });

  it("renames a built-in, keeping its key and so what it does", () => {
    const r = apply({ action: "rename", key: "POSTER", label: "E-poster" });
    expect(r).toMatchObject({ ok: true, key: "POSTER" });
    if (!r.ok) throw new Error("refused");
    expect(presentationTypeLabel(r.types, "POSTER")).toBe("E-poster");
    expect(apply({ action: "rename", key: "POSTER", label: "Poster" })).toMatchObject({ ok: false, code: "NO_CHANGE" });
    expect(apply({ action: "rename", key: "GONE", label: "X" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("retires and restores any type, and never retires the last live one", () => {
    const r = apply({ action: "retire", key: "VIDEO" });
    expect(r.ok && r.types.find((t) => t.key === "VIDEO")?.retired).toBe(true);
    if (!r.ok) throw new Error("refused");
    const back = apply({ action: "restore", key: "VIDEO" }, r.types);
    expect(back.ok && back.types.find((t) => t.key === "VIDEO")?.retired).toBe(false);
    const oneLive = readPresentationTypes({
      presentationTypes: BUILT_IN_PRESENTATION_TYPE_KEYS.map((key) => ({ key, label: key, retired: key !== "ORAL" })),
    });
    expect(apply({ action: "retire", key: "ORAL" }, oneLive)).toMatchObject({ ok: false, code: "LAST_LIVE_TYPE" });
  });

  it("deletes only an organisation's own type that nothing holds", () => {
    expect(apply({ action: "delete", key: "POSTER" })).toMatchObject({ ok: false, code: "BUILT_IN_NOT_DELETABLE" });
    expect(apply({ action: "delete", key: "SYMPOSIUM" }, own, 3)).toMatchObject({ ok: false, code: "IN_USE" });
    const r = apply({ action: "delete", key: "SYMPOSIUM" });
    expect(r.ok && r.types.map((t) => t.key)).toEqual([...BUILT_IN_PRESENTATION_TYPE_KEYS]);
  });

  it("refuses a type past the limit", () => {
    const full = readPresentationTypes({ presentationTypes: Array.from({ length: 30 }, (_, i) => ({ key: `T${i}`, label: `Type ${i}` })) });
    expect(full).toHaveLength(30);
    expect(apply({ action: "add", label: "One more" }, full)).toMatchObject({ ok: false, code: "TOO_MANY" });
  });

  it("stores every type, built-ins included, and reads back the same list", () => {
    const r = apply({ action: "add", label: "Case report" });
    if (!r.ok) throw new Error("refused");
    expect(readPresentationTypes({ presentationTypes: storedPresentationTypes(r.types) })).toEqual(r.types);
  });
});
