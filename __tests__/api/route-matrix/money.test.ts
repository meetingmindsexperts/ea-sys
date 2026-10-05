/**
 * Route status matrix, domain 13 of the Phase 2 sweep: money (a
 * registration's refund, cancel, credit note, promo code and quote; an
 * event's invoices, an invoice, its PDF and send, the invoice export; the
 * event's payer list; the organisation's invoice ledger and its export, and
 * the payer book with merge). Recorded on the unswept code (Oct 5, 2026); the
 * sweep onto `requirePermission` must leave it byte for byte unchanged except
 * where a change is intended and reviewed. See ./harness.ts for what a cell
 * means.
 *
 * Changes re-recorded on purpose (Oct 5, 2026):
 *  - ONSITE is refused the organisation's invoice book and its export
 *    (`invoices.ledger`); it read every invoice across every event before
 *    (owner). Its assigned events' invoices, quotes and invoice CSV stay.
 *  - the platform operator (SUPER_ADMIN with no organisation) gets a clean
 *    403 on a registration's promo code, attaching a payer to an event and the
 *    payer book, where it reached lookups bound to an empty organisation id
 *    (404, an empty list, or a 500 from a write with no organisation).
 *  - a payer's DETAIL needs `invoices.ledger` (code review, Oct 5, 2026): it
 *    returns the payer's registrations, invoices and payments on every event,
 *    which ONSITE and WEBINARS read through the payer-list key before.
 *
 * Every network call fails here (`fetch` is stubbed to throw, so Stripe is
 * unreachable) and the email sender is mocked, so nothing can refund money or
 * reach a mailbox.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async () => ({
  validateApiKey: (await import("./harness")).mockValidateApiKey,
  apiKeyUseContext: () => ({}),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async () => ({ success: true, messageId: "matrix" })),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { POST as cancelPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/cancel/route";
import { POST as creditPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/credit-notes/route";
import { POST as refundPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/refund/route";
import { POST as promoPOST, DELETE as promoDELETE } from "@/app/api/events/[eventId]/registrations/[registrationId]/promo/route";
import { GET as quoteGET } from "@/app/api/events/[eventId]/registrations/[registrationId]/quote/route";
import { POST as evPayersPOST } from "@/app/api/events/[eventId]/billing-accounts/route";
import { POST as evPayerPOST, DELETE as evPayerDELETE } from "@/app/api/events/[eventId]/billing-accounts/[billingAccountId]/route";
import { GET as invoicesGET, POST as invoicesPOST } from "@/app/api/events/[eventId]/invoices/route";
import { GET as invoiceGET, PUT as invoicePUT } from "@/app/api/events/[eventId]/invoices/[invoiceId]/route";
import { GET as invoicePdfGET } from "@/app/api/events/[eventId]/invoices/[invoiceId]/pdf/route";
import { POST as invoiceSendPOST } from "@/app/api/events/[eventId]/invoices/[invoiceId]/send/route";
import { GET as invoiceExportGET } from "@/app/api/events/[eventId]/invoices/export/route";
import { GET as ledgerGET } from "@/app/api/invoices/route";
import { GET as ledgerExportGET } from "@/app/api/invoices/export/route";
import { GET as payersGET, POST as payersPOST } from "@/app/api/billing-accounts/route";
import { GET as payerGET, PATCH as payerPATCH } from "@/app/api/billing-accounts/[billingAccountId]/route";
import { POST as payerMergePOST } from "@/app/api/billing-accounts/[billingAccountId]/merge/route";

const reg = { registrationId: "r1" };
const inv = { invoiceId: "iv1" };
const payer = { billingAccountId: "ba1" };
const org = { perEvent: false } as const;
// The event payer routes are typed as possibly resolving to undefined (their
// tenant wrapper's signature); at runtime every path returns a response.

const CASES: HandlerCase[] = [
  { name: "POST registrations/[registrationId]/refund", handler: refundPOST, method: "POST", params: reg, body: {} },
  { name: "POST registrations/[registrationId]/cancel", handler: cancelPOST, method: "POST", params: reg, body: { refund: false } },
  { name: "POST registrations/[registrationId]/credit-notes", handler: creditPOST, method: "POST", params: reg, body: {} },
  { name: "POST registrations/[registrationId]/promo", handler: promoPOST, method: "POST", params: reg, body: { code: "SAVE10" } },
  { name: "DELETE registrations/[registrationId]/promo", handler: promoDELETE, method: "DELETE", params: reg },
  { name: "GET registrations/[registrationId]/quote", handler: quoteGET, method: "GET", params: reg },
  { name: "POST billing-accounts (attach to event)", handler: evPayersPOST, method: "POST", body: { name: "Clinic" } },
  { name: "POST billing-accounts/[billingAccountId] (event)", handler: evPayerPOST as HandlerCase["handler"], method: "POST", params: payer, body: {} },
  { name: "DELETE billing-accounts/[billingAccountId] (event)", handler: evPayerDELETE as HandlerCase["handler"], method: "DELETE", params: payer },
  { name: "GET invoices", handler: invoicesGET, method: "GET" },
  { name: "POST invoices", handler: invoicesPOST, method: "POST", body: { registrationId: "r1" } },
  { name: "GET invoices/[invoiceId]", handler: invoiceGET, method: "GET", params: inv },
  { name: "PUT invoices/[invoiceId]", handler: invoicePUT, method: "PUT", params: inv, body: { action: "mark_overdue" } },
  { name: "GET invoices/[invoiceId]/pdf", handler: invoicePdfGET, method: "GET", params: inv },
  { name: "POST invoices/[invoiceId]/send", handler: invoiceSendPOST, method: "POST", params: inv, body: {} },
  { name: "GET invoices/export", handler: invoiceExportGET, method: "GET", query: "format=csv" },
  { name: "GET /api/invoices (org ledger)", handler: ledgerGET, method: "GET", ...org },
  { name: "GET /api/invoices/export (org ledger)", handler: ledgerExportGET, method: "GET", ...org },
  { name: "GET /api/billing-accounts", handler: payersGET, method: "GET", ...org },
  { name: "POST /api/billing-accounts", handler: payersPOST, method: "POST", body: { name: "Clinic" }, ...org },
  { name: "GET /api/billing-accounts/[billingAccountId]", handler: payerGET, method: "GET", params: payer, ...org },
  { name: "PATCH /api/billing-accounts/[billingAccountId]", handler: payerPATCH, method: "PATCH", params: payer, body: { name: "Clinic 2" }, ...org },
  {
    name: "POST /api/billing-accounts/[billingAccountId]/merge",
    handler: payerMergePOST,
    method: "POST",
    params: payer,
    body: { duplicateId: "ba2" },
    ...org,
  },
];

describe("route status matrix: money", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("route-matrix: network is off");
    }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("money", CASES)).toMatchFileSnapshot("./__snapshots__/money.matrix.txt");
  });
});
