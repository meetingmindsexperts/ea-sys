/**
 * GET/POST .../registrations/desk-qr: the desk's Walk-in QR
 * (docs/ONSITE_DESK_PLAN.md §8.1). The options the panel offers, and the
 * 30-minute QR for one of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.NEXTAUTH_SECRET = "test-secret-for-desk-qr";

const { mockAuth, mockDb, mockQr } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    promoCode: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockQr: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/barcode", () => ({ renderQrPng: (...a: unknown[]) => mockQr(...a) }));

import { GET, POST } from "@/app/api/events/[eventId]/registrations/desk-qr/route";
import { verifyDeskQrToken } from "@/lib/desk-qr-token";

const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const get = () => GET(new Request("http://x/desk-qr"), params);
const post = (body: unknown) => POST(new Request("http://x/desk-qr", { method: "POST", body: JSON.stringify(body) }), params);

const tier = (id: string, name: string, isActive = true, requiresApproval = false) => ({ id, name, isActive, requiresApproval });
const EVENT = {
  id: "evt-1",
  slug: "BHS2026",
  eventType: "CONFERENCE",
  settings: { codeRequiredTiers: ["inclusive"] },
  ticketTypes: [
    { id: "tt-phys", name: "Physician", pricingTiers: [tier("t1", "Standard"), tier("t2", "Inclusive"), tier("t3", "Complimentary")] },
    { id: "tt-exh", name: "Exhibitor", pricingTiers: [tier("t4", "Inclusive")] },
  ],
};
const CODE = (over: Record<string, unknown> = {}) => ({
  id: "promo-csl", code: "CSL", maxUses: 10, usedCount: 3, sponsorId: "sp-csl", sponsorCoversFee: true,
  sponsor: { name: "CSL" }, ticketTypes: [], ...over,
});

function tokenFrom(url: string) {
  return new URL(url).searchParams.get("desk")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.promoCode.findMany.mockResolvedValue([CODE(), CODE({ id: "promo-x", code: "X", ticketTypes: [{ ticketTypeId: "tt-phys" }] })]);
  mockDb.auditLog.create.mockResolvedValue({});
  mockQr.mockResolvedValue(Buffer.from("png"));
});

describe("GET the options", () => {
  it("the Exhibitor rate with the sponsors' codes valid for it, and the Complimentary rate", async () => {
    const res = await get();
    expect(await res.json()).toEqual({
      webinar: false,
      registrationClosed: false,
      exhibitor: { rateName: "Inclusive", sponsors: [{ promoCodeId: "promo-csl", code: "CSL", sponsorName: "CSL", placesLeft: 7 }] },
      complimentary: { rateName: "Complimentary" },
    });
  });

  it("nothing to offer when the event has neither", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, ticketTypes: [{ id: "tt-phys", name: "Physician", pricingTiers: [tier("t1", "Standard")] }] });
    expect(await (await get()).json()).toMatchObject({ exhibitor: null, complimentary: null });
  });

  it("needs a sign-in and the event inside the caller's grant", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
  });
});

describe("POST a QR", () => {
  it("complimentary: a link to that rate's form with a 30-minute token, its QR, and an audit row without the token", async () => {
    const res = await post({ kind: "complimentary" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toMatch(/\/e\/BHS2026\/register\/complimentary\?desk=/);
    expect(json.qr).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    const verdict = verifyDeskQrToken(tokenFrom(json.url));
    expect(verdict).toMatchObject({ ok: true, payload: { eventId: "evt-1", kind: "complimentary", rate: "complimentary", issuedBy: "user-1" } });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: "DESK_QR_SHOWN", changes: { kind: "complimentary" } });
    expect(JSON.stringify(audit)).not.toContain(tokenFrom(json.url));
  });

  it("exhibitor: the Inclusive form with the sponsor's code in the link and in the token", async () => {
    const json = await (await post({ kind: "exhibitor", promoCodeId: "promo-csl" })).json();
    expect(json.url).toMatch(/\/e\/BHS2026\/register\/inclusive\?desk=.+&promo=CSL$/);
    expect(verifyDeskQrToken(tokenFrom(json.url))).toMatchObject({ ok: true, payload: { kind: "exhibitor", rate: "inclusive", promoCodeId: "promo-csl" } });
  });

  it("refuses a code that is not a sponsor's for exhibitors, and an event with no such rate", async () => {
    expect((await post({ kind: "exhibitor", promoCodeId: "promo-x" })).status).toBe(400);
    mockDb.promoCode.findMany.mockResolvedValueOnce([CODE({ sponsorCoversFee: false })]);
    expect((await post({ kind: "exhibitor", promoCodeId: "promo-csl" })).status).toBe(400);
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, ticketTypes: [EVENT.ticketTypes[0]] });
    expect(await (await post({ kind: "exhibitor", promoCodeId: "promo-csl" })).json()).toMatchObject({ code: "NO_EXHIBITOR_RATE" });
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, ticketTypes: [EVENT.ticketTypes[1]] });
    expect(await (await post({ kind: "complimentary" })).json()).toMatchObject({ code: "NO_COMPLIMENTARY_RATE" });
    expect(mockQr).not.toHaveBeenCalled();
  });

  it("never offers a rate that needs approval", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({
      ...EVENT,
      ticketTypes: [
        { id: "tt-phys", name: "Physician", pricingTiers: [tier("t3", "Complimentary", true, true)] },
        { id: "tt-exh", name: "Exhibitor", pricingTiers: [tier("t4", "Inclusive", true, true)] },
      ],
    });
    expect(await (await get()).json()).toMatchObject({ exhibitor: null, complimentary: null });
  });

  it("refuses while registration is switched off, and says so in the options", async () => {
    const closed = { ...EVENT, settings: { ...EVENT.settings, registrationOpen: false } };
    mockDb.event.findFirst.mockResolvedValueOnce(closed);
    expect(await (await get()).json()).toMatchObject({ registrationClosed: true });
    mockDb.event.findFirst.mockResolvedValueOnce(closed);
    expect(await (await post({ kind: "complimentary" })).json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(mockQr).not.toHaveBeenCalled();
  });

  it("refuses a sponsor with no places left", async () => {
    mockDb.promoCode.findMany.mockResolvedValueOnce([CODE({ usedCount: 10 })]);
    expect(await (await post({ kind: "exhibitor", promoCodeId: "promo-csl" })).json()).toMatchObject({ code: "SPONSOR_CODE_FULL" });
    expect(mockQr).not.toHaveBeenCalled();
  });

  it("refuses a webinar and a bad body", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, eventType: "WEBINAR" });
    expect((await post({ kind: "complimentary" })).status).toBe(400);
    expect((await post({ kind: "vip" })).status).toBe(400);
    expect((await post({ kind: "exhibitor" })).status).toBe(400);
  });

  it("a role without registrations.create gets 403", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "user-2", role: "CRM_USER", organizationId: "org-1" } });
    expect((await post({ kind: "complimentary" })).status).toBe(403);
    expect(mockQr).not.toHaveBeenCalled();
  });
});
