/**
 * Badge Type control derivation (Aug 25, 2026).
 *
 * WHY THIS FILE EXISTS. The organiser reported "the custom badge type is not
 * saving". It was saving. The control hid it.
 *
 * `isCustom` was derived in VIEW mode as well as edit mode, so a saved
 * "VIP Guest" made the Select carry the "Custom" sentinel and its trigger
 * rendered the literal words "Custom..." — while the free-text input holding
 * the actual text was gated on `isEditing` and therefore did not render at
 * all. You typed a value, saved, dropped out of edit mode, and the field
 * showed a dropdown label with your text nowhere on screen. Indistinguishable,
 * from the organiser's seat, from a failed write.
 *
 * The derivation moved out of the JSX so the rule is stated once and pinned
 * here rather than re-litigated inline the next time this control is touched.
 */
import { describe, it, expect } from "vitest";
import {
  BADGE_TYPE_FALLBACK,
  BADGE_TYPE_PRESETS,
  CUSTOM_BADGE_TYPE,
  resolveBadgeTypeField,
} from "@/app/(dashboard)/events/[eventId]/registrations/registration-enums";

const view = (stored: string | null) =>
  resolveBadgeTypeField({ stored, isEditing: false, customOpen: false });
const edit = (stored: string | null, customOpen = false) =>
  resolveBadgeTypeField({ stored, isEditing: true, customOpen });

describe("the reported bug: a saved custom value must be visible in view mode", () => {
  it("surfaces the custom text rather than only the sentinel", () => {
    // THE regression. Before the fix this returned customValue "" and the
    // caller hid the input, so "VIP Guest" was on screen nowhere.
    const f = view("VIP Guest");
    expect(f.isCustom).toBe(true);
    expect(f.selectValue).toBe(CUSTOM_BADGE_TYPE);
    expect(f.customValue).toBe("VIP Guest");
  });

  it("shows the same text in edit mode, so nothing changes on Edit", () => {
    expect(edit("VIP Guest").customValue).toBe("VIP Guest");
  });
});

describe("presets", () => {
  it("every preset resolves to itself, not to custom", () => {
    for (const preset of BADGE_TYPE_PRESETS) {
      const f = view(preset);
      expect(f.isCustom).toBe(false);
      expect(f.selectValue).toBe(preset);
      expect(f.customValue).toBe("");
    }
  });

  it("is case-sensitive, so an imported 'faculty' reads as custom", () => {
    // Deliberate and worth pinning: badgeType is free text and MCP can write
    // any casing. Silently folding case would make the picker claim a value
    // the badge does not print.
    expect(view("faculty").isCustom).toBe(true);
    expect(view("faculty").customValue).toBe("faculty");
  });
});

describe("no value set", () => {
  it("null shows what the badge actually prints, not an empty control", () => {
    // The renderer prints DELEGATE for a null badgeType, so a blank picker
    // would imply nothing prints.
    expect(view(null)).toEqual({
      isCustom: false,
      selectValue: BADGE_TYPE_FALLBACK,
      customValue: "",
    });
  });

  it("an empty string behaves like null", () => {
    // Reachable: MCP update_registration accepts "" and one production row
    // carries it.
    expect(view("")).toEqual(view(null));
  });
});

describe("customOpen is honoured only while editing", () => {
  it("opens the free-text input before anything is typed", () => {
    // Picking "Custom…" sets the value to "", which is indistinguishable from
    // "nothing set" — hence the flag.
    const f = edit("", true);
    expect(f.isCustom).toBe(true);
    expect(f.selectValue).toBe(CUSTOM_BADGE_TYPE);
    expect(f.customValue).toBe("");
  });

  it("a stale flag can never make VIEW mode claim a value it does not have", () => {
    // The flag is component state on a sheet that never unmounts. If view mode
    // honoured it, an untouched registration would read "Custom..." with
    // nothing behind it.
    expect(view(null).isCustom).toBe(false);
    expect(
      resolveBadgeTypeField({ stored: null, isEditing: false, customOpen: true }).isCustom,
    ).toBe(false);
    expect(
      resolveBadgeTypeField({ stored: "Faculty", isEditing: false, customOpen: true })
        .selectValue,
    ).toBe("Faculty");
  });

  it("picking a preset after Custom returns to the preset", () => {
    expect(edit("Exhibitor", false).selectValue).toBe("Exhibitor");
  });
});
