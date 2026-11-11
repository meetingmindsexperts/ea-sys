/**
 * The Recipients tab's filters (src/lib/certificates/people-filter.ts): the
 * tab lists everyone at the event with a cell per certificate, and these
 * rules decide who a search and a set of filters keep. What "Not assigned"
 * means depends on whether one certificate is chosen, which is the part a
 * rewrite would get wrong.
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_PEOPLE_FILTER,
  assignmentIdsBody,
  canRemoveFromList,
  hiddenSelectionCount,
  isPeopleFilterActive,
  liveSelection,
  matchesPeopleFilter,
  speakerBucketOf,
  type FilterablePerson,
  type PeopleFilter,
} from "@/lib/certificates/people-filter";

const COLUMNS = ["day1", "day2"];

const person = (over: Partial<FilterablePerson> = {}): FilterablePerson => ({
  name: "Dr. Yara Saleh",
  email: "yara.saleh@demo.invalid",
  registrationType: "Physician",
  checkedIn: true,
  surveyAnsweredAt: "2026-11-10T14:30:00.000Z",
  noList: false,
  cells: {},
  ...over,
});
const keep = (p: FilterablePerson, f: Partial<PeopleFilter>) => matchesPeopleFilter(p, { ...EMPTY_PEOPLE_FILTER, ...f }, COLUMNS);

describe("matchesPeopleFilter", () => {
  it("with no filter, everyone is listed, assigned or not", () => {
    expect(keep(person(), {})).toBe(true);
    expect(keep(person({ cells: { day1: { state: "SENT" } } }), {})).toBe(true);
  });

  it("search matches the name or the email, whatever the case, and ignores surrounding spaces", () => {
    expect(keep(person(), { search: "  yara " })).toBe(true);
    expect(keep(person(), { search: "SALEH@DEMO" })).toBe(true);
    expect(keep(person(), { search: "omar" })).toBe(false);
    expect(keep(person({ email: null }), { search: "demo.invalid" })).toBe(false);
  });

  it("registration type, checked in and survey each narrow the list", () => {
    expect(keep(person(), { registrationType: "Physician" })).toBe(true);
    expect(keep(person(), { registrationType: "Nurse" })).toBe(false);
    expect(keep(person({ registrationType: null }), { registrationType: "Physician" })).toBe(false);

    expect(keep(person({ checkedIn: true }), { attendance: "checked-in" })).toBe(true);
    expect(keep(person({ checkedIn: false }), { attendance: "checked-in" })).toBe(false);
    expect(keep(person({ checkedIn: false }), { attendance: "not-checked-in" })).toBe(true);

    expect(keep(person(), { survey: "answered" })).toBe(true);
    expect(keep(person({ surveyAnsweredAt: null }), { survey: "answered" })).toBe(false);
    expect(keep(person({ surveyAnsweredAt: null }), { survey: "not-answered" })).toBe(true);
  });

  describe("status, with ONE certificate chosen: that certificate's cell", () => {
    const onDay1 = person({ cells: { day1: { state: "WAITING_FOR_SURVEY" } } });

    it("Not assigned means not on THAT list, even when on another", () => {
      expect(keep(onDay1, { templateId: "day2", status: "NOT_ASSIGNED" })).toBe(true);
      expect(keep(onDay1, { templateId: "day1", status: "NOT_ASSIGNED" })).toBe(false);
    });

    it("Assigned and a state are asked of that certificate only", () => {
      expect(keep(onDay1, { templateId: "day1", status: "ASSIGNED" })).toBe(true);
      expect(keep(onDay1, { templateId: "day2", status: "ASSIGNED" })).toBe(false);
      expect(keep(onDay1, { templateId: "day1", status: "WAITING_FOR_SURVEY" })).toBe(true);
      expect(keep(onDay1, { templateId: "day2", status: "WAITING_FOR_SURVEY" })).toBe(false);
      expect(keep(onDay1, { templateId: "day1", status: "SENT" })).toBe(false);
    });
  });

  describe("status, with ALL certificates: the certificates shown for this kind", () => {
    it("Not assigned means on NONE of them", () => {
      expect(keep(person(), { status: "NOT_ASSIGNED" })).toBe(true);
      expect(keep(person({ cells: { day2: { state: "READY" } } }), { status: "NOT_ASSIGNED" })).toBe(false);
    });

    it("a cell for a certificate that is not a column here does not count (a deleted or other-kind one)", () => {
      const stray = person({ cells: { appreciation: { state: "SENT" } } });
      expect(keep(stray, { status: "NOT_ASSIGNED" })).toBe(true);
      expect(keep(stray, { status: "ASSIGNED" })).toBe(false);
      expect(keep(stray, { status: "SENT" })).toBe(false);
    });

    it("Assigned means on at least one, and a state means some certificate of theirs is in it", () => {
      const mixed = person({ cells: { day1: { state: "SENT" }, day2: { state: "SENDING" } } });
      expect(keep(mixed, { status: "ASSIGNED" })).toBe(true);
      expect(keep(mixed, { status: "SENT" })).toBe(true);
      expect(keep(mixed, { status: "SENDING" })).toBe(true);
      expect(keep(mixed, { status: "READY" })).toBe(false);
    });
  });

  it("Answered, on no list is the server's flag, not a guess from the cells", () => {
    // Faculty: no attendance certificate, but their speaker record holds one. Not lost.
    const faculty = person({ noList: false, cells: {} });
    const lost = person({ noList: true, cells: {} });
    expect(keep(faculty, { status: "NO_LIST" })).toBe(false);
    expect(keep(lost, { status: "NO_LIST" })).toBe(true);
    // Whatever certificate is chosen.
    expect(keep(lost, { status: "NO_LIST", templateId: "day1" })).toBe(true);
  });

  it("filters combine: everyone checked in who answered and is not on Day 1", () => {
    const f: Partial<PeopleFilter> = { attendance: "checked-in", survey: "answered", templateId: "day1", status: "NOT_ASSIGNED" };
    expect(keep(person(), f)).toBe(true);
    expect(keep(person({ checkedIn: false }), f)).toBe(false);
    expect(keep(person({ surveyAnsweredAt: null }), f)).toBe(false);
    expect(keep(person({ cells: { day1: { state: "SENT" } } }), f)).toBe(false);
  });
});

describe("isPeopleFilterActive", () => {
  it("choosing a certificate alone narrows nothing: it only picks the column", () => {
    expect(isPeopleFilterActive(EMPTY_PEOPLE_FILTER)).toBe(false);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, templateId: "day1" })).toBe(false);
  });

  it("any other filter does, a blank search does not", () => {
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, search: "   " })).toBe(false);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, search: "y" })).toBe(true);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, status: "NOT_ASSIGNED" })).toBe(true);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, survey: "answered" })).toBe(true);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, attendance: "checked-in" })).toBe(true);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, registrationType: "Physician" })).toBe(true);
  });
});

describe("speakers: the list opens on the organisers' own faculty", () => {
  const SPEAKER_COLUMNS = ["appreciation"];
  const spk = (over: Partial<FilterablePerson>): FilterablePerson => ({
    name: "Prof. Ivan Sokolov",
    email: "ivan@demo.invalid",
    registrationType: null,
    checkedIn: false,
    surveyAnsweredAt: null,
    noList: false,
    speakerBucket: "invited",
    cells: {},
    ...over,
  });
  const keepSpk = (p: FilterablePerson, f: Partial<PeopleFilter> = {}) =>
    matchesPeopleFilter(p, { ...EMPTY_PEOPLE_FILTER, ...f }, SPEAKER_COLUMNS);

  it("each speaker is in one group: declined or cancelled first, else who they are to the event", () => {
    expect(speakerBucketOf("CONFIRMED", "invited")).toBe("invited");
    expect(speakerBucketOf("INVITED", "submitters")).toBe("submitters");
    expect(speakerBucketOf("CONFIRMED", "proposers")).toBe("proposers");
    expect(speakerBucketOf("DECLINED", "invited")).toBe("inactive");
    expect(speakerBucketOf("CANCELLED", "submitters")).toBe("inactive");
  });

  it("by default, abstract submitters, session proposers and declined speakers are NOT listed", () => {
    // The scenario: 30 faculty, 200 abstract authors, "select all", appreciation certificates to 230.
    expect(keepSpk(spk({ speakerBucket: "invited" }))).toBe(true);
    expect(keepSpk(spk({ speakerBucket: "submitters" }))).toBe(false);
    expect(keepSpk(spk({ speakerBucket: "proposers" }))).toBe(false);
    expect(keepSpk(spk({ speakerBucket: "inactive" }))).toBe(false);
  });

  it("...unless they are already on a list: the people a certificate's card counts are all shown", () => {
    const assignedAuthor = spk({ speakerBucket: "submitters", cells: { appreciation: { state: "READY" } } });
    expect(keepSpk(assignedAuthor)).toBe(true);
    expect(keepSpk(assignedAuthor, { status: "ASSIGNED" })).toBe(true);
    // A cell on a certificate that is not a column here does not count.
    expect(keepSpk(spk({ speakerBucket: "submitters", cells: { attendance: { state: "SENT" } } }))).toBe(false);
  });

  it("a group chosen on purpose lists exactly that group, and Everyone lists all", () => {
    expect(keepSpk(spk({ speakerBucket: "submitters" }), { speakers: "submitters" })).toBe(true);
    expect(keepSpk(spk({ speakerBucket: "invited" }), { speakers: "submitters" })).toBe(false);
    // On purpose means strictly: an assigned faculty member is not an abstract submitter.
    expect(keepSpk(spk({ speakerBucket: "invited", cells: { appreciation: { state: "SENT" } } }), { speakers: "submitters" })).toBe(false);
    expect(keepSpk(spk({ speakerBucket: "inactive" }), { speakers: "inactive" })).toBe(true);
    for (const bucket of ["invited", "submitters", "proposers", "inactive"] as const) {
      expect(keepSpk(spk({ speakerBucket: bucket }), { speakers: "all" })).toBe(true);
    }
  });

  it("the speakers choice never hides a registration", () => {
    expect(keep(person({ speakerBucket: null }), { speakers: "submitters" })).toBe(true);
    expect(keep(person(), { speakers: "inactive" })).toBe(true);
  });

  it("choosing another group counts as a filter that Clear filters undoes", () => {
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, speakers: "invited" })).toBe(false);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, speakers: "all" })).toBe(true);
    expect(isPeopleFilterActive({ ...EMPTY_PEOPLE_FILTER, speakers: "submitters" })).toBe(true);
  });
});

describe("the selection", () => {
  const everyone = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("only people still at the event are handed to the dialog, in the order listed", () => {
    // "gone" was ticked, then deleted or cancelled while the page was open.
    expect(liveSelection(new Set(["c", "gone", "a"]), everyone)).toEqual(["a", "c"]);
    expect(liveSelection(new Set(), everyone)).toEqual([]);
  });

  it("says how many ticked people the current search or filters do not show", () => {
    const selected = new Set(["a", "b", "c"]);
    expect(hiddenSelectionCount(selected, everyone)).toBe(0);
    // Searched for one more person: the other three ticks are out of sight, and still ticked.
    expect(hiddenSelectionCount(selected, [{ id: "d" }])).toBe(3);
    expect(hiddenSelectionCount(selected, [{ id: "a" }, { id: "d" }])).toBe(2);
    expect(hiddenSelectionCount(new Set(), [{ id: "a" }])).toBe(0);
  });

  it("attendance certificates take registration ids and appreciation ones speaker ids, never the other way", () => {
    expect(assignmentIdsBody("ATTENDANCE", ["r1", "r2"])).toEqual({ registrationIds: ["r1", "r2"] });
    expect(assignmentIdsBody("APPRECIATION", ["s1"])).toEqual({ speakerIds: ["s1"] });
  });

  it("someone who holds the certificate stays on its list; once it is revoked they can be removed", () => {
    const cert = { id: "c1" };
    expect(canRemoveFromList({ state: "WAITING_FOR_SURVEY", certificate: null })).toBe(true);
    expect(canRemoveFromList({ state: "READY", certificate: null })).toBe(true);
    expect(canRemoveFromList({ state: "SENT", certificate: cert })).toBe(false);
    expect(canRemoveFromList({ state: "ISSUED_NOT_SENT", certificate: cert })).toBe(false);
    expect(canRemoveFromList({ state: "REVOKED", certificate: cert })).toBe(true);
  });
});
