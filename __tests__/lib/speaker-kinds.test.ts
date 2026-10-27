/**
 * The Speakers page tabs (owner, Oct 27) and who "Email" reaches from them (review HIGHs, Oct 27).
 */
import { describe, it, expect } from "vitest";
import { canEmailListed, emailRecipientIds, isProposer, isSubmitter, matchesKind, speakerKindOf } from "@/lib/speaker-kinds";

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
