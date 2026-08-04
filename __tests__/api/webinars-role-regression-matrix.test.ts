/**
 * WEBINARS role — ROUTE-LEVEL regression matrix (review recommendation #1).
 *
 * The isolation suite pins the pure layers (builder shapes, allow lists,
 * predicates); THIS file pins that specific routes actually APPLY them —
 * because the review found live regressions the pure tests couldn't see:
 *  - H-2: the scheduled-email PATCH/DELETE/retry primary updateMany was
 *    org-scoped only (builder only on the fallback read) — a WEBINARS user
 *    holding a conference scheduleId could rewrite/cancel/re-fire a
 *    CONFERENCE campaign. Pinned here via the updateMany where shape.
 *  - H-1: the org-wide invoice ledger opened via FINANCE_ROLES membership —
 *    pinned as an explicit 403.
 *  - M-2: event PUT could flip eventType → CONFERENCE, bypassing the create
 *    route's WEBINAR_ONLY gate — pinned as 403.
 *  - L-4 (owner-acked): registration DELETE stays ADMIN/ORGANIZER — WEBINARS
 *    gets 403 even on its own webinars (no refund powers ⇒ no row deletion).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), update: vi.fn() },
    scheduledEmail: { updateMany: vi.fn(), findFirst: vi.fn() },
    invoice: { findMany: vi.fn(), aggregate: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/invoice-export", () => ({ invoiceDateFilter: vi.fn().mockReturnValue({}) }));
// Heavy deps of the event PUT — the M-2 gate fires before any of them.
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
// (survey schema is pure zod — no mock needed; the PUT uses it at module load)
// Heavy deps of the registration route — the L-4 guard fires before them.
vi.mock("@/services/registration-service", () => ({ updateRegistration: vi.fn() }));
vi.mock("@/lib/registration-seat-db", () => ({ releaseEventSeats: vi.fn(), releasePromoUsage: vi.fn(), releaseSeat: vi.fn() }));
vi.mock("@/lib/registration-seat", () => ({ holdsSeat: vi.fn(), seatCounter: vi.fn() }));
vi.mock("@/lib/accommodation-rooms", () => ({ releaseRoomForDeletedPerson: vi.fn() }));
vi.mock("@/lib/photo-cleanup", () => ({ deletePhotoIfUnreferenced: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registration-financials", () => ({ computeRegistrationFinancials: vi.fn(), readRegistrationBasePrice: vi.fn() }));

import { PATCH as schedulePATCH, DELETE as scheduleDELETE } from "@/app/api/events/[eventId]/emails/schedule/[id]/route";
import { POST as retryPOST } from "@/app/api/events/[eventId]/emails/schedule/[id]/retry/route";
import { GET as invoicesGET } from "@/app/api/invoices/route";
import { PUT as eventPUT } from "@/app/api/events/[eventId]/route";
import { DELETE as registrationDELETE } from "@/app/api/events/[eventId]/registrations/[registrationId]/route";

const WEBINARS_SESSION = { user: { id: "web1", role: "WEBINARS", organizationId: "org1" } };
const scheduleParams = { params: Promise.resolve({ eventId: "evConf", id: "sched1" }) };
const eventParams = { params: Promise.resolve({ eventId: "evConf" }) };
const regParams = { params: Promise.resolve({ eventId: "ev1", registrationId: "reg1" }) };

const jsonReq = (method: string, body?: unknown) =>
  new Request("http://localhost/x", {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(WEBINARS_SESSION);
  // The H-2 pin works via the updateMany WHERE shape, so let the claim "lose"
  // (count 0) and the fallback read return null → 404 path.
  mockDb.scheduledEmail.updateMany.mockResolvedValue({ count: 0 });
  mockDb.scheduledEmail.findFirst.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// H-2 — the scheduled-email PRIMARY writes carry the role-aware event binding
// ─────────────────────────────────────────────────────────────────────────────

function expectUpdateManyEventBound() {
  const where = mockDb.scheduledEmail.updateMany.mock.calls[0][0].where as {
    event?: Record<string, unknown>;
    organizationId?: string;
  };
  // The write is confined through the EVENT relation with the WEBINARS
  // builder shape — org scope alone (the H-2 fail-open) would lack `event`.
  expect(where.event).toMatchObject({ organizationId: "org1", eventType: "WEBINAR" });
}

describe("H-2 — schedule mutations bind the primary write through the builder", () => {
  it("PATCH updateMany where carries event.eventType=WEBINAR for WEBINARS", async () => {
    const res = await schedulePATCH(jsonReq("PATCH", { customSubject: "x" }), scheduleParams);
    expect(res.status).toBe(404); // conference row never matches
    expectUpdateManyEventBound();
  });

  it("DELETE (cancel) updateMany where carries the builder binding", async () => {
    const res = await scheduleDELETE(jsonReq("DELETE"), scheduleParams);
    expect(res.status).toBe(404);
    expectUpdateManyEventBound();
  });

  it("retry POST updateMany where carries the builder binding", async () => {
    const res = await retryPOST(jsonReq("POST"), scheduleParams);
    expect(res.status).toBe(404);
    expectUpdateManyEventBound();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-1 — org-wide invoice ledger refuses WEBINARS
// ─────────────────────────────────────────────────────────────────────────────

describe("H-1 — org invoice ledger", () => {
  it("GET /api/invoices → 403 for WEBINARS (finance-capable ≠ org ledger)", async () => {
    const res = await invoicesGET(new Request("http://localhost/api/invoices"));
    expect(res.status).toBe(403);
    expect(mockDb.invoice.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-2 — event PUT cannot flip eventType away from WEBINAR
// ─────────────────────────────────────────────────────────────────────────────

describe("M-2 — eventType flip refused on the PUT", () => {
  it("WEBINARS PUT eventType=CONFERENCE → 403 WEBINAR_ONLY, no write", async () => {
    // The event resolves (it IS a webinar — that's what makes the flip a bypass).
    mockDb.event.findFirst.mockResolvedValue({
      id: "evConf", slug: "s", status: "DRAFT", settings: {},
      startDate: new Date(), endDate: new Date(), timezone: "Asia/Dubai",
    });
    const res = await eventPUT(jsonReq("PUT", { eventType: "CONFERENCE" }), eventParams);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("WEBINAR_ONLY");
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("re-asserting eventType=WEBINAR is allowed through the gate", async () => {
    mockDb.event.findFirst.mockResolvedValue(null); // stop later at 404 — gate passed
    const res = await eventPUT(jsonReq("PUT", { eventType: "WEBINAR" }), eventParams);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L-4 — registration DELETE stays ADMIN/ORGANIZER (owner-acked)
// ─────────────────────────────────────────────────────────────────────────────

describe("L-4 — registration DELETE refused for WEBINARS", () => {
  it("DELETE → 403 even on the role's own webinar events", async () => {
    const res = await registrationDELETE(jsonReq("DELETE"), regParams);
    expect(res.status).toBe(403);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });
});
