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
    abstractTheme: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  changeStatusSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
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
  mockAuth.mockResolvedValue(admin);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", name: "Ev", settings: {} });
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
