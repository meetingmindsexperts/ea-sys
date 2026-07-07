/**
 * captureStripeReceipt — downloads Stripe's hosted receipt HTML and re-hosts a
 * durable local snapshot. SSRF-guarded (Stripe hosts only), failure-isolated
 * (never throws — returns null on any problem).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { uploadStripeReceiptMock } = vi.hoisted(() => ({
  uploadStripeReceiptMock: vi.fn().mockResolvedValue("/uploads/stripe-receipts/2026/07/abc.html"),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/storage", () => ({ uploadStripeReceipt: uploadStripeReceiptMock }));

import { captureStripeReceipt } from "@/lib/stripe-receipt";

const bigHtml = "<html>" + "x".repeat(200) + "</html>";

beforeEach(() => {
  vi.clearAllMocks();
  uploadStripeReceiptMock.mockResolvedValue("/uploads/stripe-receipts/2026/07/abc.html");
  vi.stubGlobal("fetch", vi.fn());
});

function mockFetch(impl: () => Promise<unknown> | unknown) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(impl as never);
}

describe("captureStripeReceipt", () => {
  it("downloads a Stripe-hosted receipt and returns the stored snapshot path", async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => bigHtml }));
    const out = await captureStripeReceipt("https://pay.stripe.com/receipts/abc123");
    expect(out).toBe("/uploads/stripe-receipts/2026/07/abc.html");
    expect(uploadStripeReceiptMock).toHaveBeenCalledTimes(1);
    // Stored as .html
    expect(uploadStripeReceiptMock.mock.calls[0][1]).toMatch(/\.html$/);
  });

  it("accepts any *.stripe.com subdomain over https", async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => bigHtml }));
    expect(await captureStripeReceipt("https://receipts.stripe.com/x")).not.toBeNull();
  });

  it("returns null (no fetch) for a non-Stripe host — SSRF guard", async () => {
    const out = await captureStripeReceipt("https://evil.example.com/receipt");
    expect(out).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(uploadStripeReceiptMock).not.toHaveBeenCalled();
  });

  it("returns null for a non-https Stripe URL", async () => {
    const out = await captureStripeReceipt("http://pay.stripe.com/receipts/abc");
    expect(out).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects a look-alike host (stripe.com.evil.com)", async () => {
    const out = await captureStripeReceipt("https://stripe.com.evil.com/receipt");
    expect(out).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null when the URL is missing", async () => {
    expect(await captureStripeReceipt(null)).toBeNull();
    expect(await captureStripeReceipt(undefined)).toBeNull();
    expect(await captureStripeReceipt("")).toBeNull();
  });

  it("returns null on a non-OK response (does not store)", async () => {
    mockFetch(async () => ({ ok: false, status: 404, text: async () => "" }));
    expect(await captureStripeReceipt("https://pay.stripe.com/receipts/x")).toBeNull();
    expect(uploadStripeReceiptMock).not.toHaveBeenCalled();
  });

  it("returns null on a suspiciously empty body", async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => "tiny" }));
    expect(await captureStripeReceipt("https://pay.stripe.com/receipts/x")).toBeNull();
    expect(uploadStripeReceiptMock).not.toHaveBeenCalled();
  });

  it("never throws — returns null when fetch rejects (timeout / network)", async () => {
    mockFetch(async () => { throw new Error("aborted"); });
    await expect(captureStripeReceipt("https://pay.stripe.com/receipts/x")).resolves.toBeNull();
  });

  it("never throws — returns null when storage fails", async () => {
    mockFetch(async () => ({ ok: true, status: 200, text: async () => bigHtml }));
    uploadStripeReceiptMock.mockRejectedValue(new Error("disk full"));
    await expect(captureStripeReceipt("https://pay.stripe.com/receipts/x")).resolves.toBeNull();
  });
});
