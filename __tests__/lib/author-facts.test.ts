/**
 * What a registration's person is in the scientific programme, read and never
 * stored (owner, Nov 20, 2026; docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md §4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { speaker: { findMany } } }));

import { abstractOutcomeOf, matchesAbstractFilter, matchesSpeakerFilter, isAbstractFilter, isSpeakerFilter } from "@/lib/author-facts";
import { loadAuthorFacts } from "@/lib/author-facts-server";

describe("abstractOutcomeOf", () => {
  it("one accepted abstract makes a presenter, whatever became of the others", () => {
    expect(abstractOutcomeOf(["REJECTED", "ACCEPTED", "SUBMITTED"], false)).toBe("accepted");
  });

  it("awaiting beats rejected: a decision is still to come", () => {
    expect(abstractOutcomeOf(["REJECTED", "UNDER_REVIEW"], false)).toBe("awaiting");
    expect(abstractOutcomeOf(["REVISION_REQUESTED"], false)).toBe("awaiting");
    expect(abstractOutcomeOf(["SUBMITTED"], false)).toBe("awaiting");
  });

  it("rejected only when every submitted abstract was", () => {
    expect(abstractOutcomeOf(["REJECTED", "DRAFT"], false)).toBe("rejected");
  });

  it("drafts, withdrawn abstracts or an abstract sign-up with nothing yet are 'nothing submitted'", () => {
    expect(abstractOutcomeOf(["DRAFT"], false)).toBe("none-submitted");
    expect(abstractOutcomeOf(["WITHDRAWN"], false)).toBe("none-submitted");
    expect(abstractOutcomeOf([], true)).toBe("none-submitted");
  });

  it("no abstract and no abstract sign-up is nobody's author", () => {
    expect(abstractOutcomeOf([], false)).toBeNull();
  });
});

describe("the filters", () => {
  it("no filter passes everything; 'none' is the people with no fact", () => {
    expect(matchesAbstractFilter("accepted", null)).toBe(true);
    expect(matchesAbstractFilter(null, "none")).toBe(true);
    expect(matchesAbstractFilter(undefined, "none")).toBe(true);
    expect(matchesAbstractFilter("rejected", "none")).toBe(false);
    expect(matchesAbstractFilter("rejected", "rejected")).toBe(true);
    expect(matchesAbstractFilter("awaiting", "accepted")).toBe(false);
    expect(matchesSpeakerFilter("programme", "programme")).toBe(true);
    expect(matchesSpeakerFilter("record", "programme")).toBe(false);
    expect(matchesSpeakerFilter(null, "none")).toBe(true);
    expect(matchesSpeakerFilter("record", null)).toBe(true);
  });

  it("only the listed values are filters", () => {
    expect(isAbstractFilter("accepted")).toBe(true);
    expect(isAbstractFilter("ACCEPTED")).toBe(false);
    expect(isSpeakerFilter("programme")).toBe(true);
    expect(isSpeakerFilter("faculty")).toBe(false);
  });
});

describe("loadAuthorFacts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers per registration from the LINKED speaker record, in one query for the event", async () => {
    findMany.mockResolvedValue([
      { sourceRegistrationId: "r-presenter", abstracts: [{ status: "ACCEPTED" }], _count: { sessions: 0, topicSpeakers: 0 } },
      { sourceRegistrationId: "r-faculty", abstracts: [], _count: { sessions: 2, topicSpeakers: 0 } },
      { sourceRegistrationId: "r-both", abstracts: [{ status: "REJECTED" }], _count: { sessions: 0, topicSpeakers: 1 } },
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", sourceRegistrationId: { not: null } });
    expect(factsFor({ id: "r-presenter", createdSource: "PUBLIC_SUBMITTER" })).toEqual({ abstractOutcome: "accepted", speakerPlace: "record" });
    expect(factsFor({ id: "r-faculty", createdSource: "SPEAKER_COMPANION" })).toEqual({ abstractOutcome: null, speakerPlace: "programme" });
    expect(factsFor({ id: "r-both", createdSource: "SPEAKER_COMPANION" })).toEqual({ abstractOutcome: "rejected", speakerPlace: "programme" });
  });

  it("a delegate with no speaker record has no facts; an abstract sign-up with no abstract yet is 'nothing submitted'", async () => {
    findMany.mockResolvedValue([]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor({ id: "r-delegate", createdSource: "PUBLIC_REGISTER" })).toEqual({ abstractOutcome: null, speakerPlace: null });
    expect(factsFor({ id: "r-signed-up", createdSource: "PUBLIC_SUBMITTER" })).toEqual({ abstractOutcome: "none-submitted", speakerPlace: null });
  });
});
