import { describe, it, expect } from "vitest";
import { publicAskerName } from "@/lib/webinar/questions";

/** What other attendees see of an asker in the Q&A tab (Oct 1, 2026). */
describe("publicAskerName", () => {
  it("first name and last initial", () => {
    expect(publicAskerName("Dana Lee")).toBe("Dana L.");
    expect(publicAskerName("  Dana  Maria   lee ")).toBe("Dana L.");
  });
  it("a single name stays; empty becomes Attendee", () => {
    expect(publicAskerName("Prince")).toBe("Prince");
    expect(publicAskerName("   ")).toBe("Attendee");
  });
});
