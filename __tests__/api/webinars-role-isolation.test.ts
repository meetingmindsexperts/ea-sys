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
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer, WEBINAR_STAFF_ALLOW, REGISTRATION_DESK_ALLOW, TEAM_ROLES } from "@/lib/auth-guards";
import { canViewFinance } from "@/lib/finance-visibility";
import { canViewEntryBarcode } from "@/lib/barcode-visibility";
import { canViewZoomHostCredentials } from "@/lib/zoom-visibility";
import { canExportRegistrations } from "@/lib/registration-export-visibility";
import { canViewContacts } from "@/lib/contact-visibility";
import { canViewLoginActivity } from "@/lib/login-visibility";
import { POST as createEventPOST } from "@/app/api/events/route";

const WEBINARS_USER = { id: "web1", role: "WEBINARS", organizationId: "org1" };

describe("buildEventAccessWhere — WEBINARS two-tier scoping", () => {
  it("manage surface (default) resolves ONLY the org's WEBINAR events", () => {
    expect(buildEventAccessWhere(WEBINARS_USER, "evX")).toEqual({
      id: "evX",
      organizationId: "org1",
      eventType: "WEBINAR",
    });
  });

  // Aug 10, 2026: the desk surface went org-wide (MEMBER parity — the role is
  // internal staff). It used to be `webinars OR conferences assigned via
  // onsiteUserIds`; the assignment is now irrelevant to this role.
  it("desk surface resolves EVERY event in the org (MEMBER parity)", () => {
    expect(buildEventAccessWhere(WEBINARS_USER, "evX", { surface: "desk" })).toEqual({
      id: "evX",
      organizationId: "org1",
    });
  });

  it("desk surface matches MEMBER's scope exactly", () => {
    const member = { id: "web1", role: "MEMBER", organizationId: "org1" };
    expect(buildEventAccessWhere(WEBINARS_USER, "evX", { surface: "desk" })).toEqual(
      buildEventAccessWhere(member, "evX"),
    );
  });

  // The load-bearing one. ~55 route files opt this role into full control via
  // WEBINAR_STAFF_ALLOW and depend on the MANAGE where to keep that control off
  // conferences. If someone ever widens the default the way the desk surface was
  // widened, every one of them fails OPEN — and nothing else in the suite would
  // notice, because each of those routes would simply start succeeding.
  it("manage surface stays WEBINAR-only — it must NOT follow desk org-wide", () => {
    const manage = buildEventAccessWhere(WEBINARS_USER, "evX");
    expect(manage).toHaveProperty("eventType", "WEBINAR");
    expect(manage).not.toEqual(buildEventAccessWhere(WEBINARS_USER, "evX", { surface: "desk" }));
  });

  it("both surfaces stay org-bound — a foreign event id can never match", () => {
    for (const surface of ["manage", "desk"] as const) {
      expect(
        buildEventAccessWhere(WEBINARS_USER, "evX", { surface }),
      ).toHaveProperty("organizationId", "org1");
    }
  });

  it("the surface flag is a no-op for every other role", () => {
    for (const role of ["ADMIN", "ORGANIZER", "MEMBER", "ONSITE"]) {
      const user = { id: "u1", role, organizationId: "org1" };
      expect(buildEventAccessWhere(user, "evX", { surface: "desk" })).toEqual(
        buildEventAccessWhere(user, "evX"),
      );
    }
  });
});

describe("denyReviewer — WEBINARS opt-in matrix", () => {
  const session = { user: { id: "web1", role: "WEBINARS" } };

  it("blocked by default (fails closed on unswept routes)", () => {
    expect(denyReviewer(session)).not.toBeNull();
  });

  it("allowed via WEBINAR_STAFF_ALLOW (full-control routes)", () => {
    expect(denyReviewer(session, { allow: WEBINAR_STAFF_ALLOW })).toBeNull();
  });

  it("allowed via REGISTRATION_DESK_ALLOW (desk routes)", () => {
    expect(denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW })).toBeNull();
  });

  it("is an org team role (Settings → Users list + invite)", () => {
    expect(TEAM_ROLES).toContain("WEBINARS");
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
