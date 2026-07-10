/**
 * processBundleRenderPhase (issue-worker.ts) — the bundle-model render phase.
 * Bundle primitives are mocked; we assert the orchestration:
 *   - renders exactly the item's stamped templateIds subset via findOrIssue
 *     (with issueRunItemId threading)
 *   - legacy pointer gets the FIRST cert; renderedCount increments per item
 *   - partial template failure → markItemFailed("render"), no renderedAt
 *   - missing run template → failRun hard (H4 policy)
 *   - phase-complete transition: manual → AWAITING_REVIEW, auto → SENDING
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockFindOrIssue, mockLoadTemplate } = vi.hoisted(() => ({
  mockDb: {
    certificateIssueRun: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    certificateIssueRunItem: { findMany: vi.fn(), update: vi.fn() },
    issuedCertificate: { findUnique: vi.fn(), findMany: vi.fn() },
    event: { findUnique: vi.fn() },
  },
  mockFindOrIssue: vi.fn(),
  mockLoadTemplate: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/certificates/render", () => ({ renderCertificate: vi.fn() }));
vi.mock("@/lib/storage", () => ({ uploadCertificatePdf: vi.fn() }));
vi.mock("@/lib/certificates/pdf-loader", () => ({ loadCertificatePdfBytes: vi.fn() }));
vi.mock("@/lib/certificates/cert-context", () => ({
  loadEventContext: vi.fn(),
  loadRecipient: vi.fn(),
  allocateSerial: vi.fn(),
  loadPosterAbstractTitle: vi.fn(),
}));
vi.mock("@/lib/certificates/deliver", () => ({ reRenderAndResendCert: vi.fn() }));
vi.mock("@/lib/certificates/bundle", () => ({
  sendCertificateBundleEmail: vi.fn(),
  loadBundleEmailEvent: vi.fn(),
  loadCertTemplate: (e: string, id: string) => mockLoadTemplate(e, id),
  findOrIssueCertificate: (args: unknown) => mockFindOrIssue(args),
}));

import { processBundleRenderPhase } from "@/lib/certificates/issue-worker";

const TPL = (id: string, category: "ATTENDANCE" | "APPRECIATION") => ({
  id,
  name: id,
  category,
  autoIssueTag: "t",
  template: { backgroundPdfUrl: null, textBoxes: [], role: null, cmeHours: null },
  emailSubject: null,
  emailBody: null,
});

function okCert(id: string) {
  return Promise.resolve({
    ok: true as const,
    cert: { certificateId: id, serial: id, type: "ATTENDANCE" as const, templateName: "T", pdfBuffer: Buffer.from("x"), reused: false },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.certificateIssueRun.update.mockResolvedValue({});
  mockDb.certificateIssueRun.findUnique.mockResolvedValue({ errors: [] });
  mockDb.certificateIssueRunItem.update.mockResolvedValue({});
  mockLoadTemplate.mockImplementation((_e: string, id: string) =>
    Promise.resolve(TPL(id, id === "tpl-app" ? "APPRECIATION" : "ATTENDANCE")),
  );
  mockFindOrIssue.mockImplementation((args: { templateId: string }) => okCert(`cert-${args.templateId}`));
});

describe("processBundleRenderPhase", () => {
  const ITEM = {
    id: "item-1",
    registrationId: "reg-1",
    speakerId: "spk-1",
    recipientName: "Dr. Jane",
    recipientEmail: "jane@x.com",
    templateIds: ["tpl-att", "tpl-app"],
    renderedAt: null,
    issuedCertificateId: null,
  };

  it("issues one cert per stamped template, threading the run item id", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([ITEM]);
    const res = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att", "tpl-app"], false, "user-1");
    expect(res.renderedThisTick).toBe(1);
    expect(mockFindOrIssue).toHaveBeenCalledTimes(2);
    expect(mockFindOrIssue.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ templateId: "tpl-att", issueRunItemId: "item-1", registrationId: "reg-1", speakerId: "spk-1" }),
        expect.objectContaining({ templateId: "tpl-app", issueRunItemId: "item-1" }),
      ]),
    );
    // Legacy pointer = FIRST cert; renderedAt stamped.
    const itemUpdate = mockDb.certificateIssueRunItem.update.mock.calls[0][0];
    expect(itemUpdate.data.issuedCertificateId).toBe("cert-tpl-att");
    expect(itemUpdate.data.renderedAt).toBeInstanceOf(Date);
  });

  it("renders only the item's stamped subset, not every run template", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([{ ...ITEM, templateIds: ["tpl-att"] }]);
    await processBundleRenderPhase("run-1", "evt-1", ["tpl-att", "tpl-app"], false, "user-1");
    expect(mockFindOrIssue).toHaveBeenCalledTimes(1);
    expect(mockFindOrIssue.mock.calls[0][0]).toMatchObject({ templateId: "tpl-att" });
  });

  it("MANUAL run: marks the item render-failed (no renderedAt) on partial template failure", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([ITEM]);
    mockFindOrIssue.mockImplementation((args: { templateId: string }) =>
      args.templateId === "tpl-app"
        ? Promise.resolve({ ok: false as const, code: "RENDER_FAILED" as const, error: "boom" })
        : okCert("cert-tpl-att"),
    );
    const res = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att", "tpl-app"], false, "user-1");
    expect(res.renderedThisTick).toBe(0);
    // markItemFailed sets errorPhase render + renderedAt (batch exclusion),
    // but NOT issuedCertificateId — the item isn't email-eligible.
    const failUpdate = mockDb.certificateIssueRunItem.update.mock.calls[0][0];
    expect(failUpdate.data.errorPhase).toBe("render");
    expect(failUpdate.data.errorMessage).toContain("boom");
    expect(failUpdate.data.issuedCertificateId).toBeUndefined();
  });

  it("AUTO run: partial failure still DELIVERS the certs that rendered (no operator to retry)", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([ITEM]);
    mockFindOrIssue.mockImplementation((args: { templateId: string }) =>
      args.templateId === "tpl-app"
        ? Promise.resolve({ ok: false as const, code: "RENDER_FAILED" as const, error: "boom" })
        : okCert("cert-tpl-att"),
    );
    const res = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att", "tpl-app"], true, null);
    expect(res.renderedThisTick).toBe(1);
    // Item marked rendered (email-eligible) WITHOUT errorPhase; the miss is
    // recorded on the run (errors append + failedCount) instead.
    const itemUpdate = mockDb.certificateIssueRunItem.update.mock.calls[0][0];
    expect(itemUpdate.data.renderedAt).toBeInstanceOf(Date);
    expect(itemUpdate.data.errorPhase).toBeUndefined();
    const failBump = mockDb.certificateIssueRun.update.mock.calls.find(
      (c) => c[0].data.failedCount,
    );
    expect(failBump).toBeTruthy();
  });

  it("falls back to renderedAt-only when the legacy @unique pointer is held by another item (P2002)", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([{ ...ITEM, templateIds: ["tpl-att"] }]);
    const { Prisma } = await import("@prisma/client");
    mockDb.certificateIssueRunItem.update
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "t" }),
      )
      .mockResolvedValueOnce({});
    const res = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att"], false, "user-1");
    // Item still counts as rendered — the send phase recomputes the cert
    // set from templateIds, so the missing legacy pointer is harmless.
    expect(res.renderedThisTick).toBe(1);
    const retry = mockDb.certificateIssueRunItem.update.mock.calls[1][0];
    expect(retry.data.renderedAt).toBeInstanceOf(Date);
    expect(retry.data.issuedCertificateId).toBeUndefined();
  });

  it("an unexpected throw is contained per-item via markItemFailed (run never wedges)", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([{ ...ITEM, templateIds: ["tpl-att"] }]);
    mockFindOrIssue.mockRejectedValue(new Error("connection closed"));
    const res = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att"], false, "user-1");
    expect(res.renderedThisTick).toBe(0);
    const failUpdate = mockDb.certificateIssueRunItem.update.mock.calls[0][0];
    expect(failUpdate.data.errorPhase).toBe("render");
    expect(failUpdate.data.errorMessage).toContain("connection closed");
  });

  it("fails the run hard when a run template was deleted mid-run (H4)", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([ITEM]);
    mockLoadTemplate.mockImplementation((_e: string, id: string) =>
      Promise.resolve(id === "tpl-app" ? null : TPL(id, "ATTENDANCE")),
    );
    const res = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att", "tpl-app"], false, "user-1");
    expect(res.transitionedTo).toBe("FAILED");
    expect(mockFindOrIssue).not.toHaveBeenCalled();
    const runUpdate = mockDb.certificateIssueRun.update.mock.calls.find(
      (c) => c[0].data.status === "FAILED",
    );
    expect(runUpdate).toBeTruthy();
  });

  it("transitions manual runs to AWAITING_REVIEW and auto runs to SENDING when drained", async () => {
    mockDb.certificateIssueRunItem.findMany.mockResolvedValue([]);
    const manual = await processBundleRenderPhase("run-1", "evt-1", ["tpl-att"], false, "user-1");
    expect(manual.transitionedTo).toBe("AWAITING_REVIEW");
    const auto = await processBundleRenderPhase("run-2", "evt-1", ["tpl-att"], true, null);
    expect(auto.transitionedTo).toBeNull(); // SENDING transition returns null (same as legacy)
    const sendingUpdate = mockDb.certificateIssueRun.update.mock.calls.find(
      (c) => c[0].data.status === "SENDING",
    );
    expect(sendingUpdate).toBeTruthy();
  });
});
