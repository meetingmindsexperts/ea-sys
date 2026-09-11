/**
 * Admin single-send "payment-reminder" email — the amount due must be resolved
 * the canonical (tier / virtual / discount / tax) way, NOT `ticketType.price`.
 * Before the fix a tier-priced registration (ticketType.price 0, real price on
 * the tier) rendered `{{amount}}` = "USD 0.00" + a `price=0` Pay-Now link — the
 * payment-collection email told the registrant they owed nothing.
 *
 * We mock `renderAndWrap` to capture the `vars` the route built and assert on
 * `vars.amount` / `vars.paymentBlock`. `registration-financials` is REAL (pure).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, renderAndWrapSpy, sendEmailSpy } = vi.hoisted(() => ({
  mockDb: {
    // The {{rsvpLink}} resolver reads invites (Sep 11, 2026); empty by default.
    rsvpInvite: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    // The route loads the sender's profile signature for {{organizerSignature}}.
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  renderAndWrapSpy: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  sendEmailSpy: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true }),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailSpy,
  loadActiveEventTemplateRow: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({
    slug: "payment-reminder",
    subject: "Payment reminder — {{eventName}}",
    htmlContent: "<p>Amount: {{amount}}</p>{{paymentBlock}}",
    textContent: "Amount: {{amount}}\n{{paymentBlock}}",
  }),
  renderAndWrap: renderAndWrapSpy,
  renderMessageValue: vi.fn((m: string) => m),
  brandingFrom: vi.fn().mockReturnValue({ email: "f@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
  sendRegistrationConfirmation: vi.fn(),
}));
vi.mock("@/lib/email-barcode", () => ({
  buildEntryBarcode: vi.fn(),
  templateUsesEntryBarcode: () => false,
}));
vi.mock("@/lib/email-change", () => ({ normalizeEmail: vi.fn(), repointOrgContactEmail: vi.fn() }));
// denyReviewer, utils, registration-financials are REAL (pure).

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/email/route";
import { getEventTemplate } from "@/lib/email";
import { apiLogger } from "@/lib/logger";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const req = () => new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ type: "payment-reminder" }) });

function event(extra: Record<string, unknown> = {}) {
  return {
    id: "ev1", slug: "my-event", name: "My Event", startDate: new Date("2026-11-01"),
    venue: "DWTC", city: "Dubai", address: "Trade Centre",
    taxRate: null, taxLabel: null, bankDetails: null, supportEmail: null,
    organizationId: "org1",
    organization: { name: "MMG", companyName: null, companyAddress: null, companyCity: null, companyState: null, companyZipCode: null, companyCountry: null, taxId: null, logo: null },
    ...extra,
  };
}

// Tier-priced type: base ticketType.price is 0, the real money is on the tier.
function tierRegistration(extra: Record<string, unknown> = {}) {
  return {
    id: "reg1", serialId: 7, eventId: "ev1", qrCode: "QR", attendanceMode: "IN_PERSON",
    originalPrice: 400, discountAmount: null,
    attendee: { firstName: "A", lastName: "B", email: "a@b.com", additionalEmail: null, title: null, organization: null, jobTitle: null, city: null, country: null },
    ticketType: { name: "Standard", price: 0, currency: "USD" },
    pricingTier: { name: "Early Bird", price: 400, currency: "USD" },
    promoCode: null,
    billingFirstName: null, billingLastName: null, billingEmail: null, billingPhone: null,
    billingAddress: null, billingCity: null, billingState: null, billingZipCode: null, billingCountry: null, taxNumber: null,
    ...extra,
  };
}

function capturedVars() {
  return renderAndWrapSpy.mock.calls[0][1] as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  renderAndWrapSpy.mockReturnValue({ subject: "s", html: "h", text: "t" });
  sendEmailSpy.mockResolvedValue({ success: true });
});

describe("payment-reminder email — amount due", () => {
  it("uses the tier price, not the $0 ticketType base", async () => {
    mockDb.event.findFirst.mockResolvedValue(event());
    mockDb.registration.findFirst.mockResolvedValue(tierRegistration());

    const res = await POST(req(), { params });
    expect(res.status).toBe(200);

    const vars = capturedVars();
    expect(vars.amount).toBe("USD 400.00"); // the tier price — NOT the $0 ticketType base
    expect(vars.paymentBlock).toContain("price=400"); // Pay-Now link carries the real amount
  });

  it("adds tax on the tier price so {{amount}} matches the checkout charge", async () => {
    mockDb.event.findFirst.mockResolvedValue(event({ taxRate: 5, taxLabel: "VAT" }));
    mockDb.registration.findFirst.mockResolvedValue(tierRegistration());

    await POST(req(), { params });
    expect(capturedVars().amount).toBe("USD 420.00"); // 400 + 5%
  });

  it("nets the promo discount before tax", async () => {
    mockDb.event.findFirst.mockResolvedValue(event({ taxRate: 5, taxLabel: "VAT" }));
    mockDb.registration.findFirst.mockResolvedValue(
      tierRegistration({ discountAmount: 100, promoCode: { code: "SAVE100" } }),
    );

    await POST(req(), { params });
    // (400 - 100) = 300, + 5% tax = 315
    expect(capturedVars().amount).toBe("USD 315.00");
  });

  it("prices a virtual registration off the stamped originalPrice, not the $0 base", async () => {
    mockDb.event.findFirst.mockResolvedValue(event());
    mockDb.registration.findFirst.mockResolvedValue(
      tierRegistration({ attendanceMode: "VIRTUAL", pricingTier: null, originalPrice: 150 }),
    );

    await POST(req(), { params });
    expect(capturedVars().amount).toBe("USD 150.00");
  });
});

// ── {{rsvpLink}} in a per-person send (Sep 11, 2026) ──────────────────────
// The organiser-reported gap: a saved template carrying the token was sent from
// the registration detail sheet and went out with the literal "{{rsvpLink}}",
// because this route had no RSVP resolution. Now it resolves from the invite
// the registrant holds, and refuses rather than sending the literal token.
describe("saved template with {{rsvpLink}} (single send)", () => {
  const rsvpTemplate = {
    slug: "joining-instruction-delegate",
    subject: "Joining Instructions",
    htmlContent: "<p>Room: Studio 1 {{rsvpLink}}</p>",
    textContent: "Room: Studio 1 {{rsvpLink}}",
  };
  const send = (body: Record<string, unknown>) =>
    POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params });

  beforeEach(() => {
    mockDb.event.findFirst.mockResolvedValue(event());
    mockDb.registration.findFirst.mockResolvedValue(tierRegistration());
  });

  it("resolves the registrant's own link (email + registrationId lookup, event-bound) and renders it raw", async () => {
    vi.mocked(getEventTemplate).mockResolvedValueOnce(rsvpTemplate as never);
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce([{ token: "tok1", campaign: { id: "c1", name: "Attendance", isActive: true } }]);
    const res = await send({ templateSlug: "joining-instruction-delegate" });
    expect(res.status).toBe(200);
    const where = mockDb.rsvpInvite.findMany.mock.calls[0][0].where;
    expect(where.eventId).toBe("ev1");
    expect(where.OR).toEqual([{ inviteeEmail: { equals: "a@b.com", mode: "insensitive" } }, { registrationId: "reg1" }]);
    expect(capturedVars().rsvpLink).toMatch(/\/e\/my-event\/rsvp\/tok1$/);
    expect(capturedVars().rsvpName).toBe("Attendance");
    expect(capturedVars().rsvpButton).toContain("/e/my-event/rsvp/tok1");
    const rawKeys = renderAndWrapSpy.mock.calls[0][3] as Set<string>;
    expect(rawKeys.has("rsvpLink")).toBe(true);
    expect(rawKeys.has("rsvpButton")).toBe(true);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses with 400 RSVP_NO_INVITE, logs, and sends nothing when the registrant is on no guest list", async () => {
    vi.mocked(getEventTemplate).mockResolvedValueOnce(rsvpTemplate as never);
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce([]);
    const res = await send({ templateSlug: "joining-instruction-delegate" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("RSVP_NO_INVITE");
    expect(body.error).toContain("{{rsvpLink}}");
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(vi.mocked(apiLogger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "events/registrations/email:rsvp-link-unresolved", code: "NO_INVITE" }),
    );
  });

  it("also resolves the token typed into a custom message, and never reads invites for a template without it", async () => {
    // Custom message carrying the token: resolved, so renderMessageValue has the var.
    mockDb.rsvpInvite.findMany.mockResolvedValueOnce([{ token: "tok2", campaign: { id: "c1", name: "Attendance", isActive: true } }]);
    let res = await send({ type: "custom", customSubject: "Hi", customMessage: "Confirm here: {{rsvpLink}}" });
    expect(res.status).toBe(200);
    expect(capturedVars().rsvpLink).toMatch(/\/rsvp\/tok2$/);
    // A plain reminder: no token anywhere, no invite query at all.
    mockDb.rsvpInvite.findMany.mockClear();
    res = await send({ type: "reminder" });
    expect(res.status).toBe(200);
    expect(mockDb.rsvpInvite.findMany).not.toHaveBeenCalled();
  });
});
