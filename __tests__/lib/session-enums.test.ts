/**
 * SessionType display helpers — the break-item hinge. `isBreakSessionType`
 * gates form sections, agenda rendering, the public detail-page 404, and the
 * service's BREAK_ITEM_HAS_PROGRAM check, so its truth table is pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  BREAK_SESSION_TYPES,
  SESSION_TYPE_KIND,
  SESSION_TYPE_LABELS,
  SESSION_TYPE_OPTIONS,
  formatSessionType,
  isBreakSessionType,
} from "@/lib/session-enums";

describe("isBreakSessionType", () => {
  it("is false for SESSION and for absent values (pre-column rows)", () => {
    expect(isBreakSessionType("SESSION")).toBe(false);
    expect(isBreakSessionType(null)).toBe(false);
    expect(isBreakSessionType(undefined)).toBe(false);
  });

  it("matches the explicit classification for every enum value — program types (SESSION/WORKSHOP/SYMPOSIUM) are never breaks", () => {
    for (const value of Object.keys(SESSION_TYPE_LABELS)) {
      expect(isBreakSessionType(value)).toBe(
        SESSION_TYPE_KIND[value as keyof typeof SESSION_TYPE_KIND] === "break"
      );
    }
    // The July 23 additions specifically: full program citizens, not breaks.
    expect(isBreakSessionType("WORKSHOP")).toBe(false);
    expect(isBreakSessionType("SYMPOSIUM")).toBe(false);
  });

  it("BREAK_SESSION_TYPES is exactly the break set (feeds Prisma notIn count filters)", () => {
    expect([...BREAK_SESSION_TYPES].sort()).toEqual(
      ["BREAK", "LUNCH", "NETWORKING", "REGISTRATION"]
    );
  });

  it("treats an unknown wire value as a real session (never hides content on bad data)", () => {
    expect(isBreakSessionType("COFFEE")).toBe(false);
    expect(isBreakSessionType("")).toBe(false);
  });
});

describe("formatSessionType", () => {
  it("labels every enum value", () => {
    expect(formatSessionType("BREAK")).toBe("Coffee Break");
    expect(formatSessionType("LUNCH")).toBe("Lunch Break");
    expect(formatSessionType("REGISTRATION")).toBe("Registration");
    expect(formatSessionType("NETWORKING")).toBe("Networking");
    expect(formatSessionType(null)).toBe("Session");
  });

  it("degrades an unknown value to Title Case, never raw", () => {
    expect(formatSessionType("SOMETHING_NEW")).toBe("Something_new");
  });
});

describe("SESSION_TYPE_OPTIONS", () => {
  it("covers every enum value exactly once, SESSION first", () => {
    expect(SESSION_TYPE_OPTIONS[0].value).toBe("SESSION");
    expect(new Set(SESSION_TYPE_OPTIONS.map((o) => o.value)).size).toBe(
      Object.keys(SESSION_TYPE_LABELS).length,
    );
  });
});
