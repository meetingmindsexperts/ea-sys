/**
 * Unit tests for src/lib/email-log.ts — focuses on the getEmailLogsFor
 * read filter, which has historically excluded null-organizationId
 * rows even when the entity belonged to the caller's org (the
 * "8-caller missing-organizationId bug" the relaxed filter fixes).
 *
 * The filter behavior is the load-bearing contract for the
 * EmailLogCard on the registration / speaker / contact detail
 * sheets. If this breaks, organizers stop seeing transactional
 * emails (registration confirmation, refund confirmation, abstract
 * status change, cert delivery, password reset) in the activity
 * log without any system-level signal that something is wrong.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    emailLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getEmailLogsFor } from "@/lib/email-log";

beforeEach(() => {
  mockDb.emailLog.findMany.mockClear();
});

describe("getEmailLogsFor — relaxed organizationId filter", () => {
  it("includes BOTH org-matching AND null-org rows when organizationId provided", async () => {
    await getEmailLogsFor("REGISTRATION", "reg-1", "org-A");
    const args = mockDb.emailLog.findMany.mock.calls[0][0];
    expect(args.where.entityType).toBe("REGISTRATION");
    expect(args.where.entityId).toBe("reg-1");
    // The OR clause is the bug fix — without it, null-org rows
    // written by sendRegistrationConfirmation / payment-confirmation /
    // refund / abstract-status / cert-delivery / password-reset would
    // be silently filtered.
    expect(args.where.OR).toEqual([
      { organizationId: "org-A" },
      { organizationId: null },
    ]);
  });

  it("OMITS the org filter entirely when organizationId is missing", async () => {
    await getEmailLogsFor("REGISTRATION", "reg-1");
    const args = mockDb.emailLog.findMany.mock.calls[0][0];
    expect(args.where.organizationId).toBeUndefined();
    expect(args.where.OR).toBeUndefined();
  });

  it("OMITS the org filter when organizationId is null", async () => {
    await getEmailLogsFor("REGISTRATION", "reg-1", null);
    const args = mockDb.emailLog.findMany.mock.calls[0][0];
    expect(args.where.organizationId).toBeUndefined();
    expect(args.where.OR).toBeUndefined();
  });

  it("orders newest-first and caps at 50", async () => {
    await getEmailLogsFor("SPEAKER", "spk-1", "org-A");
    const args = mockDb.emailLog.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.take).toBe(50);
  });

  it("returns triggeredBy person details for audit attribution", async () => {
    await getEmailLogsFor("REGISTRATION", "reg-1", "org-A");
    const args = mockDb.emailLog.findMany.mock.calls[0][0];
    // Used by the EmailLogCard to render "Sent by Krishna Pallapolu".
    expect(args.select.triggeredBy).toEqual({
      select: { firstName: true, lastName: true, email: true },
    });
  });

  it("supports every entityType the bug affects", async () => {
    for (const type of ["REGISTRATION", "SPEAKER", "CONTACT", "USER", "OTHER"] as const) {
      await getEmailLogsFor(type, `id-${type}`, "org-A");
    }
    expect(mockDb.emailLog.findMany).toHaveBeenCalledTimes(5);
  });
});
