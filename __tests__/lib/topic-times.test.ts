import { describe, it, expect } from "vitest";
import { computeTopicTimes } from "@/lib/topic-times";

describe("computeTopicTimes (agenda + streaming page share it)", () => {
  it("stacks durations from the session start in the event timezone", () => {
    // 16:00 UTC = 8:00 PM Dubai
    const t = computeTopicTimes(
      "2026-10-07T16:00:00.000Z",
      [
        { id: "a", duration: 10 },
        { id: "b", duration: 30 },
        { id: "c", duration: 30 },
      ],
      "Asia/Dubai",
    );
    expect(t.get("a")).toMatch(/8:00\s?PM – 8:10\s?PM/);
    expect(t.get("b")).toMatch(/8:10\s?PM – 8:40\s?PM/);
    expect(t.get("c")).toMatch(/8:40\s?PM – 9:10\s?PM/);
  });

  it("a topic without a duration gets no time and does not move the clock", () => {
    const t = computeTopicTimes(
      "2026-10-07T16:00:00.000Z",
      [
        { id: "a", duration: null },
        { id: "b", duration: 15 },
      ],
      "Asia/Dubai",
    );
    expect(t.get("a")).toBeNull();
    expect(t.get("b")).toMatch(/8:00\s?PM – 8:15\s?PM/);
  });
});
