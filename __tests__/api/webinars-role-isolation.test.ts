/**
 * WEBINARS role (webinar team, Aug 3 2026) — the containment matrix.
 *
 * Owner spec: "ONSITE role + webinar full control, not organizer" — two-tier:
 *  (1) ALL org WEBINAR-type events: full organizer-grade control.
 *  (2) Non-webinar events: ONSITE-equivalent desk via the SAME
 *      Event.settings.onsiteUserIds assignment.
 *
 * The enforcement pairing is: `denyReviewer(..., { allow: WEBINAR_STAFF_ALLOW })`
 * (the OPERATION is allowed) + `buildEventAccessWhere` (…but ONLY on a
 * webinar). These tests pin both halves with the REAL pure helpers, plus the
 * routes where the pairing is load-bearing (event create's WEBINAR_ONLY gate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), create: vi.fn() },
    registration: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    // Post-create fire-and-forget seeds (templates + default reg types).
    emailTemplate: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    ticketType: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/api-key", () => ({ validateApiKey: vi.fn() }));
vi.mock("@/lib/email", () => ({ DEFAULT_TEMPLATES: [] }));
vi.mock("@/app/api/events/[eventId]/tickets/route", () => ({ DEFAULT_REG_TYPES: [], DEFAULT_TIER_NAMES: [] }));
vi.mock("@/lib/default-terms", () => ({ DEFAULT_REGISTRATION_TERMS_HTML: "", DEFAULT_SPEAKER_AGREEMENT_HTML: "" }));
vi.mock("@/lib/webinar-provisioner", () => ({ provisionWebinar: vi.fn().mockResolvedValue(undefined) }));

// The pure layers are REAL — that's the point.
import { eventWhereFor, principalFromUser } from "@/lib/permissions/can";
import { TEAM_ROLES } from "@/lib/auth-guards";
import { POST as createEventPOST } from "@/app/api/events/route";
import { canExportRegistrations, canViewContacts, canViewEntryBarcode, canViewFinance, canViewLoginActivity, canViewZoomHostCredentials } from "../helpers/role-can";

const WEBINARS_USER = { id: "web1", role: "WEBINARS", organizationId: "org1" };

describe("WEBINARS two-tier scoping, through permissions (Phase 6)", () => {
  const web = principalFromUser(WEBINARS_USER);
  const member = principalFromUser({ id: "m1", role: "MEMBER", organizationId: "org1" });

  it("management keys resolve ONLY the org's WEBINAR events", () => {
    for (const key of ["analytics.read", "speakers.update", "sessions.read"] as const) {
      expect(eventWhereFor(web, key, "evX")).toEqual({ id: "evX", organizationId: "org1", eventType: "WEBINAR" });
    }
  });

  it("the desk keys resolve EVERY event in the org, exactly MEMBER's scope", () => {
    for (const key of ["events.read", "registrations.read", "registrations.checkin"] as const) {
      expect(eventWhereFor(web, key, "evX")).toEqual({ id: "evX", organizationId: "org1" });
    }
    expect(eventWhereFor(web, "events.read", "evX")).toEqual(eventWhereFor(member, "events.read", "evX"));
  });

  it("stays org-bound: a foreign organisation never matches", () => {
    expect(eventWhereFor(web, "events.read")).toMatchObject({ organizationId: "org1" });
    expect(eventWhereFor(web, "analytics.read")).toMatchObject({ organizationId: "org1" });
  });

  it("is an org team role (Settings → Users list + invite)", () => {
    expect((TEAM_ROLES as readonly string[]).includes("WEBINARS")).toBe(true);
  });
});

describe("visibility predicates — WEBINARS", () => {
  it("finance-capable (desk records payments — ONSITE parity)", () => {
    expect(canViewFinance("WEBINARS")).toBe(true);
  });
  it("holds entry barcodes (badge printing)", () => {
    expect(canViewEntryBarcode("WEBINARS")).toBe(true);
  });
  it("holds Zoom HOST credentials (the producer role)", () => {
    expect(canViewZoomHostCredentials("WEBINARS")).toBe(true);
  });
  it("may export registrations (desk parity)", () => {
    expect(canExportRegistrations("WEBINARS")).toBe(true);
  });
  it("does NOT read the org contact book", () => {
    expect(canViewContacts("WEBINARS")).toBe(false);
  });
  it("does NOT read sign-in activity", () => {
    expect(canViewLoginActivity("WEBINARS")).toBe(false);
  });
});

describe("POST /api/events — WEBINARS may only create webinars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: WEBINARS_USER });
  });

  const req = (eventType?: string) =>
    new Request("http://localhost/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test Webinar",
        startDate: "2026-09-01T08:00:00.000Z",
        endDate: "2026-09-01T10:00:00.000Z",
        ...(eventType && { eventType }),
      }),
    });

  it("refuses a CONFERENCE create with 403 WEBINAR_ONLY", async () => {
    const res = await createEventPOST(req("CONFERENCE"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("WEBINAR_ONLY");
    expect(mockDb.event.create).not.toHaveBeenCalled();
  });

  it("refuses an OMITTED eventType (no silent coercion)", async () => {
    const res = await createEventPOST(req());
    expect(res.status).toBe(403);
    expect(mockDb.event.create).not.toHaveBeenCalled();
  });

  it("passes the gate for a WEBINAR create", async () => {
    mockDb.event.findFirst.mockResolvedValue(null); // slug free
    mockDb.event.create.mockResolvedValue({
      id: "ev1", organizationId: "org1", eventType: "WEBINAR", name: "Test Webinar", slug: "test-webinar",
    });
    const res = await createEventPOST(req("WEBINAR"));
    expect(res.status).toBe(201);
    expect(mockDb.event.create).toHaveBeenCalled();
  });
});
