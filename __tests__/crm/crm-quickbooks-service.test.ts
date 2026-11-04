/**
 * Sending a CRM quote to QuickBooks as an Estimate (Nov 4, 2026).
 *
 * Pins the never-twice rules: a claimed quote stops a second send; an Estimate
 * already carrying the quote's marker is ADOPTED, never duplicated; one with
 * the number but not the marker stops the send; a definite refusal moves the
 * requestid on, an unknown outcome keeps it; a sent quote records what it
 * became. The QuickBooks module is mocked; the rules module is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    crmQuote: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    crmCompany: { findFirst: vi.fn(), update: vi.fn() },
    crmProduct: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    crmActivity: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/event-settings", () => ({ updateOrganizationSettings: vi.fn() }));

const { qbo } = vi.hoisted(() => ({
  qbo: {
    currentRealm: vi.fn(),
    getCustomer: vi.fn(),
    getItems: vi.fn(),
    findClassByName: vi.fn(),
    findEstimatesByDocNumber: vi.fn(),
    createEstimate: vi.fn(),
    listTaxCodes: vi.fn(),
    getCompanyInfo: vi.fn(),
  },
}));
vi.mock("@/lib/quickbooks/sales", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quickbooks/sales")>()),
  currentRealm: qbo.currentRealm,
  getCustomer: qbo.getCustomer,
  getItems: qbo.getItems,
  findClassByName: qbo.findClassByName,
  findEstimatesByDocNumber: qbo.findEstimatesByDocNumber,
  createEstimate: qbo.createEstimate,
  listTaxCodes: qbo.listTaxCodes,
}));
vi.mock("@/lib/quickbooks/client", () => ({ getCompanyInfo: qbo.getCompanyInfo }));

import { linkCompanyToCustomer, sendQuoteToQuickBooks } from "@/crm/services/crm-quickbooks-service";

const ORG = "org-1";
const REALM = "realm-1";
const actor = { organizationId: ORG, userId: "u-1", source: "rest" as const };
const args = { ...actor, dealId: "d-1", quoteId: "q-1" };

function quote(overrides: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    dealId: "d-1",
    number: "Q-2026-0006",
    currency: "USD",
    quoteDate: new Date("2026-11-04T00:00:00Z"),
    validUntil: new Date("2026-12-04T00:00:00Z"),
    taxRate: "5",
    total: "78750",
    notes: null,
    archivedAt: null,
    qboEstimateId: null,
    qboEstimateNumber: null,
    qboSentAt: null,
    qboSendStartedAt: null,
    qboSendAttempt: 2,
    lines: [
      {
        name: "Sponsorship - Gold",
        description: null,
        quantity: 1,
        unitPrice: "75000",
        amount: "75000",
        crmProductId: "p-1",
        crmProduct: { name: "Sponsorship - Gold", qboItemId: "i-1", qboRealmId: REALM },
      },
    ],
    deal: {
      status: "WON",
      company: { name: "Novartis", qboCustomerId: "c-1", qboCustomerCurrency: "USD", qboRealmId: REALM },
      event: { code: "EHBPU2026" },
      org: {
        settings: {
          crmQuickBooks: { realmId: REALM, vatTaxCodeId: "tc-5", vatTaxCodeName: "SR 5%", vatRate: 5, noVatTaxCodeId: "tc-0", noVatTaxCodeName: "Zero" },
        },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.crmQuote.findFirst.mockResolvedValue(quote());
  dbMock.crmQuote.updateMany.mockResolvedValue({ count: 1 });
  dbMock.crmQuote.update.mockResolvedValue({});
  dbMock.crmActivity.create.mockResolvedValue({});
  dbMock.user.findUnique.mockResolvedValue({ firstName: "Saleh", lastName: "Mahmoud" });
  qbo.currentRealm.mockResolvedValue({ ok: true, data: { realmId: REALM, environment: "sandbox" } });
  qbo.getCustomer.mockResolvedValue({ ok: true, data: { id: "c-1", displayName: "Novartis", currency: "USD", email: null, active: true } });
  qbo.getItems.mockResolvedValue({ ok: true, data: [{ id: "i-1", name: "Sponsorship", type: "Service", active: true }] });
  qbo.getCompanyInfo.mockResolvedValue({ ok: true, data: { homeCurrency: "AED", multiCurrencyEnabled: true } });
  qbo.findClassByName.mockResolvedValue({ ok: true, data: { id: "cls-1", name: "EHBPU2026" } });
  qbo.findEstimatesByDocNumber.mockResolvedValue({ ok: true, data: [] });
  qbo.createEstimate.mockResolvedValue({
    ok: true,
    data: { id: "est-1", docNumber: "Q-2026-0006", privateNote: "EA-SYS quote q-1", totalAmt: 78750, currency: "USD", status: null },
    realmId: REALM,
    environment: "sandbox",
  });
});

describe("sendQuoteToQuickBooks", () => {
  it("creates the Estimate with the attempt's requestid and records it on the quote", async () => {
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toEqual({ ok: true, estimate: { estimateId: "est-1", estimateNumber: "Q-2026-0006", adopted: false, totalWarning: null } });

    const [, body, requestId] = qbo.createEstimate.mock.calls[0]!;
    expect(requestId).toBe("crmq-q-1-2");
    expect(body).toMatchObject({
      CustomerRef: { value: "c-1" },
      DocNumber: "Q-2026-0006",
      CurrencyRef: { value: "USD" },
      ClassRef: { value: "cls-1" },
      PrivateNote: "EA-SYS quote q-1, sent by Saleh Mahmoud",
      Line: [{ SalesItemLineDetail: { ItemRef: { value: "i-1" }, TaxCodeRef: { value: "tc-5" } } }],
    });
    expect(dbMock.crmQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ qboEstimateId: "est-1", qboRealmId: REALM, qboEnvironment: "sandbox", qboSendStartedAt: null, qboLastError: null }),
      }),
    );
    expect(dbMock.crmActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "QUICKBOOKS_ESTIMATE_SENT", entityId: "d-1" }) }),
    );
  });

  it("claims the quote before talking to QuickBooks, and a held claim stops a second send", async () => {
    dbMock.crmQuote.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: false, code: "QUOTE_SEND_IN_PROGRESS" });
    expect(qbo.findEstimatesByDocNumber).not.toHaveBeenCalled();
    expect(qbo.createEstimate).not.toHaveBeenCalled();
  });

  it("adopts the Estimate an earlier attempt made, instead of making a second", async () => {
    qbo.findEstimatesByDocNumber.mockResolvedValue({
      ok: true,
      data: [{ id: "est-0", docNumber: "Q-2026-0006", privateNote: "EA-SYS quote q-1, sent by Saleh", totalAmt: 78750, currency: "USD", status: null }],
    });
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: true, estimate: { estimateId: "est-0", adopted: true } });
    expect(qbo.createEstimate).not.toHaveBeenCalled();
  });

  it("stops when QuickBooks already has that number on an Estimate EA-SYS did not make", async () => {
    qbo.findEstimatesByDocNumber.mockResolvedValue({
      ok: true,
      data: [{ id: "est-x", docNumber: "Q-2026-0006", privateNote: null, totalAmt: 10, currency: "USD", status: null }],
    });
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: false, code: "QBO_DOC_NUMBER_TAKEN" });
    expect(qbo.createEstimate).not.toHaveBeenCalled();
    expect(dbMock.crmQuote.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ qboSendStartedAt: null }) }),
    );
  });

  it("a definite refusal releases the claim and moves the requestid on", async () => {
    qbo.createEstimate.mockResolvedValue({ ok: false, code: "HTTP_ERROR", status: 400, message: "Item inactive", outcomeUnknown: false });
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: false, code: "QBO_REFUSED" });
    expect(dbMock.crmQuote.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ qboSendStartedAt: null, qboSendAttempt: { increment: 1 } }) }),
    );
  });

  it("an unknown outcome releases the claim but keeps the requestid, so a retry is answered with the first result", async () => {
    qbo.createEstimate.mockResolvedValue({ ok: false, code: "NETWORK", message: "timeout", outcomeUnknown: true });
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: false, code: "QBO_OUTCOME_UNKNOWN" });
    const last = dbMock.crmQuote.updateMany.mock.calls.at(-1)![0];
    expect(last.data).not.toHaveProperty("qboSendAttempt");
    expect(dbMock.crmQuote.update).not.toHaveBeenCalled();
  });

  it("refuses a quote already in QuickBooks without calling it", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue(quote({ qboEstimateId: "est-1" }));
    expect(await sendQuoteToQuickBooks(args)).toMatchObject({ ok: false, code: "QUOTE_ALREADY_SENT" });
    expect(qbo.currentRealm).not.toHaveBeenCalled();
  });

  it("lists what is missing and claims nothing when the quote is not ready", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue(quote({ deal: { ...quote().deal, status: "OPEN" } }));
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: false, code: "QUOTE_NOT_READY", meta: { problems: [{ code: "DEAL_NOT_WON" }] } });
    expect(dbMock.crmQuote.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when the event's Class is missing, or multi-currency is off for a foreign currency", async () => {
    qbo.findClassByName.mockResolvedValue({ ok: true, data: null });
    expect(await sendQuoteToQuickBooks(args)).toMatchObject({ ok: false, code: "QUOTE_NOT_READY" });

    qbo.findClassByName.mockResolvedValue({ ok: true, data: { id: "cls-1", name: "EHBPU2026" } });
    qbo.getCompanyInfo.mockResolvedValue({ ok: true, data: { homeCurrency: "AED", multiCurrencyEnabled: false } });
    expect(await sendQuoteToQuickBooks(args)).toMatchObject({ ok: false, code: "QUOTE_NOT_READY" });
    expect(qbo.createEstimate).not.toHaveBeenCalled();
  });

  it("sends no currency when multi-currency is off and the quote is in the home currency", async () => {
    dbMock.crmQuote.findFirst.mockResolvedValue(
      quote({ currency: "AED", deal: { ...quote().deal, company: { ...quote().deal.company, qboCustomerCurrency: "AED" } } }),
    );
    qbo.getCustomer.mockResolvedValue({ ok: true, data: { id: "c-1", displayName: "Novartis", currency: "AED", email: null, active: true } });
    qbo.getCompanyInfo.mockResolvedValue({ ok: true, data: { homeCurrency: "AED", multiCurrencyEnabled: false } });
    await sendQuoteToQuickBooks(args);
    expect(qbo.createEstimate.mock.calls[0]![1]).not.toHaveProperty("CurrencyRef");
  });

  it("keeps the Estimate but warns when QuickBooks' total differs from the quote's", async () => {
    qbo.createEstimate.mockResolvedValue({
      ok: true,
      data: { id: "est-1", docNumber: "Q-2026-0006", privateNote: null, totalAmt: 75000, currency: "USD", status: null },
      realmId: REALM,
      environment: "sandbox",
    });
    const res = await sendQuoteToQuickBooks(args);
    expect(res).toMatchObject({ ok: true, estimate: { totalWarning: expect.stringContaining("75000.00") } });
  });
});

describe("linkCompanyToCustomer", () => {
  it("links to an active customer, recording its currency and this QuickBooks company", async () => {
    dbMock.crmCompany.findFirst.mockResolvedValue({ id: "co-1", name: "Novartis", qboCustomerId: null, qboCustomerName: null });
    dbMock.crmCompany.update.mockResolvedValue({ id: "co-1", qboCustomerId: "c-1", qboCustomerName: "Novartis", qboCustomerCurrency: "USD" });
    const res = await linkCompanyToCustomer({ ...actor, companyId: "co-1", customerId: "c-1" });
    expect(res.ok).toBe(true);
    expect(dbMock.crmCompany.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { qboCustomerId: "c-1", qboCustomerName: "Novartis", qboCustomerCurrency: "USD", qboRealmId: REALM } }),
    );
  });

  it("refuses an inactive or unknown customer", async () => {
    dbMock.crmCompany.findFirst.mockResolvedValue({ id: "co-1", name: "Novartis", qboCustomerId: null, qboCustomerName: null });
    qbo.getCustomer.mockResolvedValue({ ok: true, data: null });
    expect(await linkCompanyToCustomer({ ...actor, companyId: "co-1", customerId: "c-9" })).toMatchObject({ ok: false, code: "QBO_CUSTOMER_NOT_FOUND" });
    expect(dbMock.crmCompany.update).not.toHaveBeenCalled();
  });

  it("unlinks without calling QuickBooks", async () => {
    dbMock.crmCompany.findFirst.mockResolvedValue({ id: "co-1", name: "Novartis", qboCustomerId: "c-1", qboCustomerName: "Novartis" });
    dbMock.crmCompany.update.mockResolvedValue({ id: "co-1", qboCustomerId: null, qboCustomerName: null, qboCustomerCurrency: null });
    await linkCompanyToCustomer({ ...actor, companyId: "co-1", customerId: null });
    expect(qbo.getCustomer).not.toHaveBeenCalled();
    expect(dbMock.crmCompany.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { qboCustomerId: null, qboCustomerName: null, qboCustomerCurrency: null, qboRealmId: null } }),
    );
  });
});
