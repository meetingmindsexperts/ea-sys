import { describe, it, expect } from "vitest";
import { abstractSubmissionsOpen } from "@/lib/webinar";

describe("abstractSubmissionsOpen", () => {
  it("is open on a conference with the setting on", () => {
    expect(abstractSubmissionsOpen({ eventType: "CONFERENCE", settings: { allowAbstractSubmissions: true } })).toBe(true);
  });

  it("is closed on a WEBINAR even with the setting on (e.g. carried over from a clone)", () => {
    expect(abstractSubmissionsOpen({ eventType: "WEBINAR", settings: { allowAbstractSubmissions: true } })).toBe(false);
  });

  it("is closed when the setting is off or missing", () => {
    expect(abstractSubmissionsOpen({ eventType: "HYBRID", settings: { allowAbstractSubmissions: false } })).toBe(false);
    expect(abstractSubmissionsOpen({ eventType: "CONFERENCE", settings: null })).toBe(false);
    expect(abstractSubmissionsOpen({ settings: { allowAbstractSubmissions: "true" } })).toBe(false);
  });
});
