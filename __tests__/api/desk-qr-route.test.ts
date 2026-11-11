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
    promoCode: { count: vi.fn() },
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

// Priced, unlimited and with no sales dates unless a test says otherwise. The
// price is a Decimal on the real row; the route reads it with Number().
const tier = (id: string, name: string, isActive = true, requiresApproval = false, price = 350) => ({
  id, name, isActive, requiresApproval, price, quantity: 999999, soldCount: 0, salesStart: null as Date | null, salesEnd: null as Date | null, sortOrder: 0,
});
const type = (id: string, name: string, pricingTiers: ReturnType<typeof tier>[]) => ({ id, name, quantity: 999999, soldCount: 0, pricingTiers });
const END = new Date(Date.now() + 2 * 86_400_000);
const EVENT = {
  id: "evt-1",
  slug: "BHS2026",
  eventType: "CONFERENCE",
  settings: { codeRequiredTiers: ["inclusive"] },
  endDate: END,
  timezone: "Asia/Dubai",
  maxAttendees: null as number | null,
  seatCount: 0,
  ticketTypes: [
    type("tt-phys", "Physician", [tier("t1", "Standard"), tier("t2", "Inclusive"), tier("t3", "Complimentary")]),
    type("tt-exh", "Exhibitor", [tier("t4", "Inclusive")]),
  ],
};

// A free event as production has them: Standard at 0 for every type, no Complimentary rate.
const free = (id: string, name: string, price = 0) => tier(id, name, true, false, price);
const FREE_EVENT = {
  ...EVENT,
  settings: {},
  ticketTypes: [type("tt-phys", "Physician", [free("f1", "Standard")]), type("tt-nurse", "Nurse", [free("f2", "Standard")])],
};

function tokenFrom(url: string) {
  return new URL(url).searchParams.get("desk")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.promoCode.count.mockResolvedValue(2);
  mockQr.mockResolvedValue(Buffer.from("png"));
});

describe("GET the options", () => {
  it("the Exhibitor rate and the Complimentary rate, valid to the end of the event", async () => {
    const json = await (await get()).json();
    expect(json).toMatchObject({
      webinar: false,
      registrationClosed: false,
      eventEnded: false,
      timezone: "Asia/Dubai",
      exhibitor: { rateName: "Inclusive", hasSponsorCodes: true },
      complimentary: { rateName: "Complimentary" },
      // Standard is on sale and paid: no free-registration tab.
      free: null,
    });
    // The end of the event's last day in Dubai: 23:59:59 local is 19:59:59Z.
    expect(json.exhibitor.validUntil).toMatch(/T19:59:59\.000Z$/);
  });

  it("says when no sponsor code could register an exhibitor", async () => {
    mockDb.promoCode.count.mockResolvedValueOnce(0);
    expect(await (await get()).json()).toMatchObject({ exhibitor: { hasSponsorCodes: false } });
    const where = mockDb.promoCode.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ eventId: "evt-1", isActive: true, sponsorCoversFee: true, sponsorId: { not: null } });
  });

  it("an invalid stored timezone falls back to the default instead of failing", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, timezone: "Not/AZone" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ timezone: "Asia/Dubai" });
  });

  it("nothing to offer when the event has neither", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, ticketTypes: [type("tt-phys", "Physician", [tier("t1", "Standard")])] });
    expect(await (await get()).json()).toMatchObject({ exhibitor: null, complimentary: null, free: null });
  });

  it("a free event with no Complimentary rate: the rate on sale, free for everyone", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(FREE_EVENT);
    expect(await (await get()).json()).toMatchObject({ exhibitor: null, complimentary: null, free: { rateName: "Standard", paidTypes: [] } });
  });

  it("free for some types only: names the types that pay, so the panel can say why there is no QR", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({
      ...FREE_EVENT,
      ticketTypes: [type("tt-phys", "Physician", [free("f1", "Early Bird", 400)]), type("tt-res", "Resident", [free("f2", "Early Bird")])],
    });
    expect(await (await get()).json()).toMatchObject({ free: { rateName: "Early Bird", paidTypes: ["Physician"] } });
  });

  it("reads each rate's price, seats and sales window, and the event's cap", async () => {
    await get();
    const select = mockDb.event.findFirst.mock.calls[0][0].select;
    expect(select).toMatchObject({ maxAttendees: true, seatCount: true });
    expect(select.ticketTypes.select).toMatchObject({ quantity: true, soldCount: true });
    expect(select.ticketTypes.select.pricingTiers.select).toMatchObject({ price: true, quantity: true, soldCount: true, salesStart: true, salesEnd: true, sortOrder: true });
  });

  it("needs a sign-in and the event inside the caller's grant", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
  });
});

describe("POST a QR", () => {
  it("one QR per event and kind, valid to the end of the event, the same every time; audited without the token", async () => {
    const first = await (await post({ kind: "complimentary" })).json();
    const again = await (await post({ kind: "complimentary" })).json();
    expect(first.url).toBe(again.url);
    expect(first.url).toMatch(/\/e\/BHS2026\/register\/complimentary\?desk=/);
    expect(first.qr).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    expect(first.expiresAt).toMatch(/T19:59:59\.000Z$/);
    expect(verifyDeskQrToken(tokenFrom(first.url))).toMatchObject({ ok: true, payload: { eventId: "evt-1", kind: "complimentary", rate: "complimentary" } });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: "DESK_QR_SHOWN", userId: "user-1", changes: { kind: "complimentary" } });
    expect(JSON.stringify(audit)).not.toContain(tokenFrom(first.url));
  });

  it("exhibitor: the Inclusive form, no sponsor named (they type their own code)", async () => {
    const json = await (await post({ kind: "exhibitor" })).json();
    expect(json.url).toMatch(/\/e\/BHS2026\/register\/inclusive\?desk=[^&]+$/);
    expect(verifyDeskQrToken(tokenFrom(json.url))).toMatchObject({ ok: true, payload: { kind: "exhibitor", rate: "inclusive", promoCodeId: null } });
  });

  it("free: the form of the rate on sale, one QR to the end of the event, taking no code", async () => {
    mockDb.event.findFirst.mockResolvedValue(FREE_EVENT);
    const first = await (await post({ kind: "free" })).json();
    const again = await (await post({ kind: "free" })).json();
    expect(first.url).toBe(again.url);
    expect(first.url).toMatch(/\/e\/BHS2026\/register\/standard\?desk=[^&]+$/);
    expect(first.expiresAt).toMatch(/T19:59:59\.000Z$/);
    expect(verifyDeskQrToken(tokenFrom(first.url))).toMatchObject({ ok: true, payload: { eventId: "evt-1", kind: "free", rate: "standard", promoCodeId: null } });
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "DESK_QR_SHOWN", changes: { kind: "free" } });
  });

  it("free: refused unless the rate on sale is free for every type", async () => {
    // Paid for everyone.
    expect(await (await post({ kind: "free" })).json()).toMatchObject({ code: "NO_FREE_RATE" });
    // Free for residents, paid for physicians: no QR, and the answer names who pays.
    mockDb.event.findFirst.mockResolvedValueOnce({
      ...FREE_EVENT,
      ticketTypes: [type("tt-phys", "Physician", [free("f1", "Early Bird", 400)]), type("tt-res", "Resident", [free("f2", "Early Bird")])],
    });
    const mixed = await post({ kind: "free" });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toMatchObject({ code: "NO_FREE_RATE", error: expect.stringContaining("Physician") });
    // A free Early Bird that is switched off, with a paid Standard on: never reopened.
    mockDb.event.findFirst.mockResolvedValueOnce({
      ...FREE_EVENT,
      ticketTypes: [type("tt-phys", "Physician", [tier("f1", "Early Bird", false, false, 0), free("f2", "Standard", 350)])],
    });
    expect(await (await post({ kind: "free" })).json()).toMatchObject({ code: "NO_FREE_RATE" });
    // The event's cap is reached.
    mockDb.event.findFirst.mockResolvedValueOnce({ ...FREE_EVENT, maxAttendees: 50, seatCount: 50 });
    expect(await (await post({ kind: "free" })).json()).toMatchObject({ code: "NO_FREE_RATE" });
    expect(mockQr).not.toHaveBeenCalled();
  });

  it("refuses a finished event, and an event without the rate", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, endDate: new Date(Date.now() - 2 * 86_400_000) });
    expect(await (await post({ kind: "exhibitor" })).json()).toMatchObject({ code: "EVENT_ENDED" });
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, ticketTypes: [EVENT.ticketTypes[0]] });
    expect(await (await post({ kind: "exhibitor" })).json()).toMatchObject({ code: "NO_EXHIBITOR_RATE" });
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, ticketTypes: [EVENT.ticketTypes[1]] });
    expect(await (await post({ kind: "complimentary" })).json()).toMatchObject({ code: "NO_COMPLIMENTARY_RATE" });
    expect(mockQr).not.toHaveBeenCalled();
  });

  it("never offers a rate that needs approval", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({
      ...EVENT,
      ticketTypes: [
        type("tt-phys", "Physician", [tier("t3", "Complimentary", true, true), tier("t5", "Standard", true, true, 0)]),
        type("tt-exh", "Exhibitor", [tier("t4", "Inclusive", true, true)]),
      ],
    });
    expect(await (await get()).json()).toMatchObject({ exhibitor: null, complimentary: null, free: null });
  });

  it("an Exhibitor sponsor-code rate that needs approval means no QR, not another of the type's rates", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({
      ...EVENT,
      ticketTypes: [type("tt-exh", "Exhibitor", [tier("t4", "Inclusive", true, true), tier("t5", "Standard")])],
    });
    expect(await (await get()).json()).toMatchObject({ exhibitor: null });
  });

  it("refuses while registration is switched off, and says so in the options", async () => {
    const closed = { ...EVENT, settings: { ...EVENT.settings, registrationOpen: false } };
    mockDb.event.findFirst.mockResolvedValueOnce(closed);
    expect(await (await get()).json()).toMatchObject({ registrationClosed: true });
    mockDb.event.findFirst.mockResolvedValueOnce(closed);
    expect(await (await post({ kind: "complimentary" })).json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(mockQr).not.toHaveBeenCalled();
  });

  it("refuses a webinar and a bad body", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...EVENT, eventType: "WEBINAR" });
    expect((await post({ kind: "complimentary" })).status).toBe(400);
    expect((await post({ kind: "vip" })).status).toBe(400);
  });

  it("a role without registrations.create gets 403", async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: "user-2", role: "CRM_USER", organizationId: "org-1" } });
    expect((await post({ kind: "complimentary" })).status).toBe(403);
    expect(mockQr).not.toHaveBeenCalled();
  });
});
