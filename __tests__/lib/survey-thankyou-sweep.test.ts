/**
 * decideThankYouDelivery — the pure decision at the heart of the deferred
 * survey thank-you: hold the email (wait for the cert), send it with the cert,
 * or send it plain. Every branch pinned.
 */
import { describe, it, expect } from "vitest";
import { decideThankYouDelivery, THANKYOU_FALLBACK_MS } from "@/lib/certificates/survey-thankyou-sweep";

const FB = THANKYOU_FALLBACK_MS;
const base = { certChecked: true, pendingCerts: 0, readyCerts: 0, elapsedMs: 0, fallbackMs: FB };

describe("decideThankYouDelivery", () => {
  it("defers while a cert is still rendering and we're within the fallback window", () => {
    expect(decideThankYouDelivery({ ...base, certChecked: true, pendingCerts: 1, elapsedMs: 60_000 })).toBe("defer");
  });

  it("sends with the cert as soon as one is ready (no pending)", () => {
    expect(decideThankYouDelivery({ ...base, readyCerts: 1 })).toBe("send-with-cert");
  });

  it("prefers waiting for a still-rendering cert over sending a partial set (within window)", () => {
    // A speaker with one cert ready + one rendering: hold to attach both.
    expect(decideThankYouDelivery({ ...base, readyCerts: 1, pendingCerts: 1, elapsedMs: 5 * 60_000 })).toBe("defer");
  });

  it("sends whatever is ready once the fallback elapses, even if some are still pending", () => {
    expect(decideThankYouDelivery({ ...base, readyCerts: 1, pendingCerts: 1, elapsedMs: FB + 1 })).toBe("send-with-cert");
  });

  it("defers when eligibility hasn't been resolved yet (auto-issue sweep pending), within window", () => {
    expect(decideThankYouDelivery({ ...base, certChecked: false, elapsedMs: 30_000 })).toBe("defer");
  });

  it("sends plain when the person is resolved and earns no cert", () => {
    expect(decideThankYouDelivery({ ...base, certChecked: true, pendingCerts: 0, readyCerts: 0 })).toBe("send-plain");
  });

  it("sends plain as the fallback when a cert never renders in time", () => {
    // Eligible (pending) but the window elapsed with nothing ready.
    expect(decideThankYouDelivery({ ...base, certChecked: true, pendingCerts: 1, readyCerts: 0, elapsedMs: FB + 1 })).toBe("send-plain");
  });

  it("sends plain when never-resolved but the window elapsed (worker-down fallback)", () => {
    expect(decideThankYouDelivery({ ...base, certChecked: false, readyCerts: 0, elapsedMs: FB + 1 })).toBe("send-plain");
  });

  it("at exactly the fallback boundary, no longer defers (>= is 'elapsed')", () => {
    expect(decideThankYouDelivery({ ...base, pendingCerts: 1, elapsedMs: FB })).toBe("send-plain");
  });
});
