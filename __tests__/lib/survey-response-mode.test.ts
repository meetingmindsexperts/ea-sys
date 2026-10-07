/** Several surveys, Phase 4 (Oct 7, 2026): once per day, in the event's timezone. */
import { describe, it, expect } from "vitest";
import { isDailyMode, responseDay, responseDedupKey } from "@/lib/survey/response-mode";
import { toCsv } from "@/lib/survey/aggregate";

describe("response mode helpers", () => {
  it("ONCE keys on the registration; daily keys on the registration and the day", () => {
    const at = new Date("2026-10-07T10:00:00Z");
    expect(responseDedupKey("ONCE", "reg1", at, "Asia/Dubai")).toBe("reg1");
    expect(responseDedupKey(undefined, "reg1", at, "Asia/Dubai")).toBe("reg1");
    expect(responseDedupKey("ONCE_PER_DAY", "reg1", at, "Asia/Dubai")).toBe("reg1:2026-10-07");
  });

  it("the day is the event's calendar day, not the server's (UTC)", () => {
    // 22:30 UTC on Oct 7 is already Oct 8 in Dubai (UTC+4).
    const lateUtc = new Date("2026-10-07T22:30:00Z");
    expect(responseDay(lateUtc, "Asia/Dubai")).toBe("2026-10-08");
    expect(responseDay(lateUtc, "UTC")).toBe("2026-10-07");
    expect(responseDedupKey("ONCE_PER_DAY", "r", lateUtc, "Asia/Dubai")).toBe("r:2026-10-08");
  });

  it("only ONCE_PER_DAY is daily", () => {
    expect(isDailyMode("ONCE_PER_DAY")).toBe(true);
    expect(isDailyMode("ONCE")).toBe(false);
    expect(isDailyMode(null)).toBe(false);
  });

  it("the CSV gets a day column only when asked", () => {
    const config = [{ id: "q1", type: "rating_1_to_5", label: "Q", required: true }] as never;
    const row = { responseId: "x", submittedAt: "2026-10-07T10:00:00.000Z", answers: { q1: 4 }, day: "2026-10-07" };
    expect(toCsv(config, [row]).split("\n")[0]).not.toContain("day");
    const daily = toCsv(config, [row], { dayColumn: true }).split("\n");
    expect(daily[0].startsWith("submittedAt,day,")).toBe(true);
    expect(daily[1]).toContain("2026-10-07T10:00:00.000Z,2026-10-07,");
  });
});
