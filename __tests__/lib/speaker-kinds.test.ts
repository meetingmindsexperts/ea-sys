/**
 * The Speakers page tabs (owner, Oct 27) and who "Email" reaches from them (review HIGHs, Oct 27).
 */
import { describe, it, expect } from "vitest";
import { acceptedWithoutRegistration, canEmailListed, emailRecipientIds, isProposer, isSubmitter, matchesKind, openingKind, registrationOnFacultyType, speakerKindOf } from "@/lib/speaker-kinds";

const invited = { id: "a", abstracts: [] as { status: string }[] };
const submitter = { id: "b", abstracts: [{ status: "SUBMITTED" }, { status: "DRAFT" }] };

describe("speaker kinds", () => {
  it("a speaker with an abstract is a submitter; the tabs split on that", () => {
    expect(isSubmitter(submitter)).toBe(true);
    expect(isSubmitter(invited)).toBe(false);
    expect([invited, submitter].filter((s) => matchesKind(s, "invited")).map((s) => s.id)).toEqual(["a"]);
    expect([invited, submitter].filter((s) => matchesKind(s, "submitters")).map((s) => s.id)).toEqual(["b"]);
    expect([invited, submitter].filter((s) => matchesKind(s, "all"))).toHaveLength(2);
  });

  it("a session proposer has a submitted proposal and no submitted abstract; an abstract wins (Oct 27)", () => {
    expect(speakerKindOf({ abstracts: [], sessionProposals: [{ status: "SUBMITTED" }] })).toBe("proposers");
    expect(speakerKindOf({ abstracts: [], sessionProposals: [{ status: "DRAFT" }, { status: "WITHDRAWN" }] })).toBe("invited");
    expect(speakerKindOf({ abstracts: [{ status: "ACCEPTED" }], sessionProposals: [{ status: "SUBMITTED" }] })).toBe("submitters");
    expect(isProposer({ abstracts: [{ status: "DRAFT" }], sessionProposals: [{ status: "SUBMITTED" }] })).toBe(true);
    expect(speakerKindOf({ abstracts: [] })).toBe("invited");
    const proposer = { id: "p", abstracts: [], sessionProposals: [{ status: "SUBMITTED" }] };
    expect([invited, submitter, proposer].filter((s) => matchesKind(s, "proposers")).map((s) => s.id)).toEqual(["p"]);
    expect([invited, submitter, proposer].filter((s) => matchesKind(s, "invited")).map((s) => s.id)).toEqual(["a"]);
  });

  it("only a draft or a withdrawn abstract does not make an invited speaker a submitter (review MED)", () => {
    expect(isSubmitter({ abstracts: [{ status: "DRAFT" }] })).toBe(false);
    expect(isSubmitter({ abstracts: [{ status: "WITHDRAWN" }, { status: "DRAFT" }] })).toBe(false);
    for (const status of ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED", "ACCEPTED", "REJECTED"]) expect(isSubmitter({ abstracts: [{ status }] })).toBe(true);
  });
});

describe("sign-ups who have submitted nothing (MEHF 2027, Oct 27)", () => {
  it("go to the tab of the door they came through, never Invited", () => {
    expect(speakerKindOf({ abstracts: [], submitterSource: "abstract" })).toBe("submitters");
    expect(speakerKindOf({ abstracts: [{ status: "DRAFT" }], submitterSource: "both" })).toBe("submitters");
    expect(speakerKindOf({ abstracts: [], sessionProposals: [], submitterSource: "proposal" })).toBe("proposers");
  });

  it("speakers the organisers added stay invited, and so does a sign-up they put on the programme", () => {
    expect(speakerKindOf({ abstracts: [], submitterSource: null })).toBe("invited");
    expect(speakerKindOf({ abstracts: [{ status: "DRAFT" }] })).toBe("invited");
    expect(speakerKindOf({ abstracts: [], submitterSource: "abstract", _count: { sessions: 2 } })).toBe("invited");
    expect(speakerKindOf({ abstracts: [], submitterSource: "proposal", _count: { sessions: 0, topicSpeakers: 1 } })).toBe("invited");
  });

  it("a submission still decides first, whatever the door", () => {
    expect(speakerKindOf({ abstracts: [{ status: "SUBMITTED" }], submitterSource: "proposal" })).toBe("submitters");
    expect(speakerKindOf({ abstracts: [], sessionProposals: [{ status: "SUBMITTED" }], submitterSource: "abstract" })).toBe("proposers");
  });
});

// Owner, Nov 20, 2026: authors are kept apart from the faculty "except for those who are invited and submitted,
// and submitted and later got invited".
describe("invited and an author", () => {
  it("on the Faculty type they are listed with the invited speakers, whatever they submitted and whichever door", () => {
    expect(speakerKindOf({ abstracts: [{ status: "ACCEPTED" }], submitterSource: null, onFacultyType: true })).toBe("invited");
    expect(speakerKindOf({ abstracts: [{ status: "SUBMITTED" }], submitterSource: "abstract", onFacultyType: true })).toBe("invited");
    expect(speakerKindOf({ abstracts: [], sessionProposals: [{ status: "SUBMITTED" }], submitterSource: "proposal", onFacultyType: true })).toBe("invited");
    expect(speakerKindOf({ abstracts: [], submitterSource: "abstract", onFacultyType: true })).toBe("invited");
  });

  // Review of 8eaa3550 (MED): the sign-up door says nothing about someone who submitted. It is stamped on an
  // invited speaker's record when they sign in to submit, and absent on a record staff made to enter an abstract.
  it("off the Faculty type a submission decides, whether or not a sign-up door is on the record", () => {
    expect(speakerKindOf({ abstracts: [{ status: "ACCEPTED" }], submitterSource: null, onFacultyType: false })).toBe("submitters");
    expect(speakerKindOf({ abstracts: [{ status: "ACCEPTED" }], submitterSource: null })).toBe("submitters");
    expect(speakerKindOf({ abstracts: [{ status: "SUBMITTED" }], submitterSource: "abstract" })).toBe("submitters");
    // A caller who may not read the sign-up door is not told "invited" by its absence.
    expect(speakerKindOf({ abstracts: [{ status: "SUBMITTED" }] })).toBe("submitters");
  });

  it("the registration a speaker record points at is on the Faculty type only while it is live", () => {
    expect(registrationOnFacultyType({ status: "CONFIRMED", ticketType: { isFaculty: true } })).toBe(true);
    expect(registrationOnFacultyType({ status: "CANCELLED", ticketType: { isFaculty: true } })).toBe(false);
    expect(registrationOnFacultyType({ status: "CONFIRMED", ticketType: { isFaculty: false } })).toBe(false);
    expect(registrationOnFacultyType({ status: "CONFIRMED", ticketType: null })).toBe(false);
    expect(registrationOnFacultyType(null)).toBe(false);
  });
});

describe("the Speakers page: opening tab and the accepted authors with no registration", () => {
  it("opens on the invited speakers when the event also has authors or proposers, else on everyone", () => {
    expect(openingKind(["all", "invited", "submitters"])).toBe("invited");
    expect(openingKind(["all", "invited", "proposers"])).toBe("invited");
    expect(openingKind(["all", "invited"])).toBe("all");
    expect(openingKind(["all"])).toBe("all");
    // Without the Invited tab (the caller cannot see what tells the groups apart) there is nothing to open on.
    expect(openingKind(["all", "submitters"])).toBe("all");
  });

  it("counts an accepted author only when told they hold no registration", () => {
    expect(acceptedWithoutRegistration({ hasRegistration: false, abstracts: [{ status: "ACCEPTED" }] })).toBe(true);
    expect(acceptedWithoutRegistration({ hasRegistration: true, abstracts: [{ status: "ACCEPTED" }] })).toBe(false);
    expect(acceptedWithoutRegistration({ hasRegistration: false, abstracts: [{ status: "REJECTED" }, { status: "SUBMITTED" }] })).toBe(false);
    // Not told (no registrations key, or no abstracts key): never counted.
    expect(acceptedWithoutRegistration({ abstracts: [{ status: "ACCEPTED" }] })).toBe(false);
    expect(acceptedWithoutRegistration({ hasRegistration: false })).toBe(false);
  });
});

describe("who Email reaches", () => {
  it("ticked speakers first, else everyone listed on a tab, else the status-wide audience (no ids)", () => {
    expect(emailRecipientIds(new Set(["x"]), true, [invited])).toEqual(["x"]);
    expect(emailRecipientIds(new Set(), true, [invited, submitter])).toEqual(["a", "b"]);
    expect(emailRecipientIds(new Set(), false, [invited, submitter])).toEqual([]);
  });

  it("offers no send from an empty tab, where no ids would mean every speaker of the status", () => {
    expect(canEmailListed(0, true, 0, 136)).toBe(false);
    expect(canEmailListed(0, true, 3, 136)).toBe(true);
    expect(canEmailListed(2, true, 0, 136)).toBe(true);
    expect(canEmailListed(0, false, 0, 136)).toBe(true);
    expect(canEmailListed(0, false, 0, 0)).toBe(false);
  });
});
