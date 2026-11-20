/**
 * "Make Faculty" (owner, Nov 20, 2026; plan step 6, decision P5): only for a
 * speaker's registration, money never disappears, and the move itself is the
 * single registration's own update.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { regFindFirst, speakerFindFirst, speakerUpdateMany, auditCreate, updateSpy, cancelInvoiceSpy, facultyTypeSpy, logger } = vi.hoisted(() => ({
  regFindFirst: vi.fn(),
  speakerFindFirst: vi.fn(),
  speakerUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  updateSpy: vi.fn(),
  cancelInvoiceSpy: vi.fn(),
  facultyTypeSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    registration: { findFirst: regFindFirst },
    speaker: { findFirst: speakerFindFirst, updateMany: speakerUpdateMany },
    auditLog: { create: auditCreate },
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/services/registration-service", () => ({ updateRegistration: updateSpy }));
vi.mock("@/lib/invoice-service", () => ({ cancelInvoice: cancelInvoiceSpy }));
vi.mock("@/lib/speaker-companion", () => ({ ensureFacultyTicketType: facultyTypeSpy }));

import { makeRegistrationFaculty } from "@/services/make-faculty-service";

const UPDATED_AT = new Date("2026-11-20T08:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  status: "CONFIRMED",
  paymentStatus: "UNASSIGNED",
  badgeType: null,
  groupId: null,
  refundedAmount: 0,
  originalPrice: 400,
  discountAmount: 0,
  stripeCheckoutSessionId: null,
  updatedAt: UPDATED_AT,
  createdSource: "PUBLIC_SUBMITTER",
  attendee: { email: "Author@X.com" },
  ticketType: { name: "Physician", isFaculty: false, price: 0, currency: "AED" },
  pricingTier: { name: "Presenter Early Bird", price: 400, currency: "AED" },
  payments: [],
  invoices: [],
  event: { taxRate: null, taxLabel: null },
  ...over,
});
const speaker = (over: Record<string, unknown> = {}) => ({ id: "sp1", firstName: "Hadi", lastName: "Skouri", sourceRegistrationId: "r1", ...over });
const input = (over: Record<string, unknown> = {}) => ({
  eventId: "ev1", organizationId: "org1", actorUserId: "u1", registrationId: "r1", source: "rest" as const, maySeeAmounts: true, mayCancelInvoices: true, ...over,
});
/** A payment row as the database holds it: the status is the enum, and a refund is counted on the payment. */
const payment = (amount: number, refundedAmount = 0) => ({ amount, refundedAmount, status: refundedAmount >= amount ? "REFUNDED" : "PAID" });

beforeEach(() => {
  vi.clearAllMocks();
  regFindFirst.mockResolvedValue(row());
  speakerFindFirst.mockResolvedValue(speaker());
  speakerUpdateMany.mockResolvedValue({ count: 1 });
  auditCreate.mockResolvedValue({});
  updateSpy.mockResolvedValue({ ok: true });
  cancelInvoiceSpy.mockResolvedValue({});
  facultyTypeSpy.mockResolvedValue("tt-faculty");
});

describe("only for a speaker", () => {
  it("refuses a registration that belongs to no speaker record, and changes nothing", async () => {
    speakerFindFirst.mockResolvedValue(null);
    const result = await makeRegistrationFaculty(input());
    expect(result).toMatchObject({ ok: false, code: "NO_SPEAKER" });
    expect(updateSpy).not.toHaveBeenCalled();
    // Asked both ways: the record that points at it, then the same address, exact whatever its case.
    expect(speakerFindFirst.mock.calls[0][0].where).toEqual({ eventId: "ev1", sourceRegistrationId: "r1" });
    expect(speakerFindFirst.mock.calls[1][0].where).toEqual({ eventId: "ev1", email: { equals: "Author@X.com", mode: "insensitive" } });
  });

  it("a registration on another event is not found", async () => {
    regFindFirst.mockResolvedValue(null);
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "REGISTRATION_NOT_FOUND" });
    expect(regFindFirst.mock.calls[0][0].where).toEqual({ id: "r1", eventId: "ev1" });
  });

  it("refuses a cancelled registration, and a speaker who already has another live registration", async () => {
    regFindFirst.mockResolvedValueOnce(row({ status: "CANCELLED" }));
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "CANCELLED" });

    // Found by address; their record points at a different, live registration.
    speakerFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(speaker({ sourceRegistrationId: "r-other" }));
    regFindFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce({ serialId: 12 });
    const result = await makeRegistrationFaculty(input());
    expect(result).toMatchObject({ ok: false, code: "SPEAKER_HAS_OTHER_REGISTRATION" });
    expect(result.ok === false && result.message).toContain("#012");
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("money never disappears (P5)", () => {
  it.each([
    ["paid by card or at the desk", { paymentStatus: "PAID", payments: [payment(400)] }],
    ["a payment recorded on a row still marked unpaid (a partial capture)", { payments: [payment(100)] }],
    ["partly refunded", { paymentStatus: "PAID", payments: [payment(400, 150)], refundedAmount: 150 }],
    ["a paid invoice", { invoices: [{ id: "i1", invoiceNumber: "INV-1", status: "PAID" }] }],
    ["marked Paid by hand, with no payment recorded", { paymentStatus: "PAID" }],
  ])("%s: refused until it is refunded or corrected", async (_name, over) => {
    regFindFirst.mockResolvedValue(row(over));
    const result = await makeRegistrationFaculty(input({ confirmWaive: 400 }));
    expect(result).toMatchObject({ ok: false, code: "HAS_PAYMENT" });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(cancelInvoiceSpy).not.toHaveBeenCalled();
  });

  // Review of 66969977 (MED): the first version subtracted the registration's refund total from the payments
  // still marked PAID, so a refund of one payment hid another that was still held.
  it.each([
    ["Complimentary by hand", "COMPLIMENTARY"],
    ["Unpaid", "UNPAID"],
  ])("one payment fully refunded and another still held, status %s: refused", async (_name, paymentStatus) => {
    regFindFirst.mockResolvedValue(row({ paymentStatus, payments: [payment(300, 300), payment(200)], refundedAmount: 300 }));
    expect(await makeRegistrationFaculty(input({ confirmWaive: 500 }))).toMatchObject({ ok: false, code: "HAS_PAYMENT" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("a payment that lands between the read and the row lock is refused by the update itself", async () => {
    regFindFirst.mockResolvedValue(row({ paymentStatus: "COMPLIMENTARY" }));
    updateSpy.mockResolvedValue({ ok: false, code: "FACULTY_HAS_PAYMENT", message: "A payment was recorded on this registration." });
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "HAS_PAYMENT" });
    expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["paid by a sponsor", { paymentStatus: "INCLUSIVE" }, "SPONSOR_PAID"],
    ["part of a group", { groupId: "g1" }, "GROUP_MEMBER"],
    ["a payment in progress", { paymentStatus: "PENDING" }, "PAYMENT_PENDING"],
    ["owing with a card checkout open", { stripeCheckoutSessionId: "cs_1" }, "CHECKOUT_OPEN"],
    // It can still turn the row Paid, whatever the row says now.
    ["Complimentary with a card checkout still open", { paymentStatus: "COMPLIMENTARY", stripeCheckoutSessionId: "cs_1" }, "CHECKOUT_OPEN"],
  ])("%s: refused", async (_name, over, code) => {
    regFindFirst.mockResolvedValue(row(over));
    expect(await makeRegistrationFaculty(input({ confirmWaive: 400 }))).toMatchObject({ ok: false, code });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // Review of 66969977 (MED): a custom role can hold the two keys the route asks without seeing amounts or
  // editing invoices. It is told neither figure and waives nothing.
  it("without the key to see amounts, a registration that owes is refused, and the answer names no figure", async () => {
    const result = await makeRegistrationFaculty(input({ maySeeAmounts: false, preview: true }));
    expect(result).toMatchObject({ ok: false, code: "NEEDS_FINANCE" });
    expect(JSON.stringify(result)).not.toMatch(/400|AED|plan/);
    // Nothing owed and no invoice: it needs neither key.
    regFindFirst.mockResolvedValue(row({ paymentStatus: "COMPLIMENTARY" }));
    expect(await makeRegistrationFaculty(input({ maySeeAmounts: false, mayCancelInvoices: false }))).toMatchObject({ ok: true, moved: true });
  });

  it("without the key to edit invoices, a registration with an open invoice is refused, and the invoice is left alone", async () => {
    regFindFirst.mockResolvedValue(row({ paymentStatus: "COMPLIMENTARY", invoices: [{ id: "i1", invoiceNumber: "INV-7", status: "SENT" }] }));
    const result = await makeRegistrationFaculty(input({ mayCancelInvoices: false }));
    expect(result).toMatchObject({ ok: false, code: "NEEDS_FINANCE" });
    expect(JSON.stringify(result)).not.toContain("INV-7");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(cancelInvoiceSpy).not.toHaveBeenCalled();
  });

  it("owing: refused until the caller sends back the amount it was shown, and the refusal carries the plan", async () => {
    const result = await makeRegistrationFaculty(input());
    expect(result).toMatchObject({ ok: false, code: "CONFIRM_WAIVE", plan: { owing: { amount: 400, currency: "AED" }, fromType: "Physician", fromRate: "Presenter Early Bird" } });
    expect(updateSpy).not.toHaveBeenCalled();
    // An amount that is not the one owed now (it changed since the dialog read it) is no confirmation.
    expect(await makeRegistrationFaculty(input({ confirmWaive: 150 }))).toMatchObject({ ok: false, code: "CONFIRM_WAIVE" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("owing and confirmed: made Complimentary on Faculty, the open invoice cancelled (never a credit note or a receipt), and the waiver written down", async () => {
    regFindFirst.mockResolvedValue(row({ invoices: [{ id: "i1", invoiceNumber: "INV-7", status: "SENT" }] }));
    const result = await makeRegistrationFaculty(input({ confirmWaive: 400, requestIp: "1.2.3.4" }));
    expect(result).toMatchObject({ ok: true, moved: true, invoicesNotCancelled: [] });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      eventId: "ev1", registrationId: "r1", actorUserId: "u1", ticketTypeId: "tt-faculty", toFaculty: true,
      paymentStatus: "COMPLIMENTARY", badgeType: "Faculty", expectedUpdatedAt: UPDATED_AT.toISOString(),
    });
    expect(cancelInvoiceSpy).toHaveBeenCalledWith("i1", expect.objectContaining({ actorUserId: "u1", organizationId: "org1" }));
    // Only invoices are read, and never a cancelled one.
    expect(regFindFirst.mock.calls[0][0].select.invoices.where).toEqual({ type: "INVOICE", status: { not: "CANCELLED" } });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: "MAKE_FACULTY", entityType: "Registration", entityId: "r1", userId: "u1",
      changes: { waived: { amount: 400, currency: "AED" }, fromType: "Physician", invoicesCancelled: ["INV-7"], speakerId: "sp1" },
    });
  });

  it("the fee owed counts a discount and the event's tax, as the registration's own page does", async () => {
    regFindFirst.mockResolvedValue(row({ discountAmount: 100, event: { taxRate: 5, taxLabel: "VAT" } }));
    const result = await makeRegistrationFaculty(input({ preview: true }));
    expect(result).toMatchObject({ ok: true, moved: false, plan: { owing: { amount: 315, currency: "AED" } } });
  });

  it.each([
    ["Complimentary", { paymentStatus: "COMPLIMENTARY" }],
    ["a free rate", { originalPrice: 0, pricingTier: { name: "Presenter Early Bird", price: 0, currency: "AED" } }],
    ["fully refunded", { paymentStatus: "REFUNDED", payments: [payment(400, 400)], refundedAmount: 400 }],
  ])("%s: nothing is owed, so it moves with no confirmation", async (_name, over) => {
    regFindFirst.mockResolvedValue(row(over));
    const result = await makeRegistrationFaculty(input());
    expect(result).toMatchObject({ ok: true, moved: true, plan: { owing: null } });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("a fully refunded registration keeps saying Refunded: its payment status is not written", async () => {
    regFindFirst.mockResolvedValue(row({ paymentStatus: "REFUNDED", payments: [payment(400, 400)], refundedAmount: 400 }));
    await makeRegistrationFaculty(input());
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty("paymentStatus");
  });

  it("an invoice that cannot be cancelled is named; the move stands", async () => {
    regFindFirst.mockResolvedValue(row({ invoices: [{ id: "i1", invoiceNumber: "INV-7", status: "OVERDUE" }] }));
    cancelInvoiceSpy.mockRejectedValue(new Error("db down"));
    const result = await makeRegistrationFaculty(input({ confirmWaive: 400 }));
    expect(result).toMatchObject({ ok: true, moved: true, invoicesNotCancelled: ["INV-7"] });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "make-faculty:invoice-cancel-failed", invoiceId: "i1" }));
    expect(auditCreate.mock.calls[0][0].data.changes).toMatchObject({ invoicesCancelled: [], invoicesNotCancelled: ["INV-7"] });
  });
});

describe("the move", () => {
  it("a preview answers what would happen and changes nothing", async () => {
    const result = await makeRegistrationFaculty(input({ preview: true }));
    expect(result).toMatchObject({ ok: true, moved: false, plan: { speaker: { id: "sp1", name: "Hadi Skouri" }, badge: { from: null, to: "Faculty" } } });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(facultyTypeSpy).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(speakerUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    [null, "Faculty"],
    ["Presenter", "Faculty"],
    ["Scientific Committee", "Scientific Committee"],
    ["Exhibitor", "Exhibitor"],
  ])("badge %s becomes %s: a badge the team chose is kept", async (from, to) => {
    regFindFirst.mockResolvedValue(row({ paymentStatus: "COMPLIMENTARY", badgeType: from }));
    const result = await makeRegistrationFaculty(input());
    expect(result).toMatchObject({ ok: true, plan: { badge: { from, to } } });
    if (from === to) expect(updateSpy.mock.calls[0][0]).not.toHaveProperty("badgeType");
    else expect(updateSpy.mock.calls[0][0].badgeType).toBe(to);
  });

  it("a speaker found by address is pointed at the registration, guarded on the pointer that was read", async () => {
    regFindFirst.mockResolvedValue(row({ paymentStatus: "COMPLIMENTARY" }));
    speakerFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(speaker({ sourceRegistrationId: null }));
    await makeRegistrationFaculty(input());
    expect(speakerUpdateMany).toHaveBeenCalledWith({ where: { id: "sp1", eventId: "ev1", sourceRegistrationId: null }, data: { sourceRegistrationId: "r1" } });
  });

  it("someone who edited the registration since it was read wins: nothing after the refused update runs", async () => {
    regFindFirst.mockResolvedValue(row({ paymentStatus: "COMPLIMENTARY", invoices: [{ id: "i1", invoiceNumber: "INV-7", status: "SENT" }] }));
    updateSpy.mockResolvedValue({ ok: false, code: "STALE_WRITE", message: "Modified by someone else." });
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "STALE_WRITE" });
    expect(cancelInvoiceSpy).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(speakerUpdateMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    regFindFirst.mockRejectedValue(new Error("db down"));
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "make-faculty:failed" }));
  });
});

describe("already on the Faculty type", () => {
  const onFaculty = (over: Record<string, unknown> = {}) =>
    row({ paymentStatus: "COMPLIMENTARY", originalPrice: 0, badgeType: "Faculty", createdSource: "FACULTY_ADMIN", ticketType: { name: "Faculty", isFaculty: true, price: 0, currency: "AED" }, pricingTier: null, ...over });

  it("there is nothing to do, and nothing is changed", async () => {
    regFindFirst.mockResolvedValue(onFaculty());
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "ALREADY_FACULTY" });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(speakerUpdateMany).not.toHaveBeenCalled();
  });

  // Review of 66969977 (LOW): a run that moved the registration and then failed to point the speaker at it
  // could not be repaired, because the next attempt answered "already".
  it("a speaker found by address who was never pointed at it is pointed now", async () => {
    regFindFirst.mockResolvedValue(onFaculty());
    speakerFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(speaker({ sourceRegistrationId: null }));
    expect(await makeRegistrationFaculty(input())).toMatchObject({ ok: false, code: "ALREADY_FACULTY" });
    expect(speakerUpdateMany).toHaveBeenCalledWith({ where: { id: "sp1", eventId: "ev1", sourceRegistrationId: null }, data: { sourceRegistrationId: "r1" } });
  });
});

// The update path's `toFaculty` lifts "Faculty is never a destination". Only this service has checked the
// speaker and the money, so only it may say so: a route, a tool or an import that passed the flag on would be
// a way onto Faculty for any delegate, with any payment on it.
describe("the one caller", () => {
  it("no file but the two services names toFaculty", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && /\btoFaculty\b/.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    // Everywhere code runs from: the app, the worker tier and the one-off scripts.
    for (const root of ["src", "worker", "scripts"]) walk(join(process.cwd(), root));
    expect(hits.map((h) => h.replace(`${process.cwd()}/`, "")).sort()).toEqual(["src/services/make-faculty-service.ts", "src/services/registration-service.ts"]);
  });
});
