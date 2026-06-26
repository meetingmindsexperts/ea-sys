/**
 * Phase 2 H2 — stall-reclaim must be autoIssue-aware.
 * A stalled SENDING run is bounced to AWAITING_REVIEW only for MANUAL runs
 * (an operator re-confirms). AUTO (survey-gated) runs have no operator, so
 * demoting them would strand the run un-emailed forever (the registration is
 * already terminally stamped → the sweep won't re-enqueue). They must stay
 * SENDING with a refreshed lastTickAt so the next tick re-drains them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { certificateIssueRun: { updateMany: (...a: unknown[]) => updateMany(...a) } },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Stub the worker's heavy collaborators so the module imports cleanly — this
// test only exercises reclaimStalledRuns (pure updateMany orchestration).
vi.mock("@/lib/certificates/render", () => ({ renderCertificate: vi.fn() }));
vi.mock("@/lib/storage", () => ({ uploadCertificatePdf: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  wrapWithBranding: vi.fn(),
  inlineCss: vi.fn(),
  brandingFrom: vi.fn(),
}));
vi.mock("@/lib/certificates/email-tokens-resolver", () => ({ resolveCoverEmailTokens: vi.fn() }));
vi.mock("@/lib/certificates/email-tokens", () => ({
  SYSTEM_DEFAULT_SUBJECT: "subject",
  defaultBodyForCategory: vi.fn(() => "body"),
}));

import { reclaimStalledRuns } from "@/lib/certificates/issue-worker";

beforeEach(() => {
  updateMany.mockReset();
});

describe("reclaimStalledRuns (autoIssue-aware)", () => {
  it("demotes manual SENDING stalls but keeps auto SENDING stalls in SENDING (lastTickAt refresh)", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await reclaimStalledRuns();

    expect(updateMany).toHaveBeenCalledTimes(3);
    const [rendering, manualSending, autoSending] = updateMany.mock.calls.map((c) => c[0]);

    // (1) RENDERING → PENDING (both manual + auto; harmless re-render)
    expect(rendering.where.status).toBe("RENDERING");
    expect(rendering.data).toEqual({ status: "PENDING" });

    // (2) MANUAL SENDING → AWAITING_REVIEW
    expect(manualSending.where.status).toBe("SENDING");
    expect(manualSending.where.autoIssue).toBe(false);
    expect(manualSending.data).toEqual({ status: "AWAITING_REVIEW" });

    // (3) AUTO SENDING → stay SENDING, only refresh lastTickAt (NO status change)
    expect(autoSending.where.status).toBe("SENDING");
    expect(autoSending.where.autoIssue).toBe(true);
    expect(autoSending.data.status).toBeUndefined();
    expect(autoSending.data.lastTickAt).toBeInstanceOf(Date);
  });

  it("sums the count across all three reclaim queries", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 3 });

    expect(await reclaimStalledRuns()).toBe(6);
  });
});
