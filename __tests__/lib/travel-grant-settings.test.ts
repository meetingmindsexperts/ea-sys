import { describe, it, expect } from "vitest";
import {
  readTravelGrantSettings,
  isTravelGrantEnabled,
} from "@/lib/travel-grant/settings";

/**
 * The whole point of this suite is the DIRECTION of the default.
 *
 * MUTATION TO VERIFY AGAINST: loosen `enabled === true` to a truthy check.
 * The string "true" and the number 1 cases then pass when they must fail. That
 * matters because this flag decides whether we email people, and a malformed
 * settings blob that silently switches itself ON starts mailing grant offers to
 * an event's authors, which editing the blob afterwards cannot undo.
 */
describe("readTravelGrantSettings", () => {
  it("is ON only for an exact boolean true", () => {
    expect(readTravelGrantSettings({ travelGrant: { enabled: true } })).toEqual({ enabled: true });
  });

  describe("fails CLOSED on anything else", () => {
    const closed: [string, unknown][] = [
      ["undefined settings", undefined],
      ["null settings", null],
      ["a settings array", []],
      ["a settings string", "travelGrant"],
      ["a settings number", 7],
      ["no travelGrant key", { agendaPublished: true }],
      ["travelGrant null", { travelGrant: null }],
      ["travelGrant an array", { travelGrant: [] }],
      ["travelGrant a string", { travelGrant: "enabled" }],
      ["travelGrant empty", { travelGrant: {} }],
      ["enabled false", { travelGrant: { enabled: false } }],
      ["enabled the STRING 'true'", { travelGrant: { enabled: "true" } }],
      ["enabled the NUMBER 1", { travelGrant: { enabled: 1 } }],
      ["enabled null", { travelGrant: { enabled: null } }],
    ];
    it.each(closed)("%s resolves to disabled", (_label, settings) => {
      expect(readTravelGrantSettings(settings)).toEqual({ enabled: false });
    });
  });

  it("never throws, whatever it is handed", () => {
    const hostile: unknown[] = [Symbol("x"), () => {}, NaN, new Date(), { travelGrant: 0 }];
    for (const value of hostile) {
      expect(() => readTravelGrantSettings(value)).not.toThrow();
      expect(readTravelGrantSettings(value).enabled).toBe(false);
    }
  });

  it("ignores unrelated settings keys rather than being confused by them", () => {
    const settings = {
      agendaPublished: true,
      registrationOpen: true,
      abstractLimits: { maxTitleWords: 30 },
      travelGrant: { enabled: true },
    };
    expect(readTravelGrantSettings(settings).enabled).toBe(true);
  });
});

describe("isTravelGrantEnabled", () => {
  it("agrees with the reader", () => {
    expect(isTravelGrantEnabled({ travelGrant: { enabled: true } })).toBe(true);
    expect(isTravelGrantEnabled({ travelGrant: { enabled: "true" } })).toBe(false);
    expect(isTravelGrantEnabled(null)).toBe(false);
  });
});
