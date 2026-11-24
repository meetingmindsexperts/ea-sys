/**
 * Abstract status-write integrity (abstracts review H1 + H2, July 10 2026).
 *
 * H1: the PUT field-only path used to write `status` blindly, so a
 * non-decision status (DRAFT / SUBMITTED — the only ones that reach it, since
 * review/terminal route to the gated service) could un-decide an ACCEPTED or
 * WITHDRAWN abstract. Now the field path refuses any status that isn't a
 * (re)submission INTO SUBMITTED or a no-op.
 * H2: create accepted the full enum, letting a submitter mint a born-ACCEPTED
 * abstract. Now it only accepts DRAFT | SUBMITTED.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, changeStatusSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    speaker: { findFirst: vi.fn() },
    track: { findFirst: vi.fn() },
    abstractTheme: { findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    abstractSubTheme: { findFirst: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  changeStatusSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb, dbOperator: mockDb,
  // Flag-off tenantTransaction IS db.$transaction — run the callback against
  // the same mock client so tx.abstract.create === mockDb.abstract.create.
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/abstract-serial", () => ({
  getNextAbstractSerialId: vi.fn().mockResolvedValue(7),
  formatAbstractSerial: (n: number | null | undefined) =>
    n == null ? "—" : `A-${String(n).padStart(3, "0")}`,
}));
// The organisation's presentation types: the five built-ins, as for an organisation that never edited them.
vi.mock("@/lib/abstract-presentation-types-server", async () => {
  const { defaultPresentationTypes } = await vi.importActual<typeof import("@/lib/abstract-presentation-types")>("@/lib/abstract-presentation-types");
  return {
    loadPresentationTypes: async () => defaultPresentationTypes(),
    loadPresentationTypesStrict: async () => defaultPresentationTypes(),
    loadPresentationTypesForEvent: async () => defaultPresentationTypes(),
  };
});
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/services/abstract-service", () => ({ changeAbstractStatus: changeStatusSpy }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockReturnValue({ catch: () => {} }) }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(), getEventTemplate: vi.fn(), getDefaultTemplate: vi.fn(),
  renderAndWrap: vi.fn(), brandingFrom: vi.fn(), brandingCc: vi.fn(),
}));

import { PUT } from "@/app/api/events/[eventId]/abstracts/[abstractId]/route";
import { POST as CREATE } from "@/app/api/events/[eventId]/abstracts/route";

const putParams = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };
const createParams = { params: Promise.resolve({ eventId: "ev1" }) };
const admin = { user: { id: "admin1", role: "ADMIN", organizationId: "org1" } };

function putReq(body: Record<string, unknown>) {
  return new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}
function createReq(body: Record<string, unknown>) {
  return new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears CALLS, not implementations — a theme count set by one
  // test would otherwise leak into every later one and fire the theme gate.
  // Default to "this event has no themes", which is the historical behaviour.
  mockDb.abstractTheme.count.mockResolvedValue(0);
  mockDb.abstractSubTheme.count.mockResolvedValue(0);
  mockAuth.mockResolvedValue(admin);
  // Open for abstracts: an author's create and submit ask (abstract-intake.ts).
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", name: "Ev", settings: { allowAbstractSubmissions: true } });
  mockDb.abstract.updateMany.mockResolvedValue({ count: 1 });
  mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", eventId: "ev1", status: "ACCEPTED", speaker: { userId: "spk" } });
  // Post-write reload (field path) — no speaker so the submission-email block
  // is skipped; the test only cares that the write path was reached.
  mockDb.abstract.findUniqueOrThrow.mockResolvedValue({ id: "ab1", status: "SUBMITTED", speaker: null, event: { name: "Ev" } });
});

describe("PUT — H1: field path refuses an arbitrary status transition", () => {
  it.each(["SUBMITTED", "DRAFT"])(
    "rejects un-deciding an ACCEPTED abstract to %s with 400 INVALID_STATUS_TRANSITION",
    async (target) => {
      const res = await PUT(putReq({ status: target }), putParams);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_STATUS_TRANSITION");
      expect(mockDb.abstract.updateMany).not.toHaveBeenCalled();
      expect(changeStatusSpy).not.toHaveBeenCalled();
    },
  );

  it("allows a genuine DRAFT → SUBMITTED (re)submission through the field path", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", eventId: "ev1", status: "DRAFT", presentationType: "ORAL", speaker: { userId: "spk" } });
    const res = await PUT(putReq({ status: "SUBMITTED" }), putParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.updateMany).toHaveBeenCalled();
  });

  it("allows a status-equal no-op re-save", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", eventId: "ev1", status: "DRAFT", speaker: { userId: "spk" } });
    const res = await PUT(putReq({ status: "DRAFT", title: "new title" }), putParams);
    expect(res.status).toBeLessThan(400);
  });

  it("still routes a real decision (ACCEPTED) to the gated service, not the field path", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", eventId: "ev1", status: "UNDER_REVIEW", speaker: { userId: "spk" } });
    changeStatusSpy.mockResolvedValue({ ok: true });
    mockDb.abstract.findFirst
      .mockResolvedValueOnce({ id: "ab1", eventId: "ev1", status: "UNDER_REVIEW", speaker: { userId: "spk" } })
      .mockResolvedValue({ id: "ab1", status: "ACCEPTED" });
    const res = await PUT(putReq({ status: "ACCEPTED" }), putParams);
    expect(changeStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "ACCEPTED" }));
    expect(res.status).toBeLessThan(400);
  });
});

describe("POST create — H2: birth status restricted to DRAFT | SUBMITTED", () => {
  beforeEach(() => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk", userId: "u", eventId: "ev1" });
    mockDb.abstract.create.mockResolvedValue({ id: "new", status: "SUBMITTED" });
  });

  it.each(["ACCEPTED", "UNDER_REVIEW", "WITHDRAWN", "REJECTED"])(
    "rejects a born-%s abstract at the Zod layer (400)",
    async (status) => {
      const res = await CREATE(createReq({ speakerId: "spk", title: "T", content: "C", status }), createParams);
      expect(res.status).toBe(400);
      expect(mockDb.abstract.create).not.toHaveBeenCalled();
    },
  );
});

/**
 * Profile hard gate (Aug 5, 2026, owner rule): a SUBMITTER cannot create or
 * submit an abstract until role/specialty/org/job title/phone/city/country
 * are filled. Staff acting on a speaker's behalf are exempt.
 */
describe("profile hard gate — PROFILE_INCOMPLETE", () => {
  const submitter = { user: { id: "spk", role: "SUBMITTER", organizationId: null } };
  const completeProfile = {
    role: "PHYSICIAN", specialty: "Cardiology", organization: "Clinic",
    jobTitle: "Consultant", phone: "+97150", city: "Dubai", country: "AE",
    bio: "Consultant cardiologist.",
  };

  beforeEach(() => {
    mockDb.abstract.create.mockResolvedValue({ id: "new", status: "DRAFT" });
  });

  it("POST by a SUBMITTER with an incomplete profile → 403 PROFILE_INCOMPLETE, no create", async () => {
    mockAuth.mockResolvedValue(submitter);
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile, jobTitle: null, country: "" });
    const res = await CREATE(createReq({ speakerId: "spk1", title: "T", content: "C", status: "DRAFT" }), createParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_INCOMPLETE");
    expect(body.missingFields).toEqual(["Job title", "Country"]);
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("POST by a SUBMITTER with a COMPLETE profile passes the gate", async () => {
    mockAuth.mockResolvedValue(submitter);
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    const res = await CREATE(createReq({ speakerId: "spk1", title: "T", content: "C", status: "DRAFT" }), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create).toHaveBeenCalled();
  });

  // ── Theme requirement (owner, Aug 7 2026) ──────────────────────────────
  // Conditional by necessity: unconditional would make submission impossible
  // on an event whose organiser created no themes.

  it("POST SUBMITTED with no theme on an event that HAS themes → 400 THEME_REQUIRED, no create", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    mockDb.abstractTheme.count.mockResolvedValue(3);
    const res = await CREATE(
      createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", status: "SUBMITTED" }),
      createParams,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("THEME_REQUIRED");
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("POST SUBMITTED with no theme on an event with NO themes proceeds", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    mockDb.abstractTheme.count.mockResolvedValue(0);
    const res = await CREATE(
      createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", status: "SUBMITTED" }),
      createParams,
    );
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create).toHaveBeenCalled();
  });

  it("a DRAFT is exempt even when the event has themes", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    mockDb.abstractTheme.count.mockResolvedValue(3);
    const res = await CREATE(
      createReq({ speakerId: "spk1", title: "T", content: "C", status: "DRAFT" }),
      createParams,
    );
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create).toHaveBeenCalled();
  });

  it("POST SUBMITTED with a theme that HAS sub-themes but none chosen → 400 SUB_THEME_REQUIRED", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    mockDb.abstractTheme.findFirst.mockResolvedValue({ id: "th1", subThemes: [{ id: "sub1" }] });
    const res = await CREATE(
      createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", themeId: "th1", status: "SUBMITTED" }),
      createParams,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SUB_THEME_REQUIRED");
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("POST SUBMITTED with a theme that has NO sub-themes proceeds", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    mockDb.abstractTheme.findFirst.mockResolvedValue({ id: "th1", subThemes: [] });
    const res = await CREATE(
      createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", themeId: "th1", status: "SUBMITTED" }),
      createParams,
    );
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create).toHaveBeenCalled();
  });

  it("a sub-theme belonging to a DIFFERENT theme is a 404, not a silent accept", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...completeProfile });
    mockDb.abstractTheme.findFirst.mockResolvedValue({ id: "th1", subThemes: [{ id: "sub1" }] });
    const res = await CREATE(
      createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", themeId: "th1", subThemeId: "sub_from_another_theme", status: "SUBMITTED" }),
      createParams,
    );
    expect(res.status).toBe(404);
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("POST by STAFF for a sparse speaker is NOT gated", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1" }); // admin default auth
    const res = await CREATE(createReq({ speakerId: "spk1", title: "T", content: "C", status: "DRAFT" }), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create).toHaveBeenCalled();
  });

  it("PUT DRAFT → SUBMITTED by a SUBMITTER with an incomplete profile → 403; a plain draft edit is NOT gated", async () => {
    mockAuth.mockResolvedValue(submitter);
    mockDb.abstract.findFirst.mockResolvedValue({
      id: "ab1", eventId: "ev1", status: "DRAFT", presentationType: "ORAL",
      speaker: { userId: "spk", ...completeProfile, phone: null },
    });
    const res = await PUT(putReq({ status: "SUBMITTED" }), putParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PROFILE_INCOMPLETE");
    expect(mockDb.abstract.updateMany).not.toHaveBeenCalled();

    // Editing the draft (no submission) stays allowed for the same person.
    const editRes = await PUT(putReq({ title: "reworked" }), putParams);
    expect(editRes.status).toBeLessThan(400);
  });

  it("PUT DRAFT → SUBMITTED by a SUBMITTER with a COMPLETE profile proceeds", async () => {
    mockAuth.mockResolvedValue(submitter);
    mockDb.abstract.findFirst.mockResolvedValue({
      id: "ab1", eventId: "ev1", status: "DRAFT", presentationType: "ORAL",
      speaker: { userId: "spk", ...completeProfile },
    });
    const res = await PUT(putReq({ status: "SUBMITTED" }), putParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.updateMany).toHaveBeenCalled();
  });
});

/**
 * Once the event has stopped taking abstracts, an AUTHOR creates and submits
 * nothing from their own portal (owner, Nov 20, 2026; abstract-intake.ts).
 * On MEHF2027 the public sign-up closed on Nov 8 and an author with an account
 * submitted three more on Nov 20.
 *
 * MUTATIONS: drop the check in POST and the first two fail; drop it in PUT and
 * the draft test fails; ask it for staff too and the staff test fails.
 */
describe("abstract intake closed: what an author can no longer do", () => {
  const submitter = { user: { id: "spk", role: "SUBMITTER", organizationId: null } };
  const profile = {
    role: "PHYSICIAN", specialty: "Cardiology", organization: "Clinic",
    jobTitle: "Consultant", phone: "+97150", city: "Dubai", country: "AE", bio: "Consultant cardiologist.",
  };
  const PAST = new Date(Date.now() - 60_000).toISOString();
  const closedBy = (settings: Record<string, unknown>) =>
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", name: "Ev", eventType: "CONFERENCE", settings });

  beforeEach(() => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", ...profile });
    mockDb.abstract.create.mockResolvedValue({ id: "new", status: "DRAFT" });
  });

  it.each([
    ["the deadline has passed", { allowAbstractSubmissions: true, abstractDeadline: PAST }, "DEADLINE_PASSED"],
    ["submissions are switched off", { allowAbstractSubmissions: false }, "SUBMISSIONS_CLOSED"],
  ])("an author cannot create an abstract, draft or submitted, when %s", async (_why, settings, code) => {
    mockAuth.mockResolvedValue(submitter);
    closedBy(settings);
    for (const status of ["DRAFT", "SUBMITTED"]) {
      const res = await CREATE(createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", status }), createParams);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe(code);
    }
    expect(mockDb.abstract.create).not.toHaveBeenCalled();
  });

  it("staff still enter an abstract after the deadline: a deliberate act on someone's behalf", async () => {
    closedBy({ allowAbstractSubmissions: true, abstractDeadline: PAST });
    const res = await CREATE(createReq({ speakerId: "spk1", title: "T", content: "C", presentationType: "ORAL", status: "SUBMITTED" }), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create).toHaveBeenCalled();
  });

  it("an author cannot submit a DRAFT after the deadline, and can still edit it", async () => {
    mockAuth.mockResolvedValue(submitter);
    closedBy({ allowAbstractSubmissions: true, abstractDeadline: PAST });
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", eventId: "ev1", status: "DRAFT", presentationType: "ORAL", speaker: { userId: "spk", ...profile } });
    const res = await PUT(putReq({ status: "SUBMITTED" }), putParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DEADLINE_PASSED");
    expect(mockDb.abstract.updateMany).not.toHaveBeenCalled();

    const edit = await PUT(putReq({ title: "reworked" }), putParams);
    expect(edit.status).toBeLessThan(400);
  });

  // Review of 74f7543b: the edit route asked the profile first, so an author
  // was sent to complete My Details and only then told the deadline had passed.
  // MUTATION: move the intake check back below the profile check and this fails.
  it("an author with an incomplete profile is told the deadline has passed, not to complete the profile", async () => {
    mockAuth.mockResolvedValue(submitter);
    closedBy({ allowAbstractSubmissions: true, abstractDeadline: PAST });
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", eventId: "ev1", status: "DRAFT", presentationType: "ORAL", speaker: { userId: "spk", ...profile, phone: null } });
    const res = await PUT(putReq({ status: "SUBMITTED" }), putParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DEADLINE_PASSED");
  });
});

/**
 * The author's requested type is kept for the record (owner, Nov 19, 2026):
 * an organiser's type changes the decision only.
 */
describe("the author's requested presentation type", () => {
  const submitted = { id: "ab1", eventId: "ev1", status: "SUBMITTED", presentationType: "ORAL", requestedPresentationType: "ORAL", speaker: { userId: "spk" } };

  it("a staff edit of a submitted abstract changes the type and keeps the request, and the history keeps the old type", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(submitted);
    mockDb.abstract.findUniqueOrThrow.mockResolvedValue({ id: "ab1", status: "SUBMITTED", presentationType: "POSTER", speaker: null, event: { name: "Ev" } });
    const res = await PUT(putReq({ presentationType: "POSTER" }), putParams);
    expect(res.status).toBeLessThan(400);
    const data = mockDb.abstract.updateMany.mock.calls[0][0].data;
    expect(data.presentationType).toBe("POSTER");
    expect(data).not.toHaveProperty("requestedPresentationType");
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      before: { presentationType: "ORAL" },
      after: { presentationType: "POSTER" },
    });
  });

  // Review of e9760ef1 (MED): the edit page sends the type on every save.
  it("a save that does not change the type writes neither column and records no type change", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(submitted);
    const res = await PUT(putReq({ title: "New title", presentationType: "ORAL" }), putParams);
    expect(res.status).toBeLessThan(400);
    const data = mockDb.abstract.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("presentationType");
    expect(data).not.toHaveProperty("requestedPresentationType");
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.before).not.toHaveProperty("presentationType");
  });

  it("the author's own draft edit moves the request with the type", async () => {
    mockAuth.mockResolvedValue({ user: { id: "spk", role: "SUBMITTER", organizationId: null } });
    mockDb.abstract.findFirst.mockResolvedValue({ ...submitted, status: "DRAFT" });
    const res = await PUT(putReq({ presentationType: "POSTER" }), putParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.updateMany.mock.calls[0][0].data).toMatchObject({ presentationType: "POSTER", requestedPresentationType: "POSTER" });
  });

  it("a type sent with a decision goes to the status service, which records it; the route does not write it again", async () => {
    changeStatusSpy.mockResolvedValue({ ok: true });
    mockDb.abstract.findFirst.mockResolvedValueOnce({ ...submitted, status: "UNDER_REVIEW" }).mockResolvedValue({ id: "ab1", status: "ACCEPTED" });
    const res = await PUT(putReq({ status: "ACCEPTED", presentationType: "POSTER" }), putParams);
    expect(res.status).toBeLessThan(400);
    expect(changeStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ newStatus: "ACCEPTED", presentationType: "POSTER" }));
    expect(mockDb.abstract.update).not.toHaveBeenCalled();
  });

  it("a new abstract records the type it was submitted with as the request", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk", userId: "u", eventId: "ev1" });
    mockDb.abstract.create.mockResolvedValue({ id: "new", status: "DRAFT" });
    const res = await CREATE(createReq({ speakerId: "spk", title: "T", content: "C", presentationType: "ORAL", status: "DRAFT" }), createParams);
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstract.create.mock.calls[0][0].data).toMatchObject({ presentationType: "ORAL", requestedPresentationType: "ORAL" });
  });
});
