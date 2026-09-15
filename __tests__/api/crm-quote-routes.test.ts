/**
 * CRM quote routes: who may reach them, and how a partial create body is filled.
 *
 * Pins: a quote prints deal money, so a caller the deal-value redaction applies
 * to (MEMBER) is refused the draft and sees an empty quote list; only an admin
 * may save the org's default terms; a create body missing fields is completed
 * from the draft (a pre-editor client sending only tax and validity still
 * works), but a line priced in another currency is refused, never guessed; an
 * edit must carry the version it loaded; a delete unlinks the removed PDF.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/storage", () => ({ deleteStoredFile: vi.fn() }));

const { requireCrmRead, requireCrmWrite, requireCrmDelete } = vi.hoisted(() => ({
  requireCrmRead: vi.fn(),
  requireCrmWrite: vi.fn(),
  requireCrmDelete: vi.fn(),
}));
vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead,
  requireCrmWrite,
  requireCrmDelete,
  crmErrorResponse: (fail: { code: string; message: string }) => ({
    status: fail.code === "STALE_WRITE" ? 409 : fail.code.endsWith("NOT_FOUND") ? 404 : 400,
    json: async () => ({ error: fail.message, code: fail.code }),
  }),
}));

const service = vi.hoisted(() => ({
  getDealQuoteDraft: vi.fn(),
  createDealQuote: vi.fn(),
  listDealQuotes: vi.fn(),
  updateDealQuote: vi.fn(),
  archiveDealQuote: vi.fn(),
}));
vi.mock("@/crm/services/crm-quote-service", () => service);

import { deleteStoredFile } from "@/lib/storage";
import { GET as getDraft, POST as createQuote } from "@/app/api/crm/deals/[dealId]/quote/route";
import { GET as listQuotes } from "@/app/api/crm/deals/[dealId]/quotes/route";
import { PATCH as editQuote, DELETE as deleteQuote } from "@/app/api/crm/deals/[dealId]/quotes/[quoteId]/route";
import type { CrmQuoteDraft } from "@/crm/lib/quote-rules";

function ctx(role: string) {
  return { ctx: { organizationId: "org-1", userId: "u-1", role, fromApiKey: false } };
}

function request(body?: unknown) {
  return new Request("http://localhost/api", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const dealParams = { params: Promise.resolve({ dealId: "d-1" }) };
const quoteParams = { params: Promise.resolve({ dealId: "d-1", quoteId: "q-1" }) };

const pricedDraft: CrmQuoteDraft = {
  title: "Abbott Quote - MEHFC 2026",
  currency: "USD",
  quoteDate: "2026-09-15",
  validUntil: "2026-10-15",
  preparedFor: "Abbott",
  attention: "Sara Khan",
  preparedByName: "Atiqur Rahman",
  taxRate: 5,
  taxLabel: "VAT",
  terms: "Terms",
  notes: null,
  eventName: "MEHFC 2026",
  lines: [
    { productCode: "SPO10001", name: "Sponsorship - Diamond", description: null, quantity: 1, unitPrice: 95000, productCurrency: "USD", cataloguePrice: 95000, crmProductId: "p-1" },
  ],
};

const fullBody = {
  title: "Abbott Quote",
  currency: "USD",
  quoteDate: "2026-09-15",
  validUntil: "2026-10-15",
  preparedFor: "Abbott",
  lines: [{ name: "Sponsorship - Diamond", quantity: 1, unitPrice: 95000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  service.getDealQuoteDraft.mockResolvedValue({ ok: true, draft: pricedDraft });
  service.createDealQuote.mockResolvedValue({ ok: true, quote: { number: "Q-2026-0003" } });
  service.listDealQuotes.mockResolvedValue({ ok: true, quotes: [{ id: "q-1" }] });
  service.updateDealQuote.mockResolvedValue({ ok: true, quote: { id: "q-1", version: 2 } });
  service.archiveDealQuote.mockResolvedValue({ ok: true, removedUrl: "/uploads/crm-deal-docs/d-1/q.pdf" });
});

describe("GET draft", () => {
  it("refuses a caller who may not see deal money", async () => {
    requireCrmRead.mockResolvedValue(ctx("MEMBER"));
    const res = await getDraft(request(), dealParams);

    expect(res.status).toBe(403);
    expect(service.getDealQuoteDraft).not.toHaveBeenCalled();
  });

  it("returns the draft, and lets only an admin save the default terms", async () => {
    requireCrmRead.mockResolvedValue(ctx("ORGANIZER"));
    const organizer = await getDraft(request(), dealParams);
    expect(organizer.status).toBe(200);
    expect(await organizer.json()).toMatchObject({ draft: pricedDraft, canSaveDefaultTerms: false });

    requireCrmRead.mockResolvedValue(ctx("ADMIN"));
    const admin = await getDraft(request(), dealParams);
    expect(await admin.json()).toMatchObject({ canSaveDefaultTerms: true });
  });
});

describe("POST create", () => {
  it("completes a pre-editor body from the draft, turning validity days into a date", async () => {
    requireCrmWrite.mockResolvedValue(ctx("CRM_USER"));
    const res = await createQuote(request({ taxRate: 5, validityDays: 10, notes: "Net 30" }), dealParams);

    expect(res.status).toBe(201);
    const call = service.createDealQuote.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(call.input).toMatchObject({
      title: "Abbott Quote - MEHFC 2026",
      quoteDate: "2026-09-15",
      validUntil: "2026-09-25",
      notes: "Net 30",
      lines: [expect.objectContaining({ name: "Sponsorship - Diamond", unitPrice: 95000 })],
    });
  });

  it("refuses a draft line priced in another currency instead of inventing a price", async () => {
    requireCrmWrite.mockResolvedValue(ctx("CRM_USER"));
    service.getDealQuoteDraft.mockResolvedValue({
      ok: true,
      draft: {
        ...pricedDraft,
        lines: [...pricedDraft.lines, { productCode: "EXH-1", name: "Booth", description: null, quantity: 1, unitPrice: null, productCurrency: "AED", crmProductId: "p-2" }],
      },
    });

    const res = await createQuote(request({}), dealParams);

    expect(res.status).toBe(400);
    expect(service.createDealQuote).not.toHaveBeenCalled();
  });

  it("lets only an admin save the default terms", async () => {
    requireCrmWrite.mockResolvedValue(ctx("ORGANIZER"));
    const res = await createQuote(request({ ...fullBody, saveTermsAsDefault: true }), dealParams);

    expect(res.status).toBe(403);
    expect(service.createDealQuote).not.toHaveBeenCalled();
  });

  it("refuses a currency the editor does not offer", async () => {
    requireCrmWrite.mockResolvedValue(ctx("ADMIN"));
    const res = await createQuote(request({ ...fullBody, currency: "JPY" }), dealParams);
    expect(res.status).toBe(400);
  });
});

describe("GET list", () => {
  it("returns an empty list to a caller who may not see deal money, without querying", async () => {
    requireCrmRead.mockResolvedValue(ctx("MEMBER"));
    const res = await listQuotes(request(), dealParams);

    expect(await res.json()).toEqual({ quotes: [] });
    expect(service.listDealQuotes).not.toHaveBeenCalled();
  });
});

describe("PATCH and DELETE", () => {
  it("refuses an edit that does not carry the version it loaded", async () => {
    requireCrmWrite.mockResolvedValue(ctx("CRM_USER"));
    const res = await editQuote(request(fullBody), quoteParams);

    expect(res.status).toBe(400);
    expect(service.updateDealQuote).not.toHaveBeenCalled();
  });

  it("passes the version and the full quote to the service", async () => {
    requireCrmWrite.mockResolvedValue(ctx("CRM_USER"));
    const res = await editQuote(request({ ...fullBody, expectedVersion: 1 }), quoteParams);

    expect(res.status).toBe(200);
    expect(service.updateDealQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId: "q-1", expectedVersion: 1, input: expect.objectContaining({ title: "Abbott Quote" }) }),
    );
  });

  it("surfaces a conflict as 409", async () => {
    requireCrmWrite.mockResolvedValue(ctx("CRM_USER"));
    service.updateDealQuote.mockResolvedValue({ ok: false, code: "STALE_WRITE", message: "Someone else changed this quote." });
    const res = await editQuote(request({ ...fullBody, expectedVersion: 1 }), quoteParams);
    expect(res.status).toBe(409);
  });

  it("unlinks the removed PDF after deleting a quote", async () => {
    requireCrmDelete.mockResolvedValue(ctx("CRM_USER"));
    const res = await deleteQuote(request(), quoteParams);

    expect(res.status).toBe(200);
    expect(deleteStoredFile).toHaveBeenCalledWith("/uploads/crm-deal-docs/d-1/q.pdf", expect.anything());
  });

  it("gates delete on the CRM delete permission, not write, so an organizer cannot delete a quote", async () => {
    requireCrmWrite.mockResolvedValue(ctx("ORGANIZER"));
    requireCrmDelete.mockResolvedValue({ error: { status: 403, json: async () => ({ code: "FORBIDDEN" }) } });
    const res = await deleteQuote(request(), quoteParams);

    expect(res.status).toBe(403);
    expect(requireCrmDelete).toHaveBeenCalled();
    expect(service.archiveDealQuote).not.toHaveBeenCalled();
    expect(deleteStoredFile).not.toHaveBeenCalled();
  });
});
