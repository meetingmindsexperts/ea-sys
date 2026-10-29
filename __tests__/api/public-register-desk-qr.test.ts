/**
 * The desk QR on the real public register route (docs/ONSITE_DESK_PLAN.md §8).
 * A valid token relaxes exactly four things (no password, no sales end, a
 * per-QR rate limit, the type and code fixed for exhibitors) and refuses
 * anything that would cost money; an expired or forged one is refused, and
 * no token at all is the ordinary public form.
 *
 * The transaction runs against a mocked client so the code and price rules,
 * which are decided inside it, are the route's own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.NEXTAUTH_SECRET = "test-secret-for-desk-qr";

const { mockDb, tx, mockApiLogger, rateKeys, rateLimits, claimPromo, ensureAccount, sendConfirmation } = vi.hoisted(() => {
  const tx = {
    registration: { findFirst: vi.fn(), create: vi.fn() },
    attendee: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  return {
    tx,
    mockDb: {
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      pricingTier: { findFirst: vi.fn(), findMany: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    rateKeys: [] as string[],
    rateLimits: new Map<string, number>(),
    claimPromo: vi.fn(),
    ensureAccount: vi.fn(),
    sendConfirmation: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  dbOperator: mockDb,
  tenantTransaction: (fn: (t: typeof tx) => unknown) => fn(tx),
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: ({ key, limit }: { key: string; limit: number }) => {
    rateKeys.push(key);
    rateLimits.set(key.split(":").slice(0, 2).join(":"), limit);
    return { allowed: true, retryAfterSeconds: 0 };
  },
}));
vi.mock("@/lib/registration-email-lock", () => ({ lockRegistrationEmails: vi.fn(async () => undefined) }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 7) }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: sendConfirmation }));
vi.mock("@/lib/webinar-email-sequence", () => ({ sendWebinarConfirmationForRegistration: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn(async () => undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/dtcm-pool", () => ({ claimSpareDtcmCode: vi.fn(async () => undefined) }));
vi.mock("@/lib/registrant-account", () => ({ ensureRegistrantAccount: ensureAccount }));
vi.mock("@/lib/registration-seat-db", () => ({ claimEventSeats: vi.fn(async () => true), claimSeats: vi.fn(async () => true) }));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: () => ({}) }));
vi.mock("@/services/promo-code-service", () => ({ claimPromoCodeInTx: claimPromo, recordPromoRedemptionInTx: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/public/events/[slug]/register/route";
import { mintDeskQrToken, DESK_QR_TTL_SECONDS } from "@/lib/desk-qr-token";

const EVENT_ID = "evt-1";
const params = Promise.resolve({ slug: "BHS2026" });

const PHYSICIAN = { id: "tt-phys", name: "Physician", price: 0, currency: "USD", quantity: 999999, soldCount: 0, isFaculty: false, requiresApproval: false, virtualPrice: null };
const EXHIBITOR = { ...PHYSICIAN, id: "tt-exh", name: "Exhibitor" };
type Tier = { id: string; name: string; price: number; currency: string; quantity: number; soldCount: number; requiresApproval: boolean; salesStart: Date | null; salesEnd: Date | null };
const COMP: Tier = { id: "tier-comp", name: "Complimentary", price: 0, currency: "USD", quantity: 999999, soldCount: 0, requiresApproval: false, salesStart: null, salesEnd: null };
const INCLUSIVE = { ...COMP, id: "tier-inc", name: "Inclusive" };
const STANDARD = { ...COMP, id: "tier-std", name: "Standard", price: 350 };

function compToken(over: Partial<Parameters<typeof mintDeskQrToken>[0]> = {}, now = Date.now()) {
  return mintDeskQrToken({ eventId: EVENT_ID, kind: "complimentary", rate: "complimentary", promoCodeId: null, issuedBy: "staff-1", ...over }, now).token;
}
function exhibitorToken() {
  return mintDeskQrToken({ eventId: EVENT_ID, kind: "exhibitor", rate: "inclusive", promoCodeId: "promo-csl", issuedBy: "staff-1" }).token;
}

function body(extra: Record<string, unknown> = {}) {
  return {
    ticketTypeId: "tt-phys",
    pricingTierId: "tier-comp",
    title: "DR",
    role: "PHYSICIAN",
    firstName: "Hajar",
    lastName: "Almaqbali",
    email: "hajar@example.com",
    organization: "Clinic",
    jobTitle: "Consultant",
    phone: "+971500000000",
    city: "Muscat",
    country: "Oman",
    specialty: "Hematology",
    agreeTerms: true,
    ...extra,
  };
}

async function post(extra: Record<string, unknown> = {}) {
  const res = await POST(new Request("http://t", { method: "POST", body: JSON.stringify(body(extra)) }), { params });
  return { status: res.status, json: await res.json() };
}

function on(type: typeof PHYSICIAN, tier: Tier | null) {
  mockDb.ticketType.findFirst.mockResolvedValue(type);
  mockDb.pricingTier.findFirst.mockResolvedValue(tier);
}

beforeEach(() => {
  vi.clearAllMocks();
  rateKeys.length = 0;
  rateLimits.clear();
  ensureAccount.mockResolvedValue("created-without-password");
  mockDb.event.findFirst.mockResolvedValue({
    id: EVENT_ID, name: "BHS", eventType: "CONFERENCE", organizationId: "org-1",
    settings: { codeRequiredTiers: ["inclusive"] }, maxAttendees: null, seatCount: 0,
    startDate: new Date("2026-10-24"), endDate: new Date("2026-10-25"), timezone: "Asia/Dubai",
    taxRate: null, taxLabel: null, bankDetails: null, supportEmail: null, requiresDtcmBarcode: false,
    venue: "X", city: "Fujairah", country: "UAE",
    organization: { name: "MMG", logo: null, companyName: null, companyAddress: null, companyCity: null, companyState: null, companyZipCode: null, companyCountry: null, taxId: null },
  });
  mockDb.auditLog.create.mockResolvedValue({});
  tx.registration.findFirst.mockResolvedValue(null);
  tx.attendee.findFirst.mockResolvedValue(null);
  tx.attendee.create.mockResolvedValue({ id: "att-1" });
  tx.registration.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "reg-1", serialId: 7, status: "CONFIRMED", qrCode: "BC", sponsorId: data.sponsorId ?? null,
    paymentStatus: data.paymentStatus, billingFirstName: null, billingLastName: null, billingEmail: null,
    billingPhone: null, billingAddress: null, billingCity: null, billingState: null, billingZipCode: null,
    billingCountry: null, taxNumber: null,
  }));
  on(PHYSICIAN, COMP);
});

describe("a valid complimentary desk QR", () => {
  it("registers with no password, makes the account without one, and emails how to set it", async () => {
    const r = await post({ deskToken: compToken() });
    expect(r.status).toBe(201);
    expect(tx.registration.create.mock.calls[0][0].data).toMatchObject({ paymentStatus: "COMPLIMENTARY", originalPrice: 0 });
    expect(ensureAccount).toHaveBeenCalledWith(expect.objectContaining({ password: undefined, withoutPassword: true }));
    expect(sendConfirmation.mock.calls[0][0].setPasswordUrl).toBe(
      "https://events.meetingmindsgroup.com/e/BHS2026/forgot-password?email=hajar%40example.com",
    );
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ deskQr: { kind: "complimentary", issuedBy: "staff-1" } });
  });

  it("swaps the per-IP limits for a per-QR one and a looser per-IP one; the first ceiling and per-email limit stay", async () => {
    await post({ deskToken: compToken() });
    expect(rateLimits.get("public-register:desk")).toBe(120);
    expect(rateLimits.get("public-register:desk-ip")).toBe(30);
    expect(rateLimits.get("public-register:first")).toBe(60);
    expect(rateKeys.some((k) => k.startsWith("public-register:burst:") || k.startsWith("public-register:ip:"))).toBe(false);
    expect(rateKeys).toContain("public-register:email:hajar@example.com");
  });

  it("registers in person even when the request asks for virtual on a hybrid event", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce({ ...(await mockDb.event.findFirst()), eventType: "HYBRID" });
    await post({ deskToken: compToken(), attendanceMode: "VIRTUAL" });
    expect(tx.registration.create.mock.calls[0][0].data).toMatchObject({ attendanceMode: "IN_PERSON", qrCode: expect.any(String) });
  });

  it("offers to set a password only when it made the account", async () => {
    ensureAccount.mockResolvedValueOnce("linked");
    await post({ deskToken: compToken() });
    expect(sendConfirmation.mock.calls[0][0].setPasswordUrl).toBeNull();
  });

  it("ignores a rate's sales end, not its start", async () => {
    on(PHYSICIAN, { ...COMP, salesEnd: new Date(Date.now() - 86_400_000) });
    expect((await post({ deskToken: compToken() })).status).toBe(201);
    on(PHYSICIAN, { ...COMP, salesStart: new Date(Date.now() + 86_400_000) });
    expect((await post({ deskToken: compToken() })).status).toBe(400);
  });

  it("refuses another rate, the Exhibitor type, a code, or anything with a price", async () => {
    on(PHYSICIAN, STANDARD);
    expect((await post({ deskToken: compToken(), pricingTierId: "tier-std" })).json.code).toBe("DESK_QR_WRONG_RATE");
    on(EXHIBITOR, COMP);
    expect((await post({ deskToken: compToken(), ticketTypeId: "tt-exh" })).json.code).toBe("DESK_QR_WRONG_TYPE");
    on(PHYSICIAN, COMP);
    claimPromo.mockResolvedValueOnce({ ok: true, claim: { promo: { id: "promo-x", code: "X", sponsor: null }, discountAmount: 0, sponsorCovered: false } });
    expect((await post({ deskToken: compToken(), promoCode: "X" })).json.code).toBe("DESK_QR_WRONG_CODE");
    on(PHYSICIAN, { ...COMP, price: 100 });
    expect((await post({ deskToken: compToken() })).json.code).toBe("DESK_QR_NOT_FREE");
  });
});

describe("an exhibitor desk QR", () => {
  beforeEach(() => on(EXHIBITOR, INCLUSIVE));

  it("registers the exhibitor with their sponsor's code: INCLUSIVE, credited to the sponsor", async () => {
    claimPromo.mockResolvedValueOnce({ ok: true, claim: { promo: { id: "promo-csl", code: "CSL", sponsorId: "sp-csl", sponsor: { name: "CSL" } }, discountAmount: 0, sponsorCovered: true } });
    const r = await post({ deskToken: exhibitorToken(), ticketTypeId: "tt-exh", pricingTierId: "tier-inc", promoCode: "CSL" });
    expect(r.status).toBe(201);
    expect(tx.registration.create.mock.calls[0][0].data).toMatchObject({ paymentStatus: "INCLUSIVE", sponsorId: "sp-csl", badgeType: "Exhibitor" });
  });

  it("refuses another sponsor's code, and a delegate type", async () => {
    claimPromo.mockResolvedValueOnce({ ok: true, claim: { promo: { id: "promo-roche", code: "ROCHE", sponsorId: "sp-r", sponsor: { name: "Roche" } }, discountAmount: 0, sponsorCovered: true } });
    expect((await post({ deskToken: exhibitorToken(), ticketTypeId: "tt-exh", pricingTierId: "tier-inc", promoCode: "ROCHE" })).json.code).toBe("DESK_QR_WRONG_CODE");
    on(PHYSICIAN, INCLUSIVE);
    expect((await post({ deskToken: exhibitorToken(), pricingTierId: "tier-inc", promoCode: "CSL" })).json.code).toBe("DESK_QR_WRONG_TYPE");
  });
});

describe("a token that does not hold", () => {
  it("expired: refused, with the scan-again message", async () => {
    const old = compToken({}, Date.now() - (DESK_QR_TTL_SECONDS + 1) * 1000);
    const r = await post({ deskToken: old });
    expect(r).toMatchObject({ status: 400, json: { code: "DESK_QR_EXPIRED" } });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("a junk token or a body that is not JSON is refused behind the first per-IP ceiling", async () => {
    expect((await post({ deskToken: "junk" })).json.code).toBe("DESK_QR_INVALID");
    expect(rateKeys).toContain("public-register:first:1.2.3.4");
    rateKeys.length = 0;
    const res = await POST(new Request("http://t", { method: "POST", body: "{not json" }), { params });
    expect(res.status).toBe(400);
    expect(rateKeys).toEqual(["public-register:first:1.2.3.4"]);
  });

  it("tampered or for another event: refused", async () => {
    const [bodyPart, sig] = compToken().split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(bodyPart, "base64url").toString()), kind: "exhibitor" })).toString("base64url")}.${sig}`;
    expect((await post({ deskToken: forged })).json.code).toBe("DESK_QR_INVALID");
    expect((await post({ deskToken: compToken({ eventId: "evt-other" }) })).json.code).toBe("DESK_QR_INVALID");
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("no token: the ordinary public form (per-IP limits, no account without a password)", async () => {
    const r = await post();
    expect(r.status).toBe(201);
    expect(rateKeys.some((k) => k.startsWith("public-register:burst:"))).toBe(true);
    expect(ensureAccount).toHaveBeenCalledWith(expect.objectContaining({ withoutPassword: false }));
    expect(sendConfirmation.mock.calls[0][0].setPasswordUrl).toBeNull();
  });
});
