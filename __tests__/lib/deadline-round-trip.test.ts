/**
 * Submission-deadline round-trip (Aug 11, 2026).
 *
 * THE BUG THESE PIN: the abstract + session-proposal deadline fields in Event
 * Settings loaded with `.toISOString().slice(0, 16)` and saved with
 * `new Date(value).toISOString()`. A `datetime-local` input carries no
 * timezone, so the browser reads whatever string it is given as LOCAL
 * wall-clock. Those two conversions therefore disagree, and the disagreement
 * is one-directional: every re-save moved the stored instant by the offset,
 * and it COMPOUNDED. On prod this produced a clean 4-hour ladder across the
 * live events (19:59Z correct, then 15:59Z, 11:59Z, 07:59Z) and left one
 * conference closing abstract submissions twelve hours early on the final day.
 *
 * The same defect was fixed once already in the dinner console (Survey/RSVP
 * review B2); these fields were simply never migrated onto the correct pair.
 *
 * The property that matters is NOT "one conversion is right" but "the pair is
 * lossless under repetition", which is what the compounding broke.
 */
import { describe, it, expect } from "vitest";
import { localDateTimeInTz, wallTimeInTzToIso } from "@/lib/event-time";

const DUBAI = "Asia/Dubai";
const MUSCAT = "Asia/Muscat";
const LONDON = "Europe/London";

/** What Settings does on load, then on save. One open-and-save cycle. */
function reSave(storedIso: string, tz: string): string {
  const shown = localDateTimeInTz(new Date(storedIso), tz);
  return wallTimeInTzToIso(shown, tz)!;
}

describe("deadline round-trip", () => {
  it("stores a 23:59 event-local deadline as the right instant", () => {
    // 23:59 on Sept 29 in Dubai (+4) is 19:59Z the same day. 19:59Z is exactly
    // the one value on prod that had never been re-saved.
    expect(wallTimeInTzToIso("2026-09-29T23:59", DUBAI)).toBe("2026-09-29T19:59:00.000Z");
  });

  it("shows a stored instant back as the wall-clock the organizer typed", () => {
    expect(localDateTimeInTz(new Date("2026-09-29T19:59:00.000Z"), DUBAI)).toBe(
      "2026-09-29T23:59",
    );
  });

  /**
   * THE regression. Opening Settings and pressing Save must be a no-op on a
   * field nobody touched. Ten cycles because the old bug was invisible after
   * one glance and only obvious once it had compounded.
   */
  it("does not drift across repeated open-and-save cycles", () => {
    let iso = "2026-09-29T19:59:00.000Z";
    for (let i = 0; i < 10; i++) iso = reSave(iso, DUBAI);
    expect(iso).toBe("2026-09-29T19:59:00.000Z");
  });

  it("does not drift for an event in a different timezone from the browser", () => {
    // The 2 live Asia/Muscat events. Muscat is also +4 but the point is that
    // the conversion is driven by the EVENT's timezone, not the machine's.
    let iso = "2026-10-19T19:59:00.000Z";
    for (let i = 0; i < 5; i++) iso = reSave(iso, MUSCAT);
    expect(iso).toBe("2026-10-19T19:59:00.000Z");
    expect(localDateTimeInTz(new Date(iso), MUSCAT)).toBe("2026-10-19T23:59");
  });

  it("does not drift across a DST boundary", () => {
    // Europe/London: BST (+1) in September, GMT (+0) in December. A fixed
    // numeric offset would fail one of these.
    for (const iso of ["2026-09-29T22:59:00.000Z", "2026-12-15T23:59:00.000Z"]) {
      let cur = iso;
      for (let i = 0; i < 5; i++) cur = reSave(cur, LONDON);
      expect(cur).toBe(iso);
    }
    expect(localDateTimeInTz(new Date("2026-09-29T22:59:00.000Z"), LONDON)).toBe(
      "2026-09-29T23:59",
    );
    expect(localDateTimeInTz(new Date("2026-12-15T23:59:00.000Z"), LONDON)).toBe(
      "2026-12-15T23:59",
    );
  });

  /**
   * The root cause, stated directly. `.toISOString().slice(0, 16)` yields the
   * UTC wall-clock, which is NOT the event wall-clock anywhere but UTC - and
   * that mismatched string is what used to be fed back into the save.
   * Deterministic regardless of the test machine's timezone, deliberately.
   */
  it("proves the old load conversion produced the wrong wall-clock", () => {
    const stored = "2026-09-29T19:59:00.000Z";
    const oldWay = new Date(stored).toISOString().slice(0, 16);
    const correct = localDateTimeInTz(new Date(stored), DUBAI);
    expect(oldWay).toBe("2026-09-29T19:59");
    expect(correct).toBe("2026-09-29T23:59");
    expect(oldWay).not.toBe(correct);
  });

  it("clears the deadline on empty input rather than storing an invalid date", () => {
    expect(wallTimeInTzToIso("", DUBAI)).toBeNull();
  });

  it("returns null for malformed input instead of an Invalid Date string", () => {
    // `new Date("not-a-date").toISOString()` THROWS; returning null means a
    // half-typed value clears the field rather than 500-ing the save.
    expect(wallTimeInTzToIso("not-a-date", DUBAI)).toBeNull();
    expect(wallTimeInTzToIso("2026-13-45T99:99", DUBAI)).toBeNull();
  });

  /**
   * Found by the test above, and it reaches further than this feature.
   * `Date.UTC` rolls over rather than rejecting, so a right-shaped impossible
   * date silently became a real one. Unreachable from a datetime-local input
   * (browsers constrain it) but fully reachable from the agenda CSV import,
   * where it would land a session on the wrong day and report a clean import.
   */
  it("rejects right-shaped impossible dates instead of rolling them over", () => {
    expect(wallTimeInTzToIso("2026-02-31T10:00", DUBAI)).toBeNull(); // not Mar 3
    expect(wallTimeInTzToIso("2026-13-01T10:00", DUBAI)).toBeNull(); // not Jan 2027
    expect(wallTimeInTzToIso("2026-09-29T25:00", DUBAI)).toBeNull(); // not next day 01:00
    expect(wallTimeInTzToIso("2026-09-29T10:60", DUBAI)).toBeNull(); // not 11:00
  });

  it("still accepts a real leap day", () => {
    expect(wallTimeInTzToIso("2028-02-29T23:59", DUBAI)).toBe("2028-02-29T19:59:00.000Z");
  });

  it("accepts a value with seconds, which some browsers emit", () => {
    expect(wallTimeInTzToIso("2026-09-29T23:59:30", DUBAI)).toBe("2026-09-29T19:59:30.000Z");
  });
});
