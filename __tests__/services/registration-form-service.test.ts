/**
 * Registration form links at a chosen rate (docs/REGISTRATION_FORM_LINKS_PLAN.md).
 * Pins the checks (every skip reason), the stamp table (plan 3.2), the guard
 * on the stamp, the link (rate in the identifier, lifetime, older links
 * revoked) and that a failed email keeps the stamp but loses the link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx, sendEmailMock, getEventTemplateMock, transitionMock } = vi.hoisted(() => {
  const tx = {
    registration: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    // The onsite link checks, revokes and creates inside one tenant transaction.
    verificationToken: { findFirst: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return {
    tx,
    sendEmailMock: vi.fn(),
    transitionMock: vi.fn(),
    getEventTemplateMock: vi.fn(),
    mockDb: {
      event: { findFirst: vi.fn() },
      sponsor: { findFirst: vi.fn() },
      registration: { findMany: vi.fn() },
      verificationToken: { deleteMany: vi.fn(), create: vi.fn() },
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (t: typeof tx) => unknown) => fn(tx) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/registration-seat-db", () => ({ applyRegistrationTransition: transitionMock }));
vi.mock("@/lib/security", () => ({ hashVerificationToken: (t: string) => `hashed:${t}` }));
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailMock,
  getEventTemplate: getEventTemplateMock,
  renderAndWrap: (tpl: { subject: string; htmlContent: string; textContent: string }, vars: Record<string, string>) => ({
    subject: tpl.subject,
    htmlContent: tpl.htmlContent.replace("{{registrationFormLink}}", vars.registrationFormLink).replace("{{linkExpiresIn}}", vars.linkExpiresIn),
    textContent: "",
  }),
  brandingFrom: () => undefined,
}));

import {
  mintOnsiteCompletionLink,
  mintRegistrationFormLink,
  prepareRegistrationForms,
  sendRegistrationForms,
  stampedPaymentStatus,
} from "@/services/registration-form-service";

const NOW = Date.now();
const DAY = 86_400_000;
const rate = (over: Record<string, unknown> = {}) => ({
  id: "t-eb", name: "Early Bird", price: 250, currency: "USD", quantity: 999999, soldCount: 0,
  isActive: true, salesStart: null, salesEnd: new Date(NOW + 10 * DAY), sortOrder: 0, ...over,
});
const physician = { id: "tt-phys", name: "Physician", pricingTiers: [rate(), rate({ id: "t-inc", name: "Inclusive", price: 0, salesEnd: null, sortOrder: 1 })] };
const exhibitor = { id: "tt-exh", name: "Exhibitor", pricingTiers: [rate({ id: "t-exh-inc", name: "Inclusive", price: 0, salesEnd: null })] };

function reg(over: Record<string, unknown> = {}) {
  return {
    id: "reg-1", status: "CONFIRMED", userId: null, paymentStatus: "COMPLIMENTARY", refundedAmount: 0,
    groupId: null, promoCodeId: null, sponsorId: null, ticketTypeId: "tt-phys",
    pricingTierId: null, originalPrice: null, attendanceMode: "IN_PERSON", createdSource: "CSV_IMPORT",
    attendee: { email: "a@x.test", title: "DR", firstName: "Ann", lastName: "Lee" },
    ticketType: physician,
    _count: { payments: 0, invoices: 0 },
    ...over,
  };
}

const BASE = {
  eventId: "ev-1", organizationId: "org-1", registrationIds: ["reg-1"],
  rate: { kind: "rate" as const, slug: "early-bird" }, actorUserId: "u-1", source: "rest" as const,
};
const stampData = () => tx.registration.updateMany.mock.calls[0]?.[0]?.data;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev-1", slug: "BHS2026", timezone: "Asia/Dubai",
    settings: { codeRequiredTiers: ["inclusive"] },
    ticketTypes: [physician, exhibitor],
  });
  mockDb.registration.findMany.mockResolvedValue([reg()]);
  mockDb.sponsor.findFirst.mockResolvedValue({ id: "sp-1" });
  tx.registration.updateMany.mockResolvedValue({ count: 1 });
  tx.auditLog.create.mockResolvedValue({});
  transitionMock.mockResolvedValue(undefined);
  mockDb.verificationToken.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.verificationToken.create.mockResolvedValue({});
  getEventTemplateMock.mockResolvedValue({
    subject: "Complete", htmlContent: "<a href='{{registrationFormLink}}'>go</a> {{linkExpiresIn}}", textContent: "", branding: {},
  });
  sendEmailMock.mockResolvedValue({ success: true });
});

describe("the stamp (plan 3.2)", () => {
  it("a paid rate on a typed registration: rate, price, UNASSIGNED", async () => {
    const res = await prepareRegistrationForms(BASE);
    expect(res).toMatchObject({ ok: true, rateName: "Early Bird", skipped: [] });
    expect(stampData()).toEqual({ pricingTierId: "t-eb", originalPrice: 250, paymentStatus: "UNASSIGNED", sponsorId: null });
    // Guarded on what was checked, so a payment or completion in between loses.
    expect(tx.registration.updateMany.mock.calls[0][0].where).toMatchObject({ id: "reg-1", userId: null, ticketTypeId: "tt-phys" });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "REGISTRATION_FORM_RATE_SET", entityId: "reg-1" });
  });

  it("a sponsor-link rate: INCLUSIVE for the chosen sponsor, nothing to pay", async () => {
    await prepareRegistrationForms({ ...BASE, rate: { kind: "rate", slug: "inclusive" }, sponsorId: "sp-1" });
    expect(stampData()).toEqual({ pricingTierId: "t-inc", originalPrice: 0, paymentStatus: "INCLUSIVE", sponsorId: "sp-1" });
  });

  it("complimentary: no rate, no price, COMPLIMENTARY", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ paymentStatus: "UNASSIGNED", pricingTierId: "t-eb" })]);
    const res = await prepareRegistrationForms({ ...BASE, rate: { kind: "complimentary" } });
    expect(res).toMatchObject({ ok: true, rateName: "Complimentary" });
    expect(stampData()).toEqual({ pricingTierId: null, originalPrice: 0, paymentStatus: "COMPLIMENTARY", sponsorId: null });
  });

  it("a typeless registration is not priced now; the rate rides in its link", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ ticketTypeId: null, ticketType: null })]);
    const res = await prepareRegistrationForms(BASE);
    expect(res).toMatchObject({ ok: true, ready: [{ registrationId: "reg-1", ticketTypeName: null }] });
    expect(stampData()).toEqual({ sponsorId: null });
  });

  it("a virtual attendee is stamped at the type's virtual price (review M3)", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ attendanceMode: "VIRTUAL", ticketType: { ...physician, virtualPrice: 40 } })]);
    await prepareRegistrationForms(BASE);
    expect(stampData()).toMatchObject({ pricingTierId: "t-eb", originalPrice: 40, paymentStatus: "UNASSIGNED" });
  });

  it("a sold-out rate is still sent: its seat count is checked when a seat moves, not here (review M2)", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ ticketType: { ...physician, pricingTiers: [rate({ soldCount: 5, quantity: 5 })] } })]);
    const res = await prepareRegistrationForms(BASE);
    expect(res).toMatchObject({ ok: true, skipped: [] });
  });

  it("payment status follows the price, keeping an explicit UNPAID", () => {
    expect(stampedPaymentStatus("COMPLIMENTARY", 250, false)).toBe("UNASSIGNED");
    expect(stampedPaymentStatus("UNPAID", 250, false)).toBe("UNPAID");
    expect(stampedPaymentStatus("UNASSIGNED", 0, false)).toBe("COMPLIMENTARY");
    expect(stampedPaymentStatus("UNASSIGNED", 0, true)).toBe("INCLUSIVE");
  });
});

describe("the checks: every skip reason, and nothing written for a skipped person", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["cancelled", { status: "CANCELLED" }, "CANCELLED"],
    ["has an account", { userId: "u-9" }, "HAS_ACCOUNT"],
    ["completed without an account", { completedAt: new Date("2026-10-01T00:00:00Z") }, "ALREADY_COMPLETED"],
    ["paid", { paymentStatus: "PAID" }, "MONEY_RECORDED"],
    ["a payment in flight", { paymentStatus: "PENDING" }, "MONEY_RECORDED"],
    ["an issued invoice", { _count: { payments: 0, invoices: 1 } }, "MONEY_RECORDED"],
    ["a refund", { refundedAmount: 10 }, "MONEY_RECORDED"],
    ["in a group", { groupId: "g-1" }, "IN_GROUP"],
    ["a promo code", { promoCodeId: "p-1" }, "PROMO_APPLIED"],
    ["a type without the rate", { ticketTypeId: "tt-exh", ticketType: exhibitor }, "RATE_NOT_ON_TYPE"],
    ["a closed rate", { ticketType: { ...physician, pricingTiers: [rate({ salesEnd: new Date(NOW - DAY) })] } }, "RATE_NOT_ON_SALE"],
  ];
  for (const [label, over, reason] of cases) {
    it(label, async () => {
      mockDb.registration.findMany.mockResolvedValue([reg(over)]);
      const res = await prepareRegistrationForms(BASE);
      expect(res).toMatchObject({ ok: true, ready: [], skipped: [{ registrationId: "reg-1", reason }] });
      expect(tx.registration.updateMany).not.toHaveBeenCalled();
    });
  }

  it("an id not on this event", async () => {
    const res = await prepareRegistrationForms({ ...BASE, registrationIds: ["reg-1", "reg-other"] });
    expect(res).toMatchObject({ ok: true, skipped: [{ registrationId: "reg-other", reason: "NOT_FOUND" }] });
  });

  it("a sponsor rate with no sponsor chosen skips those without one, and uses the one on the registration", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg(), reg({ id: "reg-2", sponsorId: "sp-csv" })]);
    const res = await prepareRegistrationForms({ ...BASE, registrationIds: ["reg-1", "reg-2"], rate: { kind: "rate", slug: "inclusive" } });
    expect(res).toMatchObject({ ok: true, ready: [{ registrationId: "reg-2" }], skipped: [{ registrationId: "reg-1", reason: "NO_SPONSOR" }] });
    expect(stampData()).toMatchObject({ paymentStatus: "INCLUSIVE", sponsorId: "sp-csv" });
  });

  it("a stamp that loses the race (paid or completed meanwhile) is skipped as CHANGED", async () => {
    tx.registration.updateMany.mockResolvedValue({ count: 0 });
    const res = await prepareRegistrationForms(BASE);
    expect(res).toMatchObject({ ok: true, ready: [], skipped: [{ reason: "CHANGED" }] });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("seats", () => {
  it("the stamp moves the seat through the shared transition (a rate-counted public seat moves with the rate)", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ createdSource: "PUBLIC_REGISTER", pricingTierId: "t-inc", paymentStatus: "INCLUSIVE" })]);
    await prepareRegistrationForms(BASE);
    expect(transitionMock.mock.calls[0][1]).toMatchObject({
      eventId: "ev-1",
      prev: { createdSource: "PUBLIC_REGISTER", ticketTypeId: "tt-phys", pricingTierId: "t-inc" },
      next: { createdSource: "PUBLIC_REGISTER", ticketTypeId: "tt-phys", pricingTierId: "t-eb" },
    });
  });

  it("no seats left at the rate: skipped as RATE_SOLD_OUT", async () => {
    transitionMock.mockRejectedValue(new Error("CAPACITY_EXCEEDED"));
    const res = await prepareRegistrationForms(BASE);
    expect(res).toMatchObject({ ok: true, ready: [], skipped: [{ reason: "RATE_SOLD_OUT" }] });
  });

  it("a typeless registration moves no seat", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ ticketTypeId: null, ticketType: null })]);
    await prepareRegistrationForms(BASE);
    expect(transitionMock).not.toHaveBeenCalled();
  });
});

describe("refusals for the whole send", () => {
  it("a rate no type has, a presenter rate, an unknown sponsor, an unknown event", async () => {
    expect(await prepareRegistrationForms({ ...BASE, rate: { kind: "rate", slug: "onsite" } })).toMatchObject({ ok: false, code: "RATE_NOT_FOUND" });
    expect(await prepareRegistrationForms({ ...BASE, rate: { kind: "rate", slug: "presenter-early-bird" } })).toMatchObject({ ok: false, code: "RATE_NOT_ALLOWED" });
    mockDb.sponsor.findFirst.mockResolvedValue(null);
    expect(await prepareRegistrationForms({ ...BASE, sponsorId: "sp-x" })).toMatchObject({ ok: false, code: "SPONSOR_NOT_FOUND" });
    mockDb.event.findFirst.mockResolvedValue(null);
    expect(await prepareRegistrationForms(BASE)).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
    expect(tx.registration.updateMany).not.toHaveBeenCalled();
  });
});

describe("the link", () => {
  it("carries the rate, lasts the chosen days, and revokes the person's earlier links", async () => {
    const { url, expires } = await mintRegistrationFormLink({
      registrationId: "reg-1", eventSlug: "BHS2026", rate: { kind: "rate", slug: "early-bird" }, expiryDays: 30, appUrl: "https://x.test",
    });
    expect(url).toMatch(/^https:\/\/x\.test\/e\/BHS2026\/complete-registration\?token=[0-9a-f]{64}$/);
    expect(Math.round((expires.getTime() - Date.now()) / DAY)).toBe(30);
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ identifier: "reg:reg-1" }, { identifier: { startsWith: "regform:reg-1:" } }] },
    });
    expect(mockDb.verificationToken.create.mock.calls[0][0].data.identifier).toBe("regform:reg-1:early-bird");
  });
});

describe("the onsite link (docs/ONSITE_DESK_PLAN.md §5.4)", () => {
  const INPUT = { registrationId: "reg-1", eventSlug: "BHS2026", minutes: 30, appUrl: "https://x.test", replace: false };

  it("is details-only, lasts 30 minutes, and revokes the person's emailed links, in the tenant transaction", async () => {
    tx.verificationToken.findFirst.mockResolvedValue(null);
    const result = await mintOnsiteCompletionLink(INPUT);
    if (!result.ok) throw new Error("expected a link");
    expect(result.url).toMatch(/^https:\/\/x\.test\/e\/BHS2026\/complete-registration\?token=[0-9a-f]{64}$/);
    expect(Math.round((result.expires.getTime() - Date.now()) / 60_000)).toBe(30);
    expect(tx.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ identifier: "reg:reg-1" }, { identifier: { startsWith: "regform:reg-1:" } }] },
    });
    // The rate-less form: the completion route keeps their type and price, and
    // money already recorded does not stop them.
    expect(tx.verificationToken.create.mock.calls[0][0].data.identifier).toBe("reg:reg-1");
    // Serialised per person, so two desks cannot both see "no live link".
    expect(String(tx.$queryRaw.mock.calls[0][0].join("?"))).toContain("pg_advisory_xact_lock");
    expect(tx.$queryRaw.mock.calls[0][1]).toBe("onsite-link:reg-1");
  });

  it("never replaces a live onsite link unless asked: someone may be typing into it", async () => {
    const live = new Date(Date.now() + 10 * 60_000);
    tx.verificationToken.findFirst.mockResolvedValue({ expires: live });
    expect(await mintOnsiteCompletionLink(INPUT)).toEqual({ ok: false, code: "LINK_ACTIVE", expires: live });
    expect(tx.verificationToken.deleteMany).not.toHaveBeenCalled();
    expect(tx.verificationToken.create).not.toHaveBeenCalled();

    const replaced = await mintOnsiteCompletionLink({ ...INPUT, replace: true });
    expect(replaced.ok).toBe(true);
    expect(tx.verificationToken.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("sendRegistrationForms", () => {
  it("sends each ready person their own link with the lifetime in the email", async () => {
    const res = await sendRegistrationForms({ ...BASE, expiryDays: 10, appUrl: "https://x.test" });
    expect(res).toMatchObject({ ok: true, sent: 1, errors: [] });
    expect(getEventTemplateMock).toHaveBeenCalledWith("ev-1", "registration-form");
    const email = sendEmailMock.mock.calls[0][0];
    expect(email.to).toEqual([{ email: "a@x.test", name: "Ann Lee" }]);
    expect(email.htmlContent).toMatch(/complete-registration\?token=/);
    expect(email.htmlContent).toContain("10 days");
  });

  it("a failed email removes the link but keeps the stamp", async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: "bounced" });
    const res = await sendRegistrationForms({ ...BASE, expiryDays: 7, appUrl: "https://x.test" });
    expect(res).toMatchObject({ ok: true, sent: 0, errors: [expect.stringContaining("bounced")] });
    expect(tx.registration.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("skips are reported and nobody skipped is emailed", async () => {
    mockDb.registration.findMany.mockResolvedValue([reg({ userId: "u-9" })]);
    const res = await sendRegistrationForms({ ...BASE, expiryDays: 7, appUrl: "https://x.test" });
    expect(res).toMatchObject({ ok: true, sent: 0, skipped: [{ reason: "HAS_ACCOUNT" }] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
