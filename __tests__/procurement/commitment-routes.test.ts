/**
 * The purchase-order routes through the REAL guard with the service mocked:
 * the flag turns them into 404s, org staff read, every action hands the
 * service the actor's grants so it can judge who may act, the PDF comes
 * back as application/pdf, a bad body is a logged 400, and the quote file
 * route checks the bytes before it stores anything and removes what the
 * row refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
const rateLimit = vi.hoisted(() => vi.fn((): { allowed: boolean; retryAfterSeconds: number } => ({ allowed: true, retryAfterSeconds: 0 })));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => rateLimit(), getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/db", () => ({ db: {}, tenantTransaction: vi.fn() }));

const svc = vi.hoisted(() => ({
  listCommitments: vi.fn(),
  getCommitment: vi.fn(),
  renderOrderPdf: vi.fn(),
  sendOrderToSupplier: vi.fn(),
  receiveOrder: vi.fn(),
  confirmReceipt: vi.fn(),
  cancelOrder: vi.fn(),
  raiseOrder: vi.fn(),
}));
vi.mock("@/procurement/services/commitment-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/procurement/services/commitment-service")>();
  return { ...real, ...svc };
});
const reqSvc = vi.hoisted(() => ({ getSpendRequest: vi.fn(), setQuoteFile: vi.fn() }));
vi.mock("@/procurement/services/spend-request-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/procurement/services/spend-request-service")>();
  return { ...real, ...reqSvc };
});
const storage = vi.hoisted(() => ({ uploadFile: vi.fn(), readStoredFile: vi.fn(), deleteStoredFile: vi.fn() }));
vi.mock("@/lib/storage", () => storage);

import { GET as list } from "@/app/api/procurement/commitments/route";
import { GET as pdf } from "@/app/api/procurement/commitments/[commitmentId]/pdf/route";
import { POST as send } from "@/app/api/procurement/commitments/[commitmentId]/send/route";
import { POST as receive } from "@/app/api/procurement/commitments/[commitmentId]/receive/route";
import { POST as confirm } from "@/app/api/procurement/commitments/[commitmentId]/confirm-receipt/route";
import { POST as cancel } from "@/app/api/procurement/commitments/[commitmentId]/cancel/route";
import { POST as raise } from "@/app/api/procurement/requests/[requestId]/order/route";
import { POST as uploadQuote, GET as readQuote, DELETE as dropQuote } from "@/app/api/procurement/requests/[requestId]/quotes/[quoteId]/file/route";

const ORG = "org-1";
const user = (over: Record<string, unknown>) => ({ user: { id: "u1", organizationId: ORG, role: "MEMBER", ...over } });
const post = (url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const get = (url: string) => new NextRequest(`http://localhost${url}`);
const cParams = (commitmentId = "c1") => ({ params: Promise.resolve({ commitmentId }) });
const okOrder = { ok: true, commitment: { id: "c1", commitmentNo: "PO-2026-0003", spendRequestId: "sr1", budgetId: "b1" } };

beforeEach(() => {
  process.env.PROCUREMENT_MODULE_ENABLED = "true";
  vi.clearAllMocks();
  svc.listCommitments.mockResolvedValue([]);
  svc.renderOrderPdf.mockResolvedValue({ ok: true, commitmentNo: "PO-2026-0003", pdf: Buffer.from("%PDF-1.4 x") });
  svc.sendOrderToSupplier.mockResolvedValue(okOrder);
  svc.receiveOrder.mockResolvedValue(okOrder);
  svc.confirmReceipt.mockResolvedValue(okOrder);
  svc.cancelOrder.mockResolvedValue(okOrder);
  svc.raiseOrder.mockResolvedValue(okOrder);
  reqSvc.getSpendRequest.mockResolvedValue({ ok: true, request: { id: "sr1", quotes: [{ id: "q1", fileUrl: "/uploads/procurement-quotes/org-1/q1-x.pdf", fileName: "quote.pdf", fileMimeType: "application/pdf" }, { id: "q2", fileUrl: null }] } });
  reqSvc.setQuoteFile.mockResolvedValue({ ok: true, request: { id: "sr1" }, replacedFileUrl: null });
  storage.uploadFile.mockResolvedValue("/uploads/procurement-quotes/org-1/q2-new.pdf");
  storage.readStoredFile.mockResolvedValue(Buffer.from("%PDF-1.4 bytes"));
  storage.deleteStoredFile.mockResolvedValue(undefined);
});
afterEach(() => { delete process.env.PROCUREMENT_MODULE_ENABLED; });

describe("the guard", () => {
  it("is a 404 with the module off and a 401 signed out", async () => {
    delete process.env.PROCUREMENT_MODULE_ENABLED;
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    expect((await list(get("/api/procurement/commitments"))).status).toBe(404);
    process.env.PROCUREMENT_MODULE_ENABLED = "true";
    authMock.mockResolvedValue(null);
    expect((await pdf(get("/api/procurement/commitments/c1/pdf"), cParams())).status).toBe(401);
  });
  it("org staff read the list; an unknown status filter is a 400; a role outside the module is refused", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const ok = await list(get("/api/procurement/commitments?status=APPROVED&budgetId=b1"));
    expect(ok.status).toBe(200);
    expect(svc.listCommitments).toHaveBeenCalledWith(ORG, { status: "APPROVED", budgetId: "b1", supplierId: undefined });
    expect((await list(get("/api/procurement/commitments?status=NOPE"))).status).toBe(400);
    authMock.mockResolvedValue(user({ role: "CRM_USER" }));
    expect((await list(get("/api/procurement/commitments"))).status).toBe(403);
  });
});

describe("the PDF", () => {
  it("streams the rendered order inline as application/pdf", async () => {
    authMock.mockResolvedValue(user({ role: "ORGANIZER" }));
    const res = await pdf(get("/api/procurement/commitments/c1/pdf"), cParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="PO-2026-0003.pdf"');
    expect(svc.renderOrderPdf).toHaveBeenCalledWith(ORG, "c1");
    svc.renderOrderPdf.mockResolvedValueOnce({ ok: false, code: "COMMITMENT_NOT_FOUND", message: "x" });
    expect((await pdf(get("/api/procurement/commitments/nope/pdf"), cParams("nope"))).status).toBe(404);
  });
});

describe("the actions hand the service the actor's grants", () => {
  it("send: a MEMBER with the request grant is passed as canRequest, an ADMIN as isAdmin, a settle holder as canSettle", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    expect((await send(post("/api/procurement/commitments/c1/send"), cParams())).status).toBe(200);
    expect(svc.sendOrderToSupplier.mock.calls[0][0]).toMatchObject({ organizationId: ORG, commitmentId: "c1", actor: { id: "u1", isAdmin: false, canRequest: true, canSettle: false, canApprove: false } });
    authMock.mockResolvedValue(user({ role: "ADMIN", procurementApproveCeilingAed: 1000000 }));
    await send(post("/api/procurement/commitments/c1/send"), cParams());
    expect(svc.sendOrderToSupplier.mock.calls[1][0].actor).toMatchObject({ isAdmin: true, canApprove: true, canSettle: false });
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    await send(post("/api/procurement/commitments/c1/send"), cParams());
    expect(svc.sendOrderToSupplier.mock.calls[2][0].actor).toMatchObject({ isAdmin: false, canSettle: true, canApprove: false });
    svc.sendOrderToSupplier.mockResolvedValueOnce({ ok: false, code: "NOT_ALLOWED", message: "no" });
    expect((await send(post("/api/procurement/commitments/c1/send"), cParams())).status).toBe(403);
    svc.sendOrderToSupplier.mockResolvedValueOnce({ ok: false, code: "NO_SUPPLIER_EMAIL", message: "no" });
    expect((await send(post("/api/procurement/commitments/c1/send"), cParams())).status).toBe(422);
  });
  it("receive validates the body and passes the extent; confirm and cancel pass the version and the reason", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    expect((await receive(post("/api/procurement/commitments/c1/receive", { extent: "SOME", expectedVersion: 1 }), cParams())).status).toBe(400);
    expect(svc.receiveOrder).not.toHaveBeenCalled();
    expect((await receive(post("/api/procurement/commitments/c1/receive", { extent: "PARTIAL", expectedVersion: 2 }), cParams())).status).toBe(200);
    expect(svc.receiveOrder.mock.calls[0][0]).toMatchObject({ commitmentId: "c1", extent: "PARTIAL", expectedVersion: 2 });
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementSettle: true }));
    expect((await confirm(post("/api/procurement/commitments/c1/confirm-receipt", { expectedVersion: 3 }), cParams())).status).toBe(200);
    expect(svc.confirmReceipt.mock.calls[0][0]).toMatchObject({ expectedVersion: 3, actor: { canSettle: true } });
    expect((await cancel(post("/api/procurement/commitments/c1/cancel", { reason: "", expectedVersion: 1 }), cParams())).status).toBe(400);
    expect((await cancel(post("/api/procurement/commitments/c1/cancel", { reason: "Supplier withdrew", expectedVersion: 1 }), cParams())).status).toBe(200);
    expect(svc.cancelOrder.mock.calls[0][0]).toMatchObject({ reason: "Supplier withdrew", expectedVersion: 1 });
    svc.cancelOrder.mockResolvedValueOnce({ ok: false, code: "STALE_WRITE", message: "x" });
    expect((await cancel(post("/api/procurement/commitments/c1/cancel", { reason: "r", expectedVersion: 1 }), cParams())).status).toBe(409);
  });
  it("raise answers 201 with the order and maps ALREADY_ORDERED to 409", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    const res = await raise(post("/api/procurement/requests/sr1/order"), { params: Promise.resolve({ requestId: "sr1" }) });
    expect(res.status).toBe(201);
    expect(svc.raiseOrder.mock.calls[0][0]).toMatchObject({ requestId: "sr1", actor: { isAdmin: true } });
    svc.raiseOrder.mockResolvedValueOnce({ ok: false, code: "ALREADY_ORDERED", message: "x" });
    expect((await raise(post("/api/procurement/requests/sr1/order"), { params: Promise.resolve({ requestId: "sr1" }) })).status).toBe(409);
  });
});

describe("the quote file", () => {
  const qParams = (quoteId = "q2") => ({ params: Promise.resolve({ requestId: "sr1", quoteId }) });
  function multipart(bytes: Buffer, name = "quote.pdf", type = "application/pdf") {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    return new NextRequest("http://localhost/api/procurement/requests/sr1/quotes/q2/file", { method: "POST", body: form });
  }
  it("refuses a caller without the request grant or the admin role, a form with no file, and bytes that are not a PDF or image", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    expect((await uploadQuote(multipart(Buffer.from("%PDF-1.4")), qParams())).status).toBe(403);
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    const empty = new NextRequest("http://localhost/x", { method: "POST", body: new FormData() });
    expect((await uploadQuote(empty, qParams())).status).toBe(400);
    const res = await uploadQuote(multipart(Buffer.from("<html>not a pdf</html>"), "quote.pdf"), qParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "UNSUPPORTED_TYPE" });
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });
  it("stores a real PDF under the private prefix, records it on the row, and removes the file again when the row refuses it", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    const res = await uploadQuote(multipart(Buffer.from("%PDF-1.4 real")), qParams());
    expect(res.status).toBe(201);
    expect(storage.uploadFile.mock.calls[0].slice(2)).toEqual(["application/pdf", "procurement-quotes/org-1"]);
    expect(reqSvc.setQuoteFile.mock.calls[0][0]).toMatchObject({ requestId: "sr1", quoteId: "q2", fileUrl: "/uploads/procurement-quotes/org-1/q2-new.pdf", fileName: "quote.pdf", fileMimeType: "application/pdf" });
    expect(storage.deleteStoredFile).not.toHaveBeenCalled();
    reqSvc.setQuoteFile.mockResolvedValueOnce({ ok: false, code: "INVALID_STATUS", message: "not a draft" });
    expect((await uploadQuote(multipart(Buffer.from("%PDF-1.4 real")), qParams())).status).toBe(409);
    expect(storage.deleteStoredFile).toHaveBeenCalledWith("/uploads/procurement-quotes/org-1/q2-new.pdf", "/uploads/procurement-quotes/");
  });
  it("a replaced file is deleted after the row took the new one; DELETE clears the row then removes the file", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    reqSvc.setQuoteFile.mockResolvedValueOnce({ ok: true, request: { id: "sr1" }, replacedFileUrl: "/uploads/procurement-quotes/org-1/q2-old.pdf" });
    await uploadQuote(multipart(Buffer.from("%PDF-1.4 v2")), qParams());
    expect(storage.deleteStoredFile).toHaveBeenCalledWith("/uploads/procurement-quotes/org-1/q2-old.pdf", "/uploads/procurement-quotes/");
    reqSvc.setQuoteFile.mockResolvedValueOnce({ ok: true, request: { id: "sr1" }, replacedFileUrl: "/uploads/procurement-quotes/org-1/q1-x.pdf" });
    expect((await dropQuote(get("/x"), qParams("q1"))).status).toBe(200);
    expect(reqSvc.setQuoteFile.mock.calls.at(-1)![0]).toMatchObject({ quoteId: "q1", fileUrl: null, fileName: null });
    expect(storage.deleteStoredFile).toHaveBeenLastCalledWith("/uploads/procurement-quotes/org-1/q1-x.pdf", "/uploads/procurement-quotes/");
  });
  it("GET streams the file bound to the request for a reader, and 404s a quote without one", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await readQuote(get("/x"), qParams("q1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(storage.readStoredFile).toHaveBeenCalledWith("/uploads/procurement-quotes/org-1/q1-x.pdf", "/uploads/procurement-quotes/");
    expect((await readQuote(get("/x"), qParams("q2"))).status).toBe(404);
  });
});

describe("review fixes, 15 September 2026", () => {
  const qParams = (quoteId = "q2") => ({ params: Promise.resolve({ requestId: "sr1", quoteId }) });
  function multipart(bytes: Buffer, name = "quote.pdf", type = "application/pdf") {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    return new NextRequest("http://localhost/api/procurement/requests/sr1/quotes/q2/file", { method: "POST", body: form });
  }
  it("send has its own limit of 10 an hour per person", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 1200 });
    const res = await send(post("/api/procurement/commitments/c1/send"), cParams());
    expect(res.status).toBe(429);
    expect(svc.sendOrderToSupplier).not.toHaveBeenCalled();
  });
  it("a storage or database error while attaching a quote is a 500 that removes the stored file", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER", procurementRequest: true }));
    reqSvc.setQuoteFile.mockRejectedValueOnce(new Error("pooler blip"));
    const res = await uploadQuote(multipart(Buffer.from("%PDF-1.4 real")), qParams());
    expect(res.status).toBe(500);
    expect(storage.deleteStoredFile).toHaveBeenCalledWith("/uploads/procurement-quotes/org-1/q2-new.pdf", "/uploads/procurement-quotes/");
  });
  it("the quote file is served with nosniff and a content security policy", async () => {
    authMock.mockResolvedValue(user({ role: "MEMBER" }));
    const res = await readQuote(get("/x"), qParams("q1"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
  it("raise and cancel hand the page the email outcome and where the request went", async () => {
    authMock.mockResolvedValue(user({ role: "ADMIN" }));
    svc.raiseOrder.mockResolvedValueOnce({ ...okOrder, autoSend: { requested: true, sent: false, code: "SEND_FAILED" } });
    expect(await (await raise(post("/api/procurement/requests/sr1/order"), { params: Promise.resolve({ requestId: "sr1" }) })).json()).toMatchObject({ autoSend: { sent: false, code: "SEND_FAILED" } });
    svc.cancelOrder.mockResolvedValueOnce({ ...okOrder, reroute: { status: "PENDING_APPROVAL", approvalRequestId: "ar9", exception: false } });
    expect(await (await cancel(post("/api/procurement/commitments/c1/cancel", { reason: "Late", expectedVersion: 1 }), cParams())).json()).toMatchObject({ reroute: { status: "PENDING_APPROVAL" } });
  });
});
