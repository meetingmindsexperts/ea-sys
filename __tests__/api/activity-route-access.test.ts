/**
 * Access control on the registration + speaker /activity timeline GETs
 * (July 10, 2026 review fix H1 — cross-tenant IDOR).
 *
 * The routes used to hand-roll `...(organizationId ? { organizationId } : {})`
 * with no denyReviewer — for org-null roles (REGISTRANT/SUBMITTER/REVIEWER,
 * all organizationId: null by design) the spread collapsed to {} and the event
 * lookup lost its org filter entirely, exposing any org's audit trail + email
 * history. These pin, with the REAL guards (not mocked):
 *   - org-null restricted roles → 403 before any DB read
 *   - MEMBER stays allowed (read-only operational viewer) and org-scoped
 *   - ONSITE is assignment-gated via settings.onsiteUserIds
 *   - ADMIN happy path returns the feed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockBuildReg, mockBuildSpk } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockBuildReg: vi.fn(),
  mockBuildSpk: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/activity-feed", () => ({
  buildRegistrationActivity: mockBuildReg,
  buildSpeakerActivity: mockBuildSpk,
}));
// denyReviewer + buildEventAccessWhere + canViewFinance stay REAL — the point
// is to prove the routes call the real scoping/guard helpers.

import { GET as regActivityGET } from "@/app/api/events/[eventId]/registrations/[registrationId]/activity/route";
import { GET as spkActivityGET } from "@/app/api/events/[eventId]/speakers/[speakerId]/activity/route";

const REGISTRANT = { id: "u-reg", role: "REGISTRANT", organizationId: null };
const SUBMITTER = { id: "u-sub", role: "SUBMITTER", organizationId: null };
const MEMBER = { id: "u-mem", role: "MEMBER", organizationId: "org1" };
const ONSITE = { id: "u-ons", role: "ONSITE", organizationId: "org1" };
const ADMIN = { id: "u-adm", role: "ADMIN", organizationId: "org1" };

const regParams = { params: Promise.resolve({ eventId: "ev1", registrationId: "reg1" }) };
const spkParams = { params: Promise.resolve({ eventId: "ev1", speakerId: "spk1" }) };
const req = new Request("http://localhost/x");

function lastEventWhere() {
  return mockDb.event.findFirst.mock.calls.at(-1)?.[0]?.where as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg1", attendee: { email: "a@b.c" } });
  mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", email: "a@b.c", sourceRegistrationId: null });
  mockBuildReg.mockResolvedValue({ items: [], linked: null });
  mockBuildSpk.mockResolvedValue({ items: [], linked: null });
});

describe("registration activity GET — role gate", () => {
  it("403s an org-null REGISTRANT before any DB read (the IDOR path)", async () => {
    mockAuth.mockResolvedValue({ user: REGISTRANT });
    const res = await regActivityGET(req, regParams);
    expect(res.status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(mockBuildReg).not.toHaveBeenCalled();
  });

  it("403s a SUBMITTER", async () => {
    mockAuth.mockResolvedValue({ user: SUBMITTER });
    const res = await regActivityGET(req, regParams);
    expect(res.status).toBe(403);
  });

  it("lets MEMBER through with an org-scoped event lookup", async () => {
    mockAuth.mockResolvedValue({ user: MEMBER });
    const res = await regActivityGET(req, regParams);
    expect(res.status).toBe(200);
    expect(lastEventWhere()).toMatchObject({ id: "ev1", organizationId: "org1" });
  });

  it("assignment-gates ONSITE via settings.onsiteUserIds (404 when unassigned)", async () => {
    mockAuth.mockResolvedValue({ user: ONSITE });
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await regActivityGET(req, regParams);
    expect(res.status).toBe(404);
    expect(lastEventWhere()).toMatchObject({
      settings: { path: ["onsiteUserIds"], array_contains: "u-ons" },
    });
  });

  it("ADMIN happy path returns the feed org-scoped", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    const res = await regActivityGET(req, regParams);
    expect(res.status).toBe(200);
    expect(lastEventWhere()).toMatchObject({ id: "ev1", organizationId: "org1" });
    expect(mockBuildReg).toHaveBeenCalled();
  });
});

describe("speaker activity GET — role gate", () => {
  it("403s an org-null REGISTRANT before any DB read (the IDOR path)", async () => {
    mockAuth.mockResolvedValue({ user: REGISTRANT });
    const res = await spkActivityGET(req, spkParams);
    expect(res.status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
    expect(mockBuildSpk).not.toHaveBeenCalled();
  });

  it("403s a REVIEWER", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-rev", role: "REVIEWER", organizationId: null } });
    const res = await spkActivityGET(req, spkParams);
    expect(res.status).toBe(403);
  });

  it("lets MEMBER through with an org-scoped event lookup", async () => {
    mockAuth.mockResolvedValue({ user: MEMBER });
    const res = await spkActivityGET(req, spkParams);
    expect(res.status).toBe(200);
    expect(lastEventWhere()).toMatchObject({ id: "ev1", organizationId: "org1" });
  });

  it("ADMIN happy path returns the feed org-scoped", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    const res = await spkActivityGET(req, spkParams);
    expect(res.status).toBe(200);
    expect(lastEventWhere()).toMatchObject({ id: "ev1", organizationId: "org1" });
    expect(mockBuildSpk).toHaveBeenCalled();
  });
});
