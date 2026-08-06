/**
 * Session proposals v1 (July 30, 2026) — route-level RBAC + lifecycle.
 *
 * The rules that matter (mirroring abstracts): a SUBMITTER acts only on their
 * OWN speaker's proposals and only while DRAFT (SUBMITTED_LOCKED after);
 * birth status is DRAFT|SUBMITTED only; DRAFTs are invisible to organizers;
 * proposed format must be a PROGRAM session kind; CSV export is org-staff
 * only + audited; themes GET is readable by linked submitters (the form's
 * theme picker) while theme writes stay org-staff.
 *
 * denyReviewer + buildEventAccessWhere run REAL (pure libs) — the tests pin
 * the actual boundary, not a mock of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, notifySpy, recordExportSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
    sessionProposal: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    sessionProposalTheme: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  notifySpy: vi.fn(),
  recordExportSpy: vi.fn(),
}));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    private _body: string;
    headers: { get: (k: string) => string | null; set: (k: string, v: string) => void };
    constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
      this._body = body;
      this.status = init?.status ?? 200;
      const h: Record<string, string> = { ...(init?.headers ?? {}) };
      this.headers = { get: (k) => h[k] ?? null, set: (k, v) => { h[k] = v; } };
    }
    async text() { return this._body; }
    static json(b: unknown, i?: { status?: number }) {
      return {
        status: i?.status ?? 200,
        json: async () => b,
        headers: { get: () => null, set: () => {} },
      };
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  // Flag-off tenantTransaction IS db.$transaction — run the callback against
  // the same mock client so tx.sessionProposal.create === mockDb create.
  tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb),
}));
vi.mock("@/lib/session-proposal-serial", () => ({
  getNextSessionProposalSerialId: vi.fn().mockResolvedValue(7),
  formatSessionProposalSerial: (n: number | null | undefined) =>
    n == null ? "—" : `S-${String(n).padStart(3, "0")}`,
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/session-proposal-notify", () => ({ notifySessionProposalSubmitted: notifySpy }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: recordExportSpy }));

import { GET as LIST, POST as CREATE } from "@/app/api/events/[eventId]/session-proposals/route";
import { GET as GET_ONE, PUT, DELETE } from "@/app/api/events/[eventId]/session-proposals/[proposalId]/route";
import { GET as THEMES_LIST, POST as THEMES_CREATE } from "@/app/api/events/[eventId]/session-proposal-themes/route";

const listParams = { params: Promise.resolve({ eventId: "ev1" }) };
const oneParams = { params: Promise.resolve({ eventId: "ev1", proposalId: "sp1" }) };

const ADMIN = { user: { id: "u-admin", role: "ADMIN", organizationId: "org1" } };
const SUBMITTER = { user: { id: "u-sub", role: "SUBMITTER", organizationId: null } };
const MEMBER = { user: { id: "u-mem", role: "MEMBER", organizationId: "org1" } };
const REVIEWER = { user: { id: "u-rev", role: "REVIEWER", organizationId: null } };

const EVENT = { id: "ev1", organizationId: "org1" };

/** A speaker whose profile passes the Aug-5 completeness hard gate. */
const COMPLETE_SPEAKER = {
  id: "spk1",
  role: "PHYSICIAN", specialty: "Cardiology", organization: "Clinic",
  jobTitle: "Consultant", phone: "+97150", city: "Dubai", country: "AE",
};

const CREATED_PROPOSAL = {
  id: "sp1",
  title: "Hands-on TAVR Workshop",
  proposedFormat: "WORKSHOP",
  theme: { id: "th1", name: "Structural Heart" },
  speaker: {
    id: "spk1", userId: "u-sub", title: "DR", firstName: "Aisha", lastName: "Khan",
    email: "aisha@x.com", additionalEmail: null, organization: "Clinic", country: "AE",
  },
};

function req(method: string, body?: Record<string, unknown>, url = "http://localhost/x") {
  return new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
}

const VALID_CREATE = {
  speakerId: "spk1",
  title: "Hands-on TAVR Workshop",
  description: "A practical workshop.",
  themeId: "th1",
  proposedFormat: "WORKSHOP",
  durationMinutes: 90,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(ADMIN);
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.speaker.findFirst.mockResolvedValue(COMPLETE_SPEAKER);
  mockDb.sessionProposalTheme.findFirst.mockResolvedValue({ id: "th1" });
  mockDb.sessionProposal.create.mockResolvedValue(CREATED_PROPOSAL);
  mockDb.sessionProposal.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("POST /session-proposals — create", () => {
  it("SUBMITTER creates for their OWN speaker; org key stamped; notify fires on SUBMITTED", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    const res = await CREATE(req("POST", VALID_CREATE), listParams);
    expect(res.status).toBe(201);
    // Own-speaker binding: the lookup carries the caller's userId.
    expect(mockDb.speaker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "spk1", eventId: "ev1", userId: "u-sub" } }),
    );
    const data = mockDb.sessionProposal.create.mock.calls[0][0].data;
    expect(data.organizationId).toBe("org1"); // stamped from the EVENT (submitter is org-null)
    expect(data.status).toBe("SUBMITTED");
    expect(data.submittedAt).toBeInstanceOf(Date);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("a DRAFT save is silent — no submittedAt, no notify", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    const res = await CREATE(req("POST", { ...VALID_CREATE, status: "DRAFT" }), listParams);
    expect(res.status).toBe(201);
    const data = mockDb.sessionProposal.create.mock.calls[0][0].data;
    expect(data.submittedAt).toBeUndefined();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("SUBMITTER cannot propose for a FOREIGN speaker (403, no create)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.speaker.findFirst.mockResolvedValue(null); // userId bind found nothing
    const res = await CREATE(req("POST", VALID_CREATE), listParams);
    expect(res.status).toBe(403);
    expect(mockDb.sessionProposal.create).not.toHaveBeenCalled();
  });

  it("REVIEWER is refused (real denyReviewer)", async () => {
    mockAuth.mockResolvedValue(REVIEWER);
    const res = await CREATE(req("POST", VALID_CREATE), listParams);
    expect(res.status).toBe(403);
    expect(mockDb.sessionProposal.create).not.toHaveBeenCalled();
  });

  it("a proposal may only be BORN as DRAFT or SUBMITTED", async () => {
    const res = await CREATE(req("POST", { ...VALID_CREATE, status: "WITHDRAWN" }), listParams);
    expect(res.status).toBe(400);
  });

  it("a BREAK session type is not a proposable format", async () => {
    const res = await CREATE(req("POST", { ...VALID_CREATE, proposedFormat: "LUNCH" }), listParams);
    expect(res.status).toBe(400);
    expect(mockDb.sessionProposal.create).not.toHaveBeenCalled();
  });

  it("SUBMITTER with an INCOMPLETE profile is hard-gated (403 PROFILE_INCOMPLETE, no create)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.speaker.findFirst.mockResolvedValue({ ...COMPLETE_SPEAKER, phone: null, city: "" });
    const res = await CREATE(req("POST", VALID_CREATE), listParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_INCOMPLETE");
    expect(body.missingFields).toEqual(["Phone", "City"]);
    expect(mockDb.sessionProposal.create).not.toHaveBeenCalled();
  });

  it("STAFF creating on behalf is NOT profile-gated (sparse speaker still creates)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1" }); // no profile fields
    const res = await CREATE(req("POST", VALID_CREATE), listParams); // ADMIN default
    expect(res.status).toBe(201);
  });

  it("SUBMITTER create after the deadline → 403 DEADLINE_PASSED, no create", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT, settings: { sessionProposalDeadline: "2020-01-01T00:00:00.000Z" },
    });
    const res = await CREATE(req("POST", VALID_CREATE), listParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DEADLINE_PASSED");
    expect(mockDb.sessionProposal.create).not.toHaveBeenCalled();
  });

  it("STAFF create after the deadline is EXEMPT (organizer decisions post-close are deliberate)", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT, settings: { sessionProposalDeadline: "2020-01-01T00:00:00.000Z" },
    });
    const res = await CREATE(req("POST", VALID_CREATE), listParams); // ADMIN default
    expect(res.status).toBe(201);
  });

  it("a FUTURE deadline does not block a submitter create", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT,
      settings: { sessionProposalDeadline: new Date(Date.now() + 86400_000).toISOString() },
    });
    const res = await CREATE(req("POST", VALID_CREATE), listParams);
    expect(res.status).toBe(201);
  });
});

describe("GET /session-proposals — list scoping", () => {
  it("organizers never see DRAFTs (a draft is the submitter's private WIP)", async () => {
    const res = await LIST(req("GET"), listParams);
    expect(res.status).toBe(200);
    const where = mockDb.sessionProposal.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "DRAFT" });
    expect(where.speaker).toBeUndefined();
  });

  it("SUBMITTER sees only their own rows, drafts included", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    const res = await LIST(req("GET"), listParams);
    expect(res.status).toBe(200);
    const where = mockDb.sessionProposal.findMany.mock.calls[0][0].where;
    expect(where.speaker).toEqual({ userId: "u-sub" });
    expect(where.status).toBeUndefined();
    // Event resolved through the submitter linkage, not org scoping.
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ speakers: { some: { userId: "u-sub" } } }),
      }),
    );
  });

  it("a bogus status filter 400s instead of silently widening", async () => {
    const res = await LIST(req("GET", undefined, "http://localhost/x?status=BOGUS"), listParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FILTER");
  });

  it("CSV export is org-staff only — MEMBER gets 403 and no audit row", async () => {
    mockAuth.mockResolvedValue(MEMBER);
    const res = await LIST(req("GET", undefined, "http://localhost/x?export=csv"), listParams);
    expect(res.status).toBe(403);
    expect(recordExportSpy).not.toHaveBeenCalled();
  });

  it("CSV export returns csv + records the export audit", async () => {
    mockDb.sessionProposal.findMany.mockResolvedValue([
      {
        ...CREATED_PROPOSAL,
        durationMinutes: 90,
        status: "SUBMITTED",
        submittedAt: new Date("2026-07-30T10:00:00Z"),
      },
    ]);
    const res = await LIST(req("GET", undefined, "http://localhost/x?export=csv"), listParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await (res as unknown as { text: () => Promise<string> }).text();
    expect(text).toContain("Hands-on TAVR Workshop");
    expect(text).toContain("Dr. Aisha Khan");
    expect(recordExportSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityType: "SessionProposal", rowCount: 1, format: "csv" }),
    );
  });
});

describe("PUT /session-proposals/[id] — submitter lifecycle", () => {
  it("SUBMITTED is LOCKED for the submitter (403 SUBMITTED_LOCKED, no write)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "SUBMITTED", speaker: { userId: "u-sub" },
    });
    const res = await PUT(req("PUT", { title: "New title" }), oneParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("SUBMITTED_LOCKED");
    expect(mockDb.sessionProposal.update).not.toHaveBeenCalled();
  });

  it("a FOREIGN proposal 404s for the submitter (no existence leak)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "DRAFT", speaker: { userId: "someone-else" },
    });
    const res = await PUT(req("PUT", { title: "New title" }), oneParams);
    expect(res.status).toBe(404);
  });

  it("DRAFT → SUBMITTED stamps submittedAt and fires the notify fan-out", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "DRAFT", speaker: { userId: "u-sub", ...COMPLETE_SPEAKER },
    });
    mockDb.sessionProposal.update.mockResolvedValue({ ...CREATED_PROPOSAL, status: "SUBMITTED" });
    const res = await PUT(req("PUT", { status: "SUBMITTED" }), oneParams);
    expect(res.status).toBe(200);
    const data = mockDb.sessionProposal.update.mock.calls[0][0].data;
    expect(data.submittedAt).toBeInstanceOf(Date);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("DRAFT → SUBMITTED is hard-gated on profile completeness (403, no write); a plain draft edit is NOT", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "DRAFT",
      speaker: { userId: "u-sub", ...COMPLETE_SPEAKER, organization: null },
    });
    const res = await PUT(req("PUT", { status: "SUBMITTED" }), oneParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PROFILE_INCOMPLETE");
    expect(mockDb.sessionProposal.update).not.toHaveBeenCalled();

    // Draft edit without submitting stays allowed for the same person.
    mockDb.sessionProposal.update.mockResolvedValue({ ...CREATED_PROPOSAL, status: "DRAFT" });
    const editRes = await PUT(req("PUT", { title: "Reworked title" }), oneParams);
    expect(editRes.status).toBe(200);
  });

  it("SUBMITTER DRAFT → SUBMITTED after the deadline → 403 DEADLINE_PASSED; the draft edit still saves", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.event.findFirst.mockResolvedValue({
      ...EVENT, settings: { sessionProposalDeadline: "2020-01-01T00:00:00.000Z" },
    });
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "DRAFT", speaker: { userId: "u-sub", ...COMPLETE_SPEAKER },
    });
    const res = await PUT(req("PUT", { status: "SUBMITTED" }), oneParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DEADLINE_PASSED");
    expect(mockDb.sessionProposal.update).not.toHaveBeenCalled();

    mockDb.sessionProposal.update.mockResolvedValue({ ...CREATED_PROPOSAL, status: "DRAFT" });
    const editRes = await PUT(req("PUT", { title: "Post-deadline polish" }), oneParams);
    expect(editRes.status).toBe(200);
  });

  it("organizer can WITHDRAW without triggering the submission fan-out", async () => {
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "SUBMITTED", speaker: { userId: "u-sub" },
    });
    mockDb.sessionProposal.update.mockResolvedValue({ ...CREATED_PROPOSAL, status: "WITHDRAWN" });
    const res = await PUT(req("PUT", { status: "WITHDRAWN" }), oneParams);
    expect(res.status).toBe(200);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("organizer edit audits per-field before→after with the actor (createdAt stamps the when)", async () => {
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      id: "sp1", status: "SUBMITTED", title: "Old title", description: "Long description",
      themeId: "th1", proposedFormat: null, durationMinutes: 60,
      speaker: { userId: "u-sub" },
    });
    mockDb.sessionProposal.update.mockResolvedValue({
      ...CREATED_PROPOSAL, status: "SUBMITTED", title: "New title",
      description: "Long description", themeId: "th1", proposedFormat: null, durationMinutes: 90,
    });
    const res = await PUT(req("PUT", { title: "New title", durationMinutes: 90 }), oneParams);
    expect(res.status).toBe(200);
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("UPDATE");
    expect(audit.entityType).toBe("SessionProposal");
    expect(audit.userId).toBeTruthy(); // WHO — the editing organizer
    // WHAT — before→after values for exactly the touched fields.
    expect(audit.changes.before).toEqual({ status: "SUBMITTED", title: "Old title", durationMinutes: 60 });
    expect(audit.changes.after).toEqual({ status: "SUBMITTED", title: "New title", durationMinutes: 90 });
    // Untouched fields stay out of the snapshot (bounded audit rows).
    expect(audit.changes.before.description).toBeUndefined();
    expect(audit.changes.fields).toEqual(["title", "durationMinutes"]);
  });
});

describe("GET/DELETE /session-proposals/[id]", () => {
  it("GET: submitter reading a foreign proposal gets 404", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.sessionProposal.findFirst.mockResolvedValue({
      ...CREATED_PROPOSAL,
      speaker: { ...CREATED_PROPOSAL.speaker, userId: "someone-else" },
    });
    const res = await GET_ONE(req("GET"), oneParams);
    expect(res.status).toBe(404);
  });

  it("DELETE is organizer-only — SUBMITTER gets 403", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    const res = await DELETE(req("DELETE"), oneParams);
    expect(res.status).toBe(403);
    expect(mockDb.sessionProposal.delete).not.toHaveBeenCalled();
  });

  it("DELETE by organizer removes the row and audits", async () => {
    mockDb.sessionProposal.findFirst.mockResolvedValue({ id: "sp1", title: "T", status: "SUBMITTED" });
    mockDb.sessionProposal.delete.mockResolvedValue({});
    const res = await DELETE(req("DELETE"), oneParams);
    expect(res.status).toBe(200);
    expect(mockDb.sessionProposal.delete).toHaveBeenCalledWith({ where: { id: "sp1" } });
    expect(mockDb.auditLog.create).toHaveBeenCalled();
  });
});

describe("session-proposal-themes", () => {
  it("GET is readable by a linked SUBMITTER (the form's theme picker)", async () => {
    mockAuth.mockResolvedValue(SUBMITTER);
    mockDb.sessionProposalTheme.findMany.mockResolvedValue([{ id: "th1", name: "Structural Heart", sortOrder: 0 }]);
    const res = await THEMES_LIST(req("GET"), listParams);
    expect(res.status).toBe(200);
    // Access resolved via the submitter's speaker linkage, NOT requireOrgId —
    // the deliberate improvement over the abstract-themes GET.
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ speakers: { some: { userId: "u-sub" } } }),
      }),
    );
  });

  it("POST is org-staff only — MEMBER gets 403", async () => {
    mockAuth.mockResolvedValue(MEMBER);
    const res = await THEMES_CREATE(req("POST", { name: "New Theme" }), listParams);
    expect(res.status).toBe(403);
    expect(mockDb.sessionProposalTheme.create).not.toHaveBeenCalled();
  });

  it("POST stamps the org key and appends sortOrder max+1", async () => {
    mockDb.sessionProposalTheme.findFirst.mockResolvedValue({ sortOrder: 2 });
    mockDb.sessionProposalTheme.create.mockResolvedValue({ id: "th2", name: "New Theme", sortOrder: 3 });
    const res = await THEMES_CREATE(req("POST", { name: "New Theme" }), listParams);
    expect(res.status).toBe(201);
    const data = mockDb.sessionProposalTheme.create.mock.calls[0][0].data;
    expect(data.organizationId).toBe("org1");
    expect(data.sortOrder).toBe(3);
  });
});
