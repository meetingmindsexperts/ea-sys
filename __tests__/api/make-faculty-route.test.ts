/**
 * POST registrations/{id}/make-faculty (plan step 6): who may call it, what the
 * service is told about the caller, and how a refusal is answered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, serviceSpy, rateSpy, logger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  serviceSpy: vi.fn(),
  rateSpy: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockDb: { event: { findFirst: vi.fn() } },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Map<string, string>() }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: (fn: unknown) => fn }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (args: unknown) => rateSpy(args), getClientIp: () => "1.2.3.4" }));
vi.mock("@/services/make-faculty-service", () => ({ makeRegistrationFaculty: serviceSpy }));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/make-faculty/route";

const params = { params: Promise.resolve({ eventId: "e1", registrationId: "r1" }) };
const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), params);
const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: "org1" } });
const PLAN = { registrationId: "r1", speaker: { id: "s1", name: "A B" }, fromType: "Physician", fromRate: null, owing: null, invoices: [], badge: { from: null, to: "Faculty" } };

beforeEach(() => {
  vi.clearAllMocks();
  as("ORGANIZER");
  mockDb.event.findFirst.mockResolvedValue({ id: "e1", organizationId: "org1", eventType: "CONFERENCE", staffAssignments: [] });
  rateSpy.mockReturnValue({ allowed: true });
  serviceSpy.mockResolvedValue({ ok: true, moved: true, plan: PLAN, invoicesNotCancelled: [] });
});

describe("POST make-faculty", () => {
  it("an organiser's move reaches the service with who they are and what they may see and cancel", async () => {
    const res = await post({ confirmWaive: 400 });
    expect(res.status).toBe(200);
    expect(serviceSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "e1", registrationId: "r1", organizationId: "org1", actorUserId: "u1", preview: false, confirmWaive: 400,
      maySeeAmounts: true, mayCancelInvoices: true, source: "rest", requestIp: "1.2.3.4",
    }));
  });

  // It gives a free Faculty registration: the desk edits registrations and must not reach it.
  it.each(["ONSITE", "MEMBER", "REGISTRANT", "SUBMITTER"])("%s is refused before anything is read", async (role) => {
    as(role);
    const res = await post({ preview: true });
    expect(res.status).toBe(403);
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  it("an event the caller's grant does not reach is not found", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await post({ preview: true })).status).toBe(404);
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  it("refuses a body it does not know, and a field of the update that could be smuggled in", async () => {
    expect((await post({ toFaculty: true })).status).toBe(400);
    expect((await post({ confirmWaive: -1 })).status).toBe(400);
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  it("is rate limited per user", async () => {
    rateSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await post({ preview: true });
    expect(res.status).toBe(429);
    expect(rateSpy.mock.calls[0][0]).toMatchObject({ key: "make-faculty:u1" });
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  // A preview asks whether it can be done: "no, it has a payment on it" is the answer.
  it("a preview's refusal is an answer (200, ok false, the code and the reason); the same refusal of a real move is 409", async () => {
    serviceSpy.mockResolvedValue({ ok: false, code: "HAS_PAYMENT", message: "This registration has a payment on it." });
    const asked = await post({ preview: true });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ ok: false, code: "HAS_PAYMENT", error: "This registration has a payment on it." });
    expect((await post({})).status).toBe(409);
  });

  it("the amount to confirm comes back with its plan; a missing registration stays 404 even on a preview", async () => {
    serviceSpy.mockResolvedValue({ ok: false, code: "CONFIRM_WAIVE", message: "AED 400.00 is owed.", plan: { ...PLAN, owing: { amount: 400, currency: "AED" } } });
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONFIRM_WAIVE", plan: { owing: { amount: 400, currency: "AED" } } });
    serviceSpy.mockResolvedValue({ ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found." });
    expect((await post({ preview: true })).status).toBe(404);
  });
});
