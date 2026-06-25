/**
 * Unit tests for the per-recipient issued-certificates listing route:
 *   GET /api/events/[eventId]/certificates/issued?registrationId=...
 *   GET /api/events/[eventId]/certificates/issued?speakerId=...
 *
 * Focused on the auth/binding contract + the XOR id requirement that
 * keeps the card from accidentally cross-referencing recipients.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    issuedCertificate: { findMany: vi.fn() },
    // Counterpart resolution (speaker ↔ companion registration) now folds
    // the linked person's certs in, so the route reads these too.
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));

import { GET } from "@/app/api/events/[eventId]/certificates/issued/route";

const adminSession = {
  user: { id: "user-1", role: "ADMIN", organizationId: "org-1" },
};
const params = { params: Promise.resolve({ eventId: "evt-1" }) };

function makeReq(qs: string) {
  return new Request(`http://test/api/events/evt-1/certificates/issued?${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/events/[eventId]/certificates/issued", () => {
  it("returns 401 when not signed in", async () => {
    mockAuth.mockResolvedValueOnce(null);
    const res = await GET(makeReq("registrationId=reg-1"), params);
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u2", role: "REVIEWER", organizationId: "org-1" },
    });
    const res = await GET(makeReq("registrationId=reg-1"), params);
    expect(res.status).toBe(403);
  });

  it("returns 403 when ADMIN has no organizationId", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: "u-no-org", role: "ADMIN", organizationId: null },
    });
    const res = await GET(makeReq("registrationId=reg-1"), params);
    expect(res.status).toBe(403);
  });

  it("returns 400 when neither registrationId nor speakerId is supplied", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const res = await GET(makeReq(""), params);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/registrationId or speakerId/i);
  });

  it("returns 400 when BOTH ids are supplied (prevents cross-reference)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    const res = await GET(makeReq("registrationId=reg-1&speakerId=spk-1"), params);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not both/i);
  });

  it("returns 404 on cross-tenant event (non-enumeration)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    const res = await GET(makeReq("registrationId=reg-1"), params);
    expect(res.status).toBe(404);
    // Org binding check on the event lookup.
    const lookupArgs = mockDb.event.findFirst.mock.calls[0][0] as {
      where: { id: string; organizationId: string };
    };
    expect(lookupArgs.where.organizationId).toBe("org-1");
  });

  it("returns certs for the registration when registrationId supplied (no linked speaker)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({ attendee: { email: "a@x.com" } });
    mockDb.speaker.findFirst.mockResolvedValue(null); // no pointer + no email match
    mockDb.issuedCertificate.findMany.mockResolvedValueOnce([
      {
        id: "cert-1",
        type: "ATTENDANCE",
        serial: "ATT-2026-001",
        pdfUrl: "/uploads/certificates/evt-1/cert-1.pdf",
        issuedAt: new Date(),
        lastResentAt: null,
        resendCount: 0,
        revokedAt: null,
        revocationReason: null,
        certificateTemplate: { id: "tmpl-1", name: "Standard Attendance" },
        issueRunItem: { emailedAt: new Date(), errorPhase: null, errorMessage: null },
      },
    ]);

    const res = await GET(makeReq("registrationId=reg-1"), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { certificates: unknown[] };
    expect(body.certificates).toHaveLength(1);

    const queryArgs = mockDb.issuedCertificate.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
    };
    expect(queryArgs.where).toEqual({ eventId: "evt-1", OR: [{ registrationId: "reg-1" }] });
    expect(queryArgs.orderBy).toEqual({ issuedAt: "desc" });
  });

  it("queries by speakerId when speakerId supplied (no linked registration)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.speaker.findFirst.mockResolvedValueOnce({ sourceRegistrationId: null, email: "s@x.com" });
    mockDb.registration.findFirst.mockResolvedValueOnce(null); // no email match
    mockDb.issuedCertificate.findMany.mockResolvedValueOnce([]);

    const res = await GET(makeReq("speakerId=spk-1"), params);
    expect(res.status).toBe(200);

    const queryArgs = mockDb.issuedCertificate.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(queryArgs.where).toEqual({ eventId: "evt-1", OR: [{ speakerId: "spk-1" }] });
  });

  it("folds the linked companion registration's certs into a speaker query (the bug fix)", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    // Speaker points at companion registration reg-9 → its ATTENDANCE cert
    // (issued by tag to the registration) must show on the speaker page.
    mockDb.speaker.findFirst.mockResolvedValueOnce({ sourceRegistrationId: "reg-9", email: "s@x.com" });
    mockDb.issuedCertificate.findMany.mockResolvedValueOnce([]);

    const res = await GET(makeReq("speakerId=spk-1"), params);
    expect(res.status).toBe(200);

    const queryArgs = mockDb.issuedCertificate.findMany.mock.calls[0][0] as {
      where: { OR: unknown[] };
    };
    expect(queryArgs.where).toEqual({
      eventId: "evt-1",
      OR: [{ speakerId: "spk-1" }, { registrationId: "reg-9" }],
    });
    // pointer wins → no email lookup needed
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("returns empty array (not error) when no certs issued yet", async () => {
    mockAuth.mockResolvedValueOnce(adminSession);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "evt-1" });
    mockDb.registration.findFirst.mockResolvedValueOnce({ attendee: { email: "a@x.com" } });
    mockDb.speaker.findFirst.mockResolvedValue(null);
    mockDb.issuedCertificate.findMany.mockResolvedValueOnce([]);

    const res = await GET(makeReq("registrationId=reg-1"), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { certificates: unknown[] };
    expect(body.certificates).toEqual([]);
  });
});
