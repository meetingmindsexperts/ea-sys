/**
 * The desk's "Get code from DET" (docs/DTCM_ETICKET_PLAN.md §5.4): who may,
 * and the fallback rule. A definite DET failure falls back to a spare pool
 * code so the attendee still leaves with one; an UNCERTAIN purchase never
 * does, because a ticket may exist and a person decides.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockIssue, mockClaim, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { event: { findFirst: vi.fn() } },
  mockIssue: vi.fn(),
  mockClaim: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/dtcm-pool", () => ({ claimSpareDtcmCode: mockClaim }));
vi.mock("@/services/dtcm-eticket-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dtcm-eticket-service")>()),
  issueDtcmTicket: mockIssue,
}));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/dtcm-eticket/route";

const params = { params: Promise.resolve({ eventId: "evt1", registrationId: "reg-1" }) };
const post = () => POST(new Request("http://localhost/api", { method: "POST" }), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org1", role: "ADMIN" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt1", requiresDtcmBarcode: true });
});

describe("POST", () => {
  it("returns DET's barcode", async () => {
    mockIssue.mockResolvedValue({ ok: true, barcode: "BAR-1", order: { id: "do-1", orderId: "O1" } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "det", barcode: "BAR-1" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("falls back to a spare code when DET definitely did not sell", async () => {
    mockIssue.mockResolvedValue({ ok: false, code: "DET_REFUSED", message: "Section soldout" });
    mockClaim.mockResolvedValue({ status: "assigned", code: "SPARE-1" });
    const body = await (await post()).json();
    expect(body).toMatchObject({ source: "pool", barcode: "SPARE-1", detError: "Section soldout" });
  });

  it("never falls back on an UNCERTAIN purchase", async () => {
    mockIssue.mockResolvedValue({ ok: false, code: "UNCERTAIN", message: "may have", order: { id: "do-2", status: "UNCERTAIN" } });
    const res = await post();
    expect(res.status).toBe(409);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("does not fall back for a setup problem the desk can fix", async () => {
    mockIssue.mockResolvedValue({ ok: false, code: "MISSING_PHONE", message: "DET needs a phone number" });
    expect((await post()).status).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses a role that may not hold a door credential, before buying", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", organizationId: "org1", role: "MEMBER" } });
    expect((await post()).status).toBe(403);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("refuses a caller with no organisation", async () => {
    mockAuth.mockResolvedValue({ user: { id: "op", organizationId: null, role: "SUPER_ADMIN" } });
    expect((await post()).status).toBe(403);
    expect(mockIssue).not.toHaveBeenCalled();
  });
});
