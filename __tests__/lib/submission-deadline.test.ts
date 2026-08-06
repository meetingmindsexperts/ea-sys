/**
 * Session-proposal deadline helpers (Aug 6, 2026) — the truth table both the
 * public door, the proposal routes, and the pages share.
 */
import { describe, it, expect } from "vitest";
import { readSessionProposalDeadline, isDeadlinePassed } from "@/lib/submission-deadline";

describe("readSessionProposalDeadline", () => {
  it("reads a valid ISO string from settings", () => {
    expect(
      readSessionProposalDeadline({ sessionProposalDeadline: "2030-01-01T10:00:00.000Z" }),
    ).toBe("2030-01-01T10:00:00.000Z");
  });

  it.each([null, undefined, "not-an-object", 42])(
    "returns null for a non-object settings blob (%s)",
    (settings) => {
      expect(readSessionProposalDeadline(settings)).toBeNull();
    },
  );

  it.each([undefined, null, "", "   ", 12345, "not-a-date"])(
    "returns null for an absent/blank/invalid value (%s)",
    (value) => {
      expect(readSessionProposalDeadline({ sessionProposalDeadline: value })).toBeNull();
    },
  );
});

describe("isDeadlinePassed", () => {
  it("false when no deadline is set", () => {
    expect(isDeadlinePassed(null)).toBe(false);
    expect(isDeadlinePassed(undefined)).toBe(false);
  });

  it("false while the deadline is still ahead", () => {
    expect(isDeadlinePassed(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it("true once the deadline is behind us", () => {
    expect(isDeadlinePassed("2020-01-01T00:00:00.000Z")).toBe(true);
  });

  it("false for an unparsable value (defensive — a corrupt setting never locks intake)", () => {
    expect(isDeadlinePassed("garbage")).toBe(false);
  });
});
