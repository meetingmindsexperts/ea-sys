/**
 * Persistent CRM email-send dedup (CRM review M2). Pins the atomic claim:
 * a fresh (org, hash) wins; a claim still inside the window loses (duplicate);
 * a STALE claim is re-taken; a prune failure never blocks a send; a non-P2002
 * error propagates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  db: {
    crmEmailSendClaim: { create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { claimCrmEmailSend } from "@/crm/lib/crm-email-dedup";

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "x" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.crmEmailSendClaim.deleteMany).mockResolvedValue({ count: 0 } as never);
});

describe("claimCrmEmailSend", () => {
  it("no prior claim → create succeeds → WON (proceed)", async () => {
    vi.mocked(db.crmEmailSendClaim.create).mockResolvedValue({ id: "c-1" } as never);
    expect(await claimCrmEmailSend("org-1", "hash-a")).toBe(true);
    expect(db.crmEmailSendClaim.updateMany).not.toHaveBeenCalled();
  });

  it("an identical send still inside the window → LOST (409 duplicate)", async () => {
    vi.mocked(db.crmEmailSendClaim.create).mockRejectedValue(p2002());
    // The stale-only refresh matches nothing (the existing claim is fresh).
    vi.mocked(db.crmEmailSendClaim.updateMany).mockResolvedValue({ count: 0 } as never);
    expect(await claimCrmEmailSend("org-1", "hash-a")).toBe(false);
  });

  it("a STALE claim (outside the window) is re-taken → WON", async () => {
    vi.mocked(db.crmEmailSendClaim.create).mockRejectedValue(p2002());
    vi.mocked(db.crmEmailSendClaim.updateMany).mockResolvedValue({ count: 1 } as never);
    expect(await claimCrmEmailSend("org-1", "hash-a")).toBe(true);
    // The refresh is conditional on staleness (claimedAt < cutoff).
    const where = vi.mocked(db.crmEmailSendClaim.updateMany).mock.calls[0]![0]!.where as Record<string, unknown>;
    expect(where).toMatchObject({ organizationId: "org-1", dedupHash: "hash-a" });
    expect((where.claimedAt as { lt: Date }).lt).toBeInstanceOf(Date);
  });

  it("a prune failure is logged and never blocks the claim", async () => {
    vi.mocked(db.crmEmailSendClaim.deleteMany).mockRejectedValue(new Error("pooler blip"));
    vi.mocked(db.crmEmailSendClaim.create).mockResolvedValue({ id: "c-2" } as never);
    expect(await claimCrmEmailSend("org-1", "hash-b")).toBe(true);
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "crm-email-dedup:prune-failed" }),
    );
  });

  it("a non-P2002 create error propagates (not swallowed as a duplicate)", async () => {
    vi.mocked(db.crmEmailSendClaim.create).mockRejectedValue(new Error("connection reset"));
    await expect(claimCrmEmailSend("org-1", "hash-c")).rejects.toThrow("connection reset");
  });
});
