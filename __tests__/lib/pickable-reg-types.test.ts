/**
 * Registration-type pickers never offer the speakers' type except to a
 * registration already on it (Oct 22, 2026: Uzma Sharif, BHS2026, was moved
 * onto it by hand and the sheet then showed read-only text with no way back).
 */
import { describe, it, expect } from "vitest";
import { pickableRegTypes, SPEAKERS_TYPE_LABEL } from "@/lib/faculty-filter";

const TYPES = [
  { id: "phys", name: "Physician", isFaculty: false },
  { id: "fac", name: "Faculty", isFaculty: true },
  { id: "nurse", name: "Nurse" },
];

describe("pickableRegTypes", () => {
  it("hides the speakers' type from a delegate", () => {
    expect(pickableRegTypes(TYPES, "phys").map((t) => t.id)).toEqual(["phys", "nurse"]);
  });

  it("keeps it for a registration already on it, so it can be moved off", () => {
    expect(pickableRegTypes(TYPES, "fac").map((t) => t.id)).toEqual(["phys", "fac", "nurse"]);
  });

  it("never offers it in bulk (no current type)", () => {
    expect(pickableRegTypes(TYPES, null).map((t) => t.id)).toEqual(["phys", "nurse"]);
  });

  it("labels it so it cannot be mistaken for an ordinary Faculty", () => {
    expect(SPEAKERS_TYPE_LABEL).toBe("Faculty (speakers)");
  });
});
