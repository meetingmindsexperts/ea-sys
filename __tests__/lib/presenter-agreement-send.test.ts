/**
 * The presenter agreement in any email (September 25, 2026; owner: "whichever
 * email has {{presenterAgreementAttachment}} has to send that"). Owner
 * decisions: speakers and abstract authors; an author who already accepted
 * gets nothing; PDF plus an accept link ({{presenterAgreementLink}}).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks, mockLogger } = vi.hoisted(() => ({
  mocks: { mint: vi.fn(), pdf: vi.fn() },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/presenter-agreement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/presenter-agreement")>()),
  mintPresenterAgreementLink: mocks.mint,
  generatePresenterAgreementPdf: mocks.pdf,
}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { resolvePresenterAgreementForSend } from "@/lib/presenter-agreement-send";

const base: { eventId: string; eventSlug: string; speakerId: string; acceptedAt: Date | null } = { eventId: "ev1", eventSlug: "mehf2027", speakerId: "sp1", acceptedAt: null };
const run = (texts: string[], over: Partial<typeof base> = {}) =>
  resolvePresenterAgreementForSend({ ...base, ...over, texts });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mint.mockResolvedValue("https://x/e/mehf2027/presenter-agreement?token=abc");
  mocks.pdf.mockResolvedValue({ buffer: Buffer.from("%PDF-1"), filename: "presenter-agreement-mehf2027-bader.pdf" });
});

describe("resolvePresenterAgreementForSend", () => {
  it("does nothing, and mints nothing, when no text uses a presenter token", async () => {
    const r = await run(["<p>Dear {{speakerName}}</p>", "{{agreementAttachment}}"]);
    expect(r).toEqual({ vars: { presenterAgreementAttachment: "", presenterAgreementLink: "" }, attachment: null });
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("the invisible marker attaches the author's PDF and renders as nothing, without minting a link", async () => {
    const r = await run(["<p>Hi</p>{{presenterAgreementAttachment}}"]);
    expect(r.vars.presenterAgreementAttachment).toBe("");
    expect(r.attachment).toEqual({ name: "presenter-agreement-mehf2027-bader.pdf", content: Buffer.from("%PDF-1").toString("base64"), contentType: "application/pdf" });
    expect(mocks.pdf).toHaveBeenCalledWith({ eventId: "ev1", speakerId: "sp1" });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("the link token mints additively, so a bulk send never kills a link the author already holds", async () => {
    const r = await run(["Accept here: {{presenterAgreementLink}}"]);
    expect(r.vars.presenterAgreementLink).toContain("/presenter-agreement?token=");
    expect(mocks.mint).toHaveBeenCalledWith("sp1", "mehf2027", { rotate: false });
    expect(r.attachment).toBeNull();
  });

  it("finds a token typed into the message, not only the template", async () => {
    const r = await run(["<p>{{personalMessage}}</p>", "Please sign {{presenterAgreementLink}} {{presenterAgreementAttachment}}"]);
    expect(r.vars.presenterAgreementLink).not.toBe("");
    expect(r.attachment).not.toBeNull();
  });

  it("gives an author who already accepted neither the link nor the file", async () => {
    const r = await run(["{{presenterAgreementLink}}{{presenterAgreementAttachment}}"], { acceptedAt: new Date("2026-09-20") });
    expect(r).toEqual({ vars: { presenterAgreementAttachment: "", presenterAgreementLink: "" }, attachment: null });
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("sends without the file when the PDF fails, and logs it; the link still goes", async () => {
    mocks.pdf.mockRejectedValueOnce(new Error("renderer down"));
    const r = await run(["{{presenterAgreementLink}}{{presenterAgreementAttachment}}"]);
    expect(r.attachment).toBeNull();
    expect(r.vars.presenterAgreementLink).not.toBe("");
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "presenter-agreement:send-attach-failed", speakerId: "sp1" }));
  });

  it("lets a failed link mint throw, so that recipient fails rather than getting a dead link", async () => {
    mocks.mint.mockRejectedValueOnce(new Error("db down"));
    await expect(run(["{{presenterAgreementLink}}"])).rejects.toThrow("db down");
  });
});
