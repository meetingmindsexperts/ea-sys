/**
 * Attributing a promo code to a sponsor from the EDIT path.
 *
 * Phase 1 of sponsor attribution shipped `sponsorId` on the create route only,
 * so an organiser could attribute a code at the moment they made it and never
 * afterwards: **every code that already existed was permanently unattributable**
 * through the product. That is the gap these tests pin closed.
 *
 * The cases worth reading are the ones that fail quietly:
 *
 *  - omitting the key must LEAVE the attribution alone, not clear it. A PUT
 *    that sends a partial body is the normal shape here, and treating "absent"
 *    as "null" would strip a sponsor every time someone renamed a code.
 *  - "" must become NULL. Since phase 2 put a foreign key on the column, an
 *    empty string is a constraint violation rather than a harmless blank, so
 *    without normalisation a form Select reporting "no selection" produces an
 *    opaque 500 instead of clearing the field.
 *  - the detail GET must redact like its list sibling. A field hidden on one
 *    route and readable one route over is not hidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, sponsorExistsSpy } = vi.hoisted(() => {
  const promoCode = { findFirst: vi.fn(), update: vi.fn() };
  const promoCodeTicketType = { deleteMany: vi.fn(), createMany: vi.fn() };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      promoCode,
      promoCodeTicketType,
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({ promoCode, promoCodeTicketType })),
    },
    mockAuth: vi.fn(),
    sponsorExistsSpy: vi.fn(),
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/sponsors", () => ({ sponsorExistsOnEvent: sponsorExistsSpy }));
// requireOrgId + denyReviewer stay REAL: they are pure and they are the guards.

import { GET, PUT } from "@/app/api/events/[eventId]/promo-codes/[promoCodeId]/route";

const params = Promise.resolve({ eventId: "ev-1", promoCodeId: "promo-1" });
const req = (body?: unknown) => ({ json: async () => body }) as unknown as Request;
const admin = { user: { id: "u1", role: "ADMIN", organizationId: "org-1" } };

/** The data payload handed to promoCode.update on the last call. */
const lastUpdateData = () => mockDb.promoCode.update.mock.calls.at(-1)?.[0]?.data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(admin);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
  mockDb.promoCode.findFirst.mockResolvedValue({ id: "promo-1" });
  mockDb.promoCode.update.mockResolvedValue({ id: "promo-1", code: "ABBOTT20", sponsorId: null });
  sponsorExistsSpy.mockResolvedValue(true);
});

describe("PUT — attributing an existing promo code", () => {
  it("sets the sponsor on a code that already existed", async () => {
    const res = await PUT(req({ sponsorId: "spn_abbott" }), { params });
    expect(res.status).toBe(200);
    expect(sponsorExistsSpy).toHaveBeenCalledWith("ev-1", "spn_abbott");
    expect(lastUpdateData()).toMatchObject({ sponsorId: "spn_abbott" });
  });

  it("LEAVES the attribution alone when the key is absent", async () => {
    // The load-bearing one. Editing a code's description must not silently
    // strip whose code it is.
    const res = await PUT(req({ description: "renamed" }), { params });
    expect(res.status).toBe(200);
    expect(lastUpdateData()).not.toHaveProperty("sponsorId");
    expect(sponsorExistsSpy).not.toHaveBeenCalled();
  });

  it("clears it on explicit null", async () => {
    const res = await PUT(req({ sponsorId: null }), { params });
    expect(res.status).toBe(200);
    expect(lastUpdateData()).toMatchObject({ sponsorId: null });
  });

  it('turns "" and whitespace into NULL rather than letting the FK reject them', async () => {
    for (const blank of ["", "   "]) {
      vi.clearAllMocks();
      mockAuth.mockResolvedValue(admin);
      mockDb.event.findFirst.mockResolvedValue({ id: "ev-1" });
      mockDb.promoCode.findFirst.mockResolvedValue({ id: "promo-1" });
      mockDb.promoCode.update.mockResolvedValue({ id: "promo-1", code: "X", sponsorId: null });
      const res = await PUT(req({ sponsorId: blank }), { params });
      expect(res.status, `blank ${JSON.stringify(blank)}`).toBe(200);
      expect(lastUpdateData()).toMatchObject({ sponsorId: null });
      // Nothing to look up, so no wasted round trip either.
      expect(sponsorExistsSpy).not.toHaveBeenCalled();
    }
  });

  it("refuses an id that is not a sponsor on THIS event, and writes nothing", async () => {
    sponsorExistsSpy.mockResolvedValue(false);
    const res = await PUT(req({ sponsorId: "spn_from_another_event" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SPONSOR_NOT_FOUND");
    // Refused BEFORE the transaction, so a bad id costs no write at all.
    expect(mockDb.promoCode.update).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("records the new attribution on the audit row", async () => {
    // Attribution decides whose report a registration lands in, so "who
    // changed it, and when" has to be answerable from the trail.
    await PUT(req({ sponsorId: "spn_abbott" }), { params });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "UPDATE_PROMO_CODE",
          changes: expect.objectContaining({ sponsorId: "spn_abbott" }),
        }),
      }),
    );
  });

  it("does not put sponsorId on the audit row when the edit did not touch it", async () => {
    await PUT(req({ description: "renamed" }), { params });
    const changes = mockDb.auditLog.create.mock.calls.at(-1)?.[0]?.data?.changes as Record<string, unknown>;
    expect(changes).not.toHaveProperty("sponsorId");
  });
});

describe("GET — the detail route redacts like its list sibling", () => {
  beforeEach(() => {
    mockDb.promoCode.findFirst.mockResolvedValue({
      id: "promo-1",
      code: "ABBOTT20",
      sponsorId: "spn_abbott",
      discountValue: 20,
      redemptions: [],
    });
  });

  it("hides sponsorId and the discount from a non-finance role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "CRM_USER", organizationId: "org-1" } });
    const body = (await (await GET(req(), { params })).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("sponsorId");
    expect(body).not.toHaveProperty("discountValue");
    expect(body.code).toBe("ABBOTT20");
  });

  it("shows both to a finance-capable role", async () => {
    const body = (await (await GET(req(), { params })).json()) as Record<string, unknown>;
    expect(body.sponsorId).toBe("spn_abbott");
    expect(body.discountValue).toBe(20);
  });
});
