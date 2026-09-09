import { describe, it, expect } from "vitest";
import {
  readTravelGrantSettings,
  isTravelGrantEnabled,
  isTravelGrantDeadlinePassed,
  formatTravelGrantDeadline,
} from "@/lib/travel-grant/settings";

/**
 * The whole point of this suite is the DIRECTION of the default, in both halves
 * of the switch.
 *
 * MUTATIONS TO VERIFY AGAINST:
 *   1. Loosen `enabled === true` to a truthy check. The string "true" and the
 *      number 1 cases then pass when they must fail. This flag decides whether
 *      we email people, and a malformed blob that silently switches itself ON
 *      starts mailing grant offers, which editing the blob afterwards cannot
 *      undo.
 *   2. Let `enabled: true` stand with an empty `homeCountries`. The
 *      "on but unconfigured" case then reads as enabled — and an empty exempt
 *      set classifies EVERY recognised country as overseas, so the feature
 *      would offer a grant to every local author. That is the one place here
 *      where the intuitive reading fails OPEN.
 */
const AE = { travelGrant: { enabled: true, homeCountries: ["AE"] } };

describe("readTravelGrantSettings", () => {
  it("is ON only for an exact boolean true WITH a usable home country", () => {
    expect(readTravelGrantSettings(AE)).toEqual({
      enabled: true,
      homeCountries: ["AE"],
      switchedOn: true,
      ctaLabel: "Apply for Travel Grant",
      deadline: null,
    });
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
      ["enabled false", { travelGrant: { enabled: false, homeCountries: ["AE"] } }],
      ["enabled the STRING 'true'", { travelGrant: { enabled: "true", homeCountries: ["AE"] } }],
      ["enabled the NUMBER 1", { travelGrant: { enabled: 1, homeCountries: ["AE"] } }],
      ["enabled null", { travelGrant: { enabled: null, homeCountries: ["AE"] } }],
    ];
    it.each(closed)("%s resolves to disabled", (_label, settings) => {
      expect(readTravelGrantSettings(settings).enabled).toBe(false);
    });
  });

  describe("the home country is half the switch", () => {
    const unconfigured: [string, unknown][] = [
      ["no homeCountries key", { travelGrant: { enabled: true } }],
      ["an empty list", { travelGrant: { enabled: true, homeCountries: [] } }],
      ["a string instead of a list", { travelGrant: { enabled: true, homeCountries: "AE" } }],
      ["only unrecognised codes", { travelGrant: { enabled: true, homeCountries: ["ZZ", "??"] } }],
      ["only non-strings", { travelGrant: { enabled: true, homeCountries: [1, null, {}] } }],
    ];
    it.each(unconfigured)("%s reads as DISABLED, and says so", (_label, settings) => {
      const s = readTravelGrantSettings(settings);
      expect(s.enabled).toBe(false);
      // Not merely off: off BECAUSE it is half-configured. The settings card
      // renders that difference (switchedOn && !enabled), since a switch that is
      // on and does nothing, with nothing explaining why, is worse than a switch
      // that is off. The public consent route reads the same distinction the
      // other way: a half-edited list must not kill a live link.
      expect(s.switchedOn).toBe(true);
      expect(s.homeCountries).toEqual([]);
    });

    it("distinguishes 'switched off' from 'switched on but unusable'", () => {
      expect(readTravelGrantSettings({ travelGrant: { enabled: false } }).switchedOn).toBe(false);
      expect(readTravelGrantSettings(null).switchedOn).toBe(false);
      // The pair the consent route depends on: intent yes, effect no.
      const mid = readTravelGrantSettings({ travelGrant: { enabled: true } });
      expect([mid.switchedOn, mid.enabled]).toEqual([true, false]);
    });
  });

  describe("home countries are normalised, not stored as typed", () => {
    it("resolves names, codes and lowercase to the canonical code", () => {
      const s = readTravelGrantSettings({
        travelGrant: { enabled: true, homeCountries: ["United Arab Emirates", "sa", "QA"] },
      });
      expect(s.homeCountries).toEqual(["AE", "SA", "QA"]);
    });

    it("deduplicates the same country written two ways", () => {
      const s = readTravelGrantSettings({
        travelGrant: { enabled: true, homeCountries: ["AE", "United Arab Emirates", "uae"] },
      });
      expect(s.homeCountries).toEqual(["AE"]);
    });

    it("drops what it cannot resolve but keeps the rest", () => {
      const s = readTravelGrantSettings({
        travelGrant: { enabled: true, homeCountries: ["AE", "Dubai", "ZZ"] },
      });
      // "Dubai" is IN the UAE, so dropping it is right: it is not a country and
      // a half-resolved value here would silently change who is exempt.
      expect(s.homeCountries).toEqual(["AE"]);
      expect(s.enabled).toBe(true);
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
      travelGrant: { enabled: true, homeCountries: ["AE"] },
    };
    expect(readTravelGrantSettings(settings).enabled).toBe(true);
  });
});

describe("isTravelGrantEnabled", () => {
  it("agrees with the reader", () => {
    expect(isTravelGrantEnabled(AE)).toBe(true);
    expect(isTravelGrantEnabled({ travelGrant: { enabled: "true", homeCountries: ["AE"] } })).toBe(false);
    expect(isTravelGrantEnabled({ travelGrant: { enabled: true } })).toBe(false);
    expect(isTravelGrantEnabled(null)).toBe(false);
  });
});

describe("ctaLabel: the organizer's button text (Sep 8, 2026)", () => {
  const withLabel = (ctaLabel: unknown) =>
    readTravelGrantSettings({ travelGrant: { enabled: true, homeCountries: ["AE"], ctaLabel } }).ctaLabel;

  it("defaults to the shipped wording when absent, blank, non-string or over the cap", () => {
    expect(withLabel(undefined)).toBe("Apply for Travel Grant");
    expect(withLabel("   ")).toBe("Apply for Travel Grant");
    expect(withLabel(42)).toBe("Apply for Travel Grant");
    expect(withLabel("x".repeat(61))).toBe("Apply for Travel Grant");
    expect(readTravelGrantSettings(null).ctaLabel).toBe("Apply for Travel Grant");
  });

  it("keeps the organizer's text, trimmed", () => {
    expect(withLabel("  Request travel support  ")).toBe("Request travel support");
  });
});

describe("deadline (Sep 9, 2026)", () => {
  const on = (deadline: unknown) => ({ travelGrant: { enabled: true, homeCountries: ["AE"], deadline } });

  it("reads an ISO instant, and reads anything unreadable as NO deadline (it must never close applications by accident)", () => {
    expect(readTravelGrantSettings(on("2026-09-30T19:59:00.000Z")).deadline?.toISOString()).toBe("2026-09-30T19:59:00.000Z");
    expect(readTravelGrantSettings(on(undefined)).deadline).toBeNull();
    expect(readTravelGrantSettings(on("")).deadline).toBeNull();
    expect(readTravelGrantSettings(on("not a date")).deadline).toBeNull();
    expect(readTravelGrantSettings(on(1759262340000)).deadline).toBeNull();
  });

  it("has passed only once the instant is reached; no deadline never passes", () => {
    const s = readTravelGrantSettings(on("2026-09-30T19:59:00.000Z"));
    expect(isTravelGrantDeadlinePassed(s, new Date("2026-09-30T19:58:59.000Z"))).toBe(false);
    expect(isTravelGrantDeadlinePassed(s, new Date("2026-09-30T19:59:00.000Z"))).toBe(true);
    expect(isTravelGrantDeadlinePassed(readTravelGrantSettings(on(undefined)), new Date("2099-01-01"))).toBe(false);
  });

  it("words the deadline in the EVENT's timezone, not the server's", () => {
    const text = formatTravelGrantDeadline(new Date("2026-09-30T19:59:00.000Z"), "Asia/Dubai");
    // 19:59Z is 23:59 in Dubai; a UTC render would say 7:59 PM.
    expect(text).toMatch(/Sep 30, 2026/);
    expect(text).toMatch(/11:59\s?PM/);
    expect(text).toMatch(/GMT\+4/);
    expect(text).not.toMatch(/7:59/);
  });
});
