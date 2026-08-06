/**
 * Group-registration settings — parse/clamp/bounds truth table (Aug 6, 2026).
 * Fail-CLOSED polarity: an opt-in feature's corrupt settings resolve to
 * DISABLED (opposite of the session-proposal deadline, which fails open).
 */
import { describe, it, expect } from "vitest";
import {
  readGroupRegistrationSettings,
  groupSizeOutOfBounds,
  GROUP_MEMBERS_HARD_CEILING,
  DEFAULT_GROUP_REGISTRATION_SETTINGS,
} from "@/lib/group-registration-settings";

describe("readGroupRegistrationSettings", () => {
  it.each([null, undefined, "junk", 42, { groupRegistration: "junk" }, {}])(
    "corrupt/absent blob (%s) resolves to the DISABLED default",
    (settings) => {
      expect(readGroupRegistrationSettings(settings)).toEqual(DEFAULT_GROUP_REGISTRATION_SETTINGS);
    },
  );

  it("parses a valid block", () => {
    expect(
      readGroupRegistrationSettings({ groupRegistration: { enabled: true, minMembers: 3, maxMembers: 20 } }),
    ).toEqual({ enabled: true, minMembers: 3, maxMembers: 20 });
  });

  it("enabled requires literal true (a truthy string never enables)", () => {
    expect(
      readGroupRegistrationSettings({ groupRegistration: { enabled: "yes", minMembers: 2, maxMembers: 5 } }).enabled,
    ).toBe(false);
  });

  it("clamps maxMembers to the hard ceiling (50)", () => {
    const s = readGroupRegistrationSettings({ groupRegistration: { enabled: true, minMembers: 2, maxMembers: 500 } });
    expect(s.maxMembers).toBe(GROUP_MEMBERS_HARD_CEILING);
  });

  it("a min above the max collapses to the max (never unsatisfiable)", () => {
    const s = readGroupRegistrationSettings({ groupRegistration: { enabled: true, minMembers: 30, maxMembers: 10 } });
    expect(s.minMembers).toBe(10);
    expect(s.maxMembers).toBe(10);
  });

  it("non-numeric bounds fall to defaults; floats truncate; zero floors to 1", () => {
    const s = readGroupRegistrationSettings({
      groupRegistration: { enabled: true, minMembers: "abc", maxMembers: 7.9 },
    });
    expect(s.minMembers).toBe(2);
    expect(s.maxMembers).toBe(7);
    const z = readGroupRegistrationSettings({ groupRegistration: { enabled: true, minMembers: 0, maxMembers: 0 } });
    expect(z.minMembers).toBe(1);
    expect(z.maxMembers).toBe(1);
  });
});

describe("groupSizeOutOfBounds", () => {
  const s = { enabled: true, minMembers: 2, maxMembers: 10 };
  it("rejects below min", () => {
    expect(groupSizeOutOfBounds(1, s).ok).toBe(false);
  });
  it("rejects above max", () => {
    expect(groupSizeOutOfBounds(11, s).ok).toBe(false);
  });
  it("accepts the boundaries", () => {
    expect(groupSizeOutOfBounds(2, s).ok).toBe(true);
    expect(groupSizeOutOfBounds(10, s).ok).toBe(true);
  });
});
