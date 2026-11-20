/**
 * abstractIntakeClosed: is the event still taking abstracts from authors
 * (owner, Nov 20, 2026).
 *
 * MUTATIONS: return null when the deadline has passed and the second test
 * fails; treat an unset switch as open and the first fails.
 */
import { describe, it, expect } from "vitest";
import { abstractIntakeClosed } from "@/lib/abstract-intake";

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 86_400_000).toISOString();

describe("abstractIntakeClosed", () => {
  it("is closed while the switch is off, never set, or the event is a webinar", () => {
    expect(abstractIntakeClosed({ settings: { allowAbstractSubmissions: false } })?.code).toBe("SUBMISSIONS_CLOSED");
    expect(abstractIntakeClosed({ settings: {} })?.code).toBe("SUBMISSIONS_CLOSED");
    expect(abstractIntakeClosed({ settings: null })?.code).toBe("SUBMISSIONS_CLOSED");
    expect(abstractIntakeClosed({ eventType: "WEBINAR", settings: { allowAbstractSubmissions: true } })?.code).toBe("SUBMISSIONS_CLOSED");
  });

  it("is closed once the deadline has passed, with a sentence for the author", () => {
    const closed = abstractIntakeClosed({ eventType: "CONFERENCE", settings: { allowAbstractSubmissions: true, abstractDeadline: past } });
    expect(closed).toEqual({ code: "DEADLINE_PASSED", message: "The abstract submission deadline has passed." });
  });

  it("is open with the switch on and no deadline, a deadline still ahead, or one that cannot be read", () => {
    expect(abstractIntakeClosed({ settings: { allowAbstractSubmissions: true } })).toBeNull();
    expect(abstractIntakeClosed({ settings: { allowAbstractSubmissions: true, abstractDeadline: future } })).toBeNull();
    expect(abstractIntakeClosed({ settings: { allowAbstractSubmissions: true, abstractDeadline: "not a date" } })).toBeNull();
  });

  it("the switch is asked before the deadline: off with a deadline ahead is still closed", () => {
    expect(abstractIntakeClosed({ settings: { allowAbstractSubmissions: false, abstractDeadline: future } })?.code).toBe("SUBMISSIONS_CLOSED");
  });
});
