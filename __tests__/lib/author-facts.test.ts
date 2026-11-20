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

/** A speaker record as the reader selects it. */
const speaker = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id, email, sourceRegistrationId: null, submitterSource: null, abstracts: [], sessionProposals: [], sessions: [], _count: { topicSpeakers: 0 }, ...over,
});
const abstract = (status: string, over: Record<string, unknown> = {}) => ({ status, eventSession: null, sessionTopic: null, ...over });
const reg = (id: string, email: string, over: Record<string, unknown> = {}) => ({ id, status: "CONFIRMED", createdSource: "PUBLIC_REGISTER", attendee: { email }, ...over });

describe("loadAuthorFacts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers per registration in one query for the event", async () => {
    findMany.mockResolvedValue([
      speaker("s1", "presenter@x.com", { sourceRegistrationId: "r-presenter", submitterSource: "abstract", abstracts: [abstract("ACCEPTED")] }),
      speaker("s2", "faculty@x.com", { sourceRegistrationId: "r-faculty", sessions: [{ session: { status: "SCHEDULED" } }] }),
      speaker("s3", "invited@x.com", { sourceRegistrationId: "r-invited" }),
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1" });
    // An author is not "a speaker" for having a speaker record: the Speakers page's own rule.
    expect(factsFor(reg("r-presenter", "presenter@x.com"))).toEqual({ abstractOutcome: "accepted", speakerPlace: null });
    expect(factsFor(reg("r-faculty", "faculty@x.com"))).toEqual({ abstractOutcome: null, speakerPlace: "programme" });
    expect(factsFor(reg("r-invited", "invited@x.com"))).toEqual({ abstractOutcome: null, speakerPlace: "record" });
    expect(factsFor(reg("r-delegate", "delegate@x.com"))).toEqual({ abstractOutcome: null, speakerPlace: null });
  });

  // Review of b4493d67 (HIGH): nothing links a speaker to a registration made
  // afterwards (the public form, Add Registration), so the pointer alone
  // called an accepted author "No abstract".
  it("an author who registered AFTER signing up is found by their address, whatever its case", async () => {
    findMany.mockResolvedValue([speaker("s1", "Late.Author@X.com", { submitterSource: "abstract", abstracts: [abstract("ACCEPTED")] })]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r-late", "late.author@x.com"))).toEqual({ abstractOutcome: "accepted", speakerPlace: null });
    // A look-alike address is another person: the match is exact, never a pattern.
    expect(factsFor(reg("r-other", "late_author@x.com")).abstractOutcome).toBeNull();
  });

  it("a cancelled registration carries nothing, even where an old pointer still names it; the person's live one does", async () => {
    findMany.mockResolvedValue([speaker("s1", "a@x.com", { sourceRegistrationId: "r-cancelled", abstracts: [abstract("ACCEPTED")] })]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r-cancelled", "a@x.com", { status: "CANCELLED" }))).toEqual({ abstractOutcome: null, speakerPlace: null });
    expect(factsFor(reg("r-new", "a@x.com")).abstractOutcome).toBe("accepted");
  });

  it("a record found by its pointer and by its address counts once; two records of one person both count", async () => {
    findMany.mockResolvedValue([
      speaker("s1", "a@x.com", { sourceRegistrationId: "r1", abstracts: [abstract("REJECTED")] }),
      speaker("s2", "other@x.com", { sourceRegistrationId: "r1", abstracts: [abstract("ACCEPTED")] }),
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r1", "a@x.com")).abstractOutcome).toBe("accepted");
  });

  // Review of b4493d67 (MED): an accepted abstract is placed on the agenda by
  // its own id, with no speaker row for its author.
  it("on the programme: a session or topic role, or an accepted abstract placed on the agenda; never a cancelled session", async () => {
    findMany.mockResolvedValue([
      speaker("s1", "oral@x.com", { submitterSource: "abstract", abstracts: [abstract("ACCEPTED", { sessionTopic: { id: "t1" } })] }),
      speaker("s2", "session@x.com", { submitterSource: "abstract", abstracts: [abstract("ACCEPTED", { eventSession: { status: "SCHEDULED" } })] }),
      speaker("s3", "topic@x.com", { _count: { topicSpeakers: 1 } }),
      speaker("s4", "gone@x.com", { sessions: [{ session: { status: "CANCELLED" } }] }),
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r1", "oral@x.com")).speakerPlace).toBe("programme");
    expect(factsFor(reg("r2", "session@x.com")).speakerPlace).toBe("programme");
    expect(factsFor(reg("r3", "topic@x.com")).speakerPlace).toBe("programme");
    // Invited by the organisers, their only session cancelled: invited, not on the programme.
    expect(factsFor(reg("r4", "gone@x.com")).speakerPlace).toBe("record");
  });

  // Found by running the whole journey (Nov 20, 2026), and the owner's rule:
  // authors are kept apart "except those who are invited and submitted".
  it("an invited speaker who also submitted is still an invited speaker; so is anyone on the Faculty type", async () => {
    findMany.mockResolvedValue([
      // The organisers made her record (no sign-up door on it); she has an accepted abstract.
      speaker("s1", "invited@x.com", { sourceRegistrationId: "r1", abstracts: [abstract("ACCEPTED")] }),
      // Invited first, then used the abstract door (which stamps it): still on the Faculty type.
      speaker("s2", "stamped@x.com", { sourceRegistrationId: "r2", submitterSource: "abstract", abstracts: [abstract("SUBMITTED")] }),
      // Only ever an author.
      speaker("s3", "author@x.com", { sourceRegistrationId: "r3", submitterSource: "abstract", abstracts: [abstract("ACCEPTED")] }),
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r1", "invited@x.com", { ticketType: { isFaculty: true } }))).toEqual({ abstractOutcome: "accepted", speakerPlace: "record" });
    expect(factsFor(reg("r2", "stamped@x.com", { ticketType: { isFaculty: true } })).speakerPlace).toBe("record");
    expect(factsFor(reg("r3", "author@x.com", { ticketType: { isFaculty: false } })).speakerPlace).toBeNull();
    // A delegate on the Faculty type by mistake, with no speaker record at all, is not made a speaker by it.
    expect(factsFor(reg("r4", "nobody@x.com", { ticketType: { isFaculty: true } })).speakerPlace).toBeNull();
  });

  // Review of 8eaa3550 (MED): "the organisers made the record" was read from the sign-up door being absent.
  // The door is stamped on an invited speaker's record the moment they sign in to submit, and is absent on a
  // record staff made only to enter an author's abstract. For someone who submitted, the type alone decides.
  it("for someone who submitted, only the Faculty type says invited: never the sign-up door on the record", async () => {
    findMany.mockResolvedValue([
      // Staff made the record to enter this author's abstract; she is on a delegate type.
      speaker("s1", "entered@x.com", { sourceRegistrationId: "r1", abstracts: [abstract("SUBMITTED")] }),
      // Staff made the record, nothing submitted: invited, as always.
      speaker("s2", "invited@x.com", { sourceRegistrationId: "r2" }),
      // A session proposer the organisers then granted a Faculty registration.
      speaker("s3", "proposer@x.com", { sourceRegistrationId: "r3", submitterSource: "proposal", sessionProposals: [{ status: "SUBMITTED" }] }),
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r1", "entered@x.com", { ticketType: { isFaculty: false } }))).toEqual({ abstractOutcome: "awaiting", speakerPlace: null });
    expect(factsFor(reg("r2", "invited@x.com", { ticketType: { isFaculty: false } })).speakerPlace).toBe("record");
    expect(factsFor(reg("r3", "proposer@x.com", { ticketType: { isFaculty: true } })).speakerPlace).toBe("record");
    expect(factsFor(reg("r3", "proposer@x.com", { ticketType: { isFaculty: false } })).speakerPlace).toBeNull();
  });

  // Review of b4493d67 (MED): the sign-up is the PERSON's, not the registration's.
  it("'nothing submitted' follows the door the person came through, whatever made their registration", async () => {
    findMany.mockResolvedValue([
      speaker("s1", "delegate-first@x.com", { sourceRegistrationId: "r1", submitterSource: "abstract" }),
      speaker("s2", "both@x.com", { sourceRegistrationId: "r2", submitterSource: "both" }),
      speaker("s3", "proposer@x.com", { sourceRegistrationId: "r3", submitterSource: "proposal" }),
    ]);
    const factsFor = await loadAuthorFacts("ev1");
    expect(factsFor(reg("r1", "delegate-first@x.com")).abstractOutcome).toBe("none-submitted");
    expect(factsFor(reg("r2", "both@x.com", { createdSource: "SPEAKER_COMPANION" })).abstractOutcome).toBe("none-submitted");
    // A session proposer never signed up to submit an abstract.
    expect(factsFor(reg("r3", "proposer@x.com")).abstractOutcome).toBeNull();
    // An abstract sign-up registration with no speaker record at all still counts.
    expect(factsFor(reg("r4", "nobody@x.com", { createdSource: "PUBLIC_SUBMITTER" })).abstractOutcome).toBe("none-submitted");
  });
});
