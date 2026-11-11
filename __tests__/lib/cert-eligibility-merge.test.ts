/**
 * eligibleForTemplates — the person-merged multi-template eligibility behind
 * the Issue tab multi-select (bundle model). Asserts:
 *   - per-template pools are the people ASSIGNED each template (the tag this
 *     replaced on Nov 11, 2026 is not read), asked of the database per template
 *   - cross-category entries merge into ONE person (pointer link, else email)
 *   - selection order doesn't split a person (ATTENDANCE pools seed first)
 *   - two same-category templates for one person merge
 *   - a template nobody is assigned contributes zero
 *
 * The fake database answers each pool query the way the real one would: it
 * returns only the rows assigned the template named in the query's own where,
 * so a pool query that forgot to ask for the assignment fails these tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    registration: { findMany: vi.fn() },
    speaker: { findMany: vi.fn() },
    certificateAssignment: { groupBy: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { eligibleForTemplates } from "@/lib/certificates/eligibility";

const ATT_TPL = { id: "tpl-att", name: "Attendance", category: "ATTENDANCE" as const };
const APP_TPL = { id: "tpl-app", name: "Speaker", category: "APPRECIATION" as const };
const APP_TPL2 = { id: "tpl-com", name: "Committee", category: "APPRECIATION" as const };

// Registration pool row (eligibleForAttendance select shape) + the templates it is assigned.
function regRow(id: string, email: string, assigned: string[]) {
  return { id, attendee: { title: "DR", firstName: "Jane", lastName: id, email }, assigned };
}
// Speaker pool row (eligibleForAppreciation select shape) + the templates it is assigned.
function spkPoolRow(id: string, email: string, assigned: string[]) {
  return { id, title: "DR", firstName: "Jane", lastName: id, email, assigned };
}

type PoolWhere = { certificateAssignments?: { some?: { certificateTemplateId?: string } } };
/** The template a pool query asked for; undefined when it did not ask at all. */
const askedTemplate = (where: PoolWhere | undefined) => where?.certificateAssignments?.some?.certificateTemplateId;

/** Wire the db mocks: registration.findMany answers the ATTENDANCE pool of the
 *  template asked for; speaker.findMany routes by select shape (link query vs
 *  pool query) and answers the APPRECIATION pool the same way. */
function wire(opts: {
  registrations?: ReturnType<typeof regRow>[];
  speakers?: ReturnType<typeof spkPoolRow>[];
  links?: Array<{ id: string; email: string | null; sourceRegistrationId: string | null }>;
}) {
  mockDb.registration.findMany.mockImplementation((args: { where?: PoolWhere }) => {
    const templateId = askedTemplate(args?.where);
    return Promise.resolve((opts.registrations ?? []).filter((r) => templateId && r.assigned.includes(templateId)));
  });
  mockDb.speaker.findMany.mockImplementation((args: { where?: PoolWhere; select?: Record<string, unknown> }) => {
    if (args?.select?.sourceRegistrationId) return Promise.resolve(opts.links ?? []);
    const templateId = askedTemplate(args?.where);
    return Promise.resolve((opts.speakers ?? []).filter((s) => templateId && s.assigned.includes(templateId)));
  });
  mockDb.certificateAssignment.groupBy.mockImplementation((args: { where: { certificateTemplateId: { in: string[] } } }) =>
    Promise.resolve(
      args.where.certificateTemplateId.in.map((id) => ({
        certificateTemplateId: id,
        _count: {
          _all:
            (opts.registrations ?? []).filter((r) => r.assigned.includes(id)).length +
            (opts.speakers ?? []).filter((s) => s.assigned.includes(id)).length,
        },
      })),
    ),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("eligibleForTemplates", () => {
  it("merges a cross-category person via the companion pointer — one entry, both facets", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["tpl-att"])],
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["tpl-app"])],
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
      registrations: [regRow("reg-1", "Jane@X.com", ["tpl-att"])],
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["tpl-app"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: null }],
    });
    // Email keys are lowercased on both sides.
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].speakerId).toBe("spk-1");
  });

  it("does not depend on selection order — APPRECIATION listed first still merges", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["tpl-att"])],
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["tpl-app"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: "reg-1" }],
    });
    const res = await eligibleForTemplates("evt-1", [APP_TPL, ATT_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].templateIds.sort()).toEqual(["tpl-app", "tpl-att"]);
  });

  it("keeps an unlinked speaker as a separate single-facet person", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["tpl-att"])],
      speakers: [spkPoolRow("spk-2", "bob@x.com", ["tpl-app"])],
      links: [{ id: "spk-2", email: "bob@x.com", sourceRegistrationId: null }],
    });
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(2);
    const bob = res.people.find((p) => p.speakerId === "spk-2");
    expect(bob).toMatchObject({ registrationId: null, templateIds: ["tpl-app"] });
  });

  it("merges two same-category templates for the same speaker into one person", async () => {
    // The same speaker is assigned both templates.
    wire({
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["tpl-app", "tpl-com"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: null }],
    });
    const res = await eligibleForTemplates("evt-1", [APP_TPL, APP_TPL2]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0].templateIds.sort()).toEqual(["tpl-app", "tpl-com"]);
  });

  it("a template nobody is assigned contributes zero people, whoever else is assigned something", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["tpl-att"])],
      links: [],
    });
    const res = await eligibleForTemplates("evt-1", [{ id: "tpl-other", name: "Other", category: "ATTENDANCE" }]);
    expect(res.people).toHaveLength(0);
    expect(res.perTemplate[0]).toMatchObject({ templateId: "tpl-other", count: 0, assigned: 0 });
  });

  it("asks each pool for ITS template's assignments, leaves out cancelled registrations and people who already hold it", async () => {
    wire({ registrations: [regRow("reg-1", "jane@x.com", ["tpl-att"])], links: [] });
    await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(mockDb.registration.findMany.mock.calls[0][0].where).toEqual({
      eventId: "evt-1",
      status: { not: "CANCELLED" },
      certificateAssignments: { some: { certificateTemplateId: "tpl-att" } },
      issuedCertificates: { none: { certificateTemplateId: "tpl-att" } },
    });
    const speakerPool = mockDb.speaker.findMany.mock.calls.find((c) => !c[0].select?.sourceRegistrationId)![0];
    expect(speakerPool.where).toEqual({
      eventId: "evt-1",
      certificateAssignments: { some: { certificateTemplateId: "tpl-app" } },
      issuedCertificates: { none: { certificateTemplateId: "tpl-app" } },
    });
  });

  it("reports how many are assigned beside how many this run would issue", async () => {
    wire({
      registrations: [regRow("reg-1", "jane@x.com", ["tpl-att"]), regRow("reg-2", "sam@x.com", ["tpl-att"])],
      links: [],
    });
    const res = await eligibleForTemplates("evt-1", [ATT_TPL]);
    expect(res.perTemplate[0]).toMatchObject({ templateId: "tpl-att", count: 2, assigned: 2 });
  });

  it("only merges the speaker into a registration person that is IN the set", async () => {
    // Speaker's companion reg exists but ISN'T eligible for any template:
    // the speaker stays a single-facet person (never phantom-links).
    wire({
      registrations: [], // ATTENDANCE pool empty
      speakers: [spkPoolRow("spk-1", "jane@x.com", ["tpl-app"])],
      links: [{ id: "spk-1", email: "jane@x.com", sourceRegistrationId: "reg-9" }],
    });
    const res = await eligibleForTemplates("evt-1", [ATT_TPL, APP_TPL]);
    expect(res.people).toHaveLength(1);
    expect(res.people[0]).toMatchObject({ registrationId: null, speakerId: "spk-1" });
  });
});
