/**
 * eligibleForTemplates — the person-merged multi-template eligibility behind
 * the Issue tab multi-select (bundle model). Asserts:
 *   - per-template pools come from each template's STORED tag
 *   - cross-category entries merge into ONE person (pointer link, else email)
 *   - selection order doesn't split a person (ATTENDANCE pools seed first)
 *   - two same-category templates for one person merge
 *   - tagless templates contribute zero
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    registration: { findMany: vi.fn() },
    speaker: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { eligibleForTemplates } from "@/lib/certificates/eligibility";

const ATT_TPL = { id: "tpl-att", name: "Attendance", category: "ATTENDANCE" as const, autoIssueTag: "attended" };
const APP_TPL = { id: "tpl-app", name: "Speaker", category: "APPRECIATION" as const, autoIssueTag: "speaker" };
const APP_TPL2 = { id: "tpl-com", name: "Committee", category: "APPRECIATION" as const, autoIssueTag: "committee" };

// Registration pool row (eligibleForAttendance select shape).
function regRow(id: string, email: string, tags: string[]) {
  return { id, attendee: { title: "DR", firstName: "Jane", lastName: id, email, tags } };
}
// Speaker pool row (eligibleForAppreciation select shape).
function spkPoolRow(id: string, email: string, tags: string[]) {
  return { id, title: "DR", firstName: "Jane", lastName: id, email, tags };
}

/** Wire the db mocks: registration.findMany → the ATTENDANCE pool;
 *  speaker.findMany routes by select shape (link query vs pool query). */
function wire(opts: {
  registrations?: ReturnType<typeof regRow>[];
  speakers?: ReturnType<typeof spkPoolRow>[];
  links?: Array<{ id: string; email: string | null; sourceRegistrationId: string | null }>;
}) {
  mockDb.registration.findMany.mockResolvedValue(opts.registrations ?? []);
  mockDb.speaker.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
    if (args?.select?.sourceRegistrationId) return Promise.resolve(opts.links ?? []);
    return Promise.resolve(opts.speakers ?? []);
  });
}

beforeEach(() => vi.clearAllMocks());

describe("eligibleForTemplates", () => {
  it("merges a cross-category person via the companion pointer — one entry, both facets", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["attended"])],
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["speaker"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: "reg-1" }],
    });
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0]).toMatchObject({
      registrationId: "reg-1",
      speakerId: "spk-1",
      templateIds: ["tpl-att", "tpl-app"],
    });
    expect(res.perTemplate.map((p) => p.count)).toEqual([1, 1]);
  });

  it("merges via email match when there is no pointer", async () => {
    wire({
      registrations: [regRow("reg-1", "Jane@X.com", ["attended"])],
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["speaker"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: null }],
    });
    // Email keys are lowercased on both sides.
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].speakerId).toBe("spk-1");
  });

  it("does not depend on selection order — APPRECIATION listed first still merges", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["attended"])],
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["speaker"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: "reg-1" }],
    });
    const res = await eligibleForTemplates("evt-1", [APP_TPL, ATT_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].templateIds.sort()).toEqual(["tpl-app", "tpl-att"]);
  });

  it("keeps an unlinked speaker as a separate single-facet person", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["attended"])],
      speakers: [spkPoolRow("spk-2", "bob@x.com", ["speaker"])],
      links: [{ id: "spk-2", email: "bob@x.com", sourceRegistrationId: null }],
    });
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(2);
    const bob = res.people.find((p) => p.speakerId === "spk-2");
    expect(bob).toMatchObject({ registrationId: null, templateIds: ["tpl-app"] });
  });

  it("merges two same-category templates for the same speaker into one person", async () => {
    mockDb.registration.findMany.mockResolvedValue([]);
    // Pool differs per template tag — same speaker holds both tags.
    mockDb.speaker.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      if (args?.select?.sourceRegistrationId) {
        return Promise.resolve([{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: null }]);
      }
      return Promise.resolve([spkPoolRow("spk-1", "jane@x.com", ["speaker", "committee"])]);
    });
    const res = await eligibleForTemplates("evt-1", [APP_TPL, APP_TPL2]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].templateIds.sort()).toEqual(["tpl-app", "tpl-com"]);
  });

  it("a tagless template contributes zero people", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["attended"])],
      links: [],
    });
    const res = await eligibleForTemplates("evt-1", [{ ...ATT_TPL, autoIssueTag: null }]);
    expect(res.people).toHaveLength(0);
    expect(res.perTemplate[0]).toMatchObject({ templateId: "tpl-att", tag: null, count: 0 });
  });

  it("only merges the speaker into a registration person that is IN the set", async () => {
    // Speaker's companion reg exists but ISN'T eligible for any template —
    // the speaker stays a single-facet person (never phantom-links).
    wire({
      registrations: [], // ATTENDANCE pool empty
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["speaker"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: "reg-9" }],
    });
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0]).toMatchObject({ registrationId: null, speakerId: "spk-1" });
  });
});
