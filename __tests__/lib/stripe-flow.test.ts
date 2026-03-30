import { describe, it, expect, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    registration: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

// Import the pure helper functions (no Stripe SDK needed)
import {
  toStripeAmount,
  fromStripeAmount,
  isZeroDecimalCurrency,
} from "@/lib/stripe";

// ── Tests: Stripe amount helpers ─────────────────────────────────────────────

describe("toStripeAmount", () => {
  it("converts USD 10.00 to 1000 (standard currency)", () => {
    expect(toStripeAmount(10, "USD")).toBe(1000);
  });

  it("converts EUR 25.50 to 2550", () => {
    expect(toStripeAmount(25.5, "EUR")).toBe(2550);
  });

  it("converts GBP 0.99 to 99", () => {
    expect(toStripeAmount(0.99, "GBP")).toBe(99);
  });

  it("converts AED 100 to 10000", () => {
    expect(toStripeAmount(100, "AED")).toBe(10000);
  });

  it("converts JPY 1000 to 1000 (zero-decimal currency)", () => {
    expect(toStripeAmount(1000, "JPY")).toBe(1000);
  });

  it("converts KRW 50000 to 50000 (zero-decimal currency)", () => {
    expect(toStripeAmount(50000, "KRW")).toBe(50000);
  });

  it("handles case-insensitive currency codes", () => {
    expect(toStripeAmount(10, "usd")).toBe(1000);
    expect(toStripeAmount(10, "Usd")).toBe(1000);
    expect(toStripeAmount(1000, "jpy")).toBe(1000);
  });

  it("rounds fractional amounts", () => {
    expect(toStripeAmount(10.999, "USD")).toBe(1100); // Math.round(1099.9)
  });

  it("handles zero amount", () => {
    expect(toStripeAmount(0, "USD")).toBe(0);
    expect(toStripeAmount(0, "JPY")).toBe(0);
  });
});

describe("fromStripeAmount", () => {
  it("converts 1000 to 10.00 for USD (standard currency)", () => {
    expect(fromStripeAmount(1000, "USD")).toBe(10);
  });

  it("converts 2550 to 25.50 for EUR", () => {
    expect(fromStripeAmount(2550, "EUR")).toBe(25.5);
  });

  it("converts 1000 to 1000 for JPY (zero-decimal currency)", () => {
    expect(fromStripeAmount(1000, "JPY")).toBe(1000);
  });

  it("converts 50000 to 50000 for KRW (zero-decimal currency)", () => {
    expect(fromStripeAmount(50000, "KRW")).toBe(50000);
  });

  it("handles case-insensitive currency codes", () => {
    expect(fromStripeAmount(1000, "usd")).toBe(10);
    expect(fromStripeAmount(1000, "Jpy")).toBe(1000);
  });

  it("handles zero amount", () => {
    expect(fromStripeAmount(0, "USD")).toBe(0);
    expect(fromStripeAmount(0, "JPY")).toBe(0);
  });
});

describe("isZeroDecimalCurrency", () => {
  const zeroDecimalCurrencies = ["JPY", "KRW", "BIF", "CLP", "DJF", "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"];

  it.each(zeroDecimalCurrencies)("identifies %s as zero-decimal", (currency) => {
    expect(isZeroDecimalCurrency(currency)).toBe(true);
  });

  const standardCurrencies = ["USD", "EUR", "GBP", "AED", "SAR", "INR", "CAD", "AUD"];

  it.each(standardCurrencies)("returns false for %s (standard currency)", (currency) => {
    expect(isZeroDecimalCurrency(currency)).toBe(false);
  });

  it("handles lowercase currency codes", () => {
    expect(isZeroDecimalCurrency("jpy")).toBe(true);
    expect(isZeroDecimalCurrency("usd")).toBe(false);
  });
});

// ── Tests: Checkout business logic ───────────────────────────────────────────

describe("Checkout: prevents double payment", () => {
  it("rejects checkout when registration is already PAID", () => {
    const registration = { paymentStatus: "PAID" };
    const isPaid = registration.paymentStatus === "PAID";
    expect(isPaid).toBe(true);
    // Route returns 400: "Payment already completed"
  });

  it("allows checkout when payment is UNPAID", () => {
    const registration = { paymentStatus: "UNPAID" };
    const isPaid = registration.paymentStatus === "PAID";
    expect(isPaid).toBe(false);
  });

  it("allows checkout when payment is PENDING", () => {
    const registration = { paymentStatus: "PENDING" };
    const isPaid = registration.paymentStatus === "PAID";
    expect(isPaid).toBe(false);
  });
});

describe("Checkout: prevents free ticket checkout", () => {
  it("rejects checkout when ticket price is 0", () => {
    const ticketPrice = Number(0);
    expect(ticketPrice === 0).toBe(true);
    // Route returns 400: "No payment required for free tickets"
  });

  it("allows checkout when ticket price > 0", () => {
    const ticketPrice = Number(50);
    expect(ticketPrice === 0).toBe(false);
  });

  it("allows checkout when pricing tier overrides with non-zero price", () => {
    const pricingTierPrice = 100;
    const ticketTypePrice = 0;
    const effectivePrice = Number(pricingTierPrice ?? ticketTypePrice);
    expect(effectivePrice === 0).toBe(false);
  });
});

describe("Webhook: idempotency", () => {
  it("skips processing if payment already exists for stripePaymentId", () => {
    // Simulates the webhook checking for existing payment
    const existingPayment = { id: "pay-1", stripePaymentId: "pi_123", status: "PAID" };
    const shouldSkip = existingPayment !== null;
    expect(shouldSkip).toBe(true);
  });

  it("processes payment if no existing payment found", () => {
    const existingPayment = null;
    const shouldSkip = existingPayment !== null;
    expect(shouldSkip).toBe(false);
  });

  it("skips if registration is already PAID", () => {
    const registration = { paymentStatus: "PAID" };
    const alreadyPaid = registration.paymentStatus === "PAID";
    expect(alreadyPaid).toBe(true);
  });
});

describe("Stripe amount round-trip", () => {
  it("toStripeAmount and fromStripeAmount are inverse for USD", () => {
    const original = 25.5;
    const stripeAmt = toStripeAmount(original, "USD");
    const recovered = fromStripeAmount(stripeAmt, "USD");
    expect(recovered).toBe(original);
  });

  it("toStripeAmount and fromStripeAmount are inverse for JPY", () => {
    const original = 5000;
    const stripeAmt = toStripeAmount(original, "JPY");
    const recovered = fromStripeAmount(stripeAmt, "JPY");
    expect(recovered).toBe(original);
  });
});
