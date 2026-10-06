/** Live polls (Oct 6, 2026): the shared rules. */
import { describe, it, expect } from "vitest";
import { livePollsEnabled, percentOf, pollDraftSchema, tallyPoll, validChoices } from "@/lib/webinar/live-polls";

const OPTS = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];

describe("live polls", () => {
  it("are off unless the organiser turns them on", () => {
    expect(livePollsEnabled(undefined)).toBe(false);
    expect(livePollsEnabled({})).toBe(false);
    expect(livePollsEnabled({ livePolls: true })).toBe(true);
  });

  it("a draft needs a question and 2 to 6 distinct options", () => {
    expect(pollDraftSchema.safeParse({ question: "Which?", options: ["A", "B"] }).success).toBe(true);
    expect(pollDraftSchema.safeParse({ question: "Which?", options: ["A"] }).success).toBe(false);
    expect(pollDraftSchema.safeParse({ question: "Which?", options: ["A", "a"] }).success).toBe(false);
    expect(pollDraftSchema.safeParse({ question: "Which?", options: Array.from({ length: 7 }, (_, i) => `O${i}`) }).success).toBe(false);
    expect(pollDraftSchema.safeParse({ question: "?", options: ["A", "B"] }).success).toBe(false);
  });

  it("a vote picks the poll's own options, one unless several are allowed, no repeats", () => {
    expect(validChoices(["a"], OPTS, false)).toBe(true);
    expect(validChoices(["a", "b"], OPTS, false)).toBe(false);
    expect(validChoices(["a", "b"], OPTS, true)).toBe(true);
    expect(validChoices(["a", "a"], OPTS, true)).toBe(false);
    expect(validChoices(["z"], OPTS, false)).toBe(false);
    expect(validChoices([], OPTS, true)).toBe(false);
  });

  it("tallies voters once each and counts each chosen option", () => {
    const t = tallyPoll(OPTS, [{ choices: ["a"] }, { choices: ["a", "b"] }, { choices: ["zzz"] }]);
    expect(t).toEqual({ counts: { a: 2, b: 1, c: 0 }, voters: 3 });
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 0)).toBe(0);
  });
});
