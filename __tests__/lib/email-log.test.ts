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
      create: vi.fn().mockResolvedValue({}),
      // Domain #18: NULL-org rows write via createMany (plain INSERT — no
      // RETURNING, which the asymmetric RLS policy would reject).
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    event: {
      // Domain #18: logEmail resolves a missing org 1-hop from a tagged event.
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

const { mockApiLogger } = vi.hoisted(() => ({
  mockApiLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { getEmailLogsFor, logEmail } from "@/lib/email-log";
// Real module (not mocked): lets the tests observe the ACTUAL tenant lane the
// insert runs on — pinning the wrap's ORG ARGUMENT, not just the stamped
// column (review Aug 3: the gate catches a deleted wrap, not a wrong org).
import { getTenantOrgId, runWithTenant } from "@/lib/tenant-context";

/** Tenant lane observed at the moment of each emailLog write. */
const lanesAtWrite: (string | null)[] = [];

beforeEach(() => {
  mockDb.emailLog.findMany.mockClear();
  mockDb.emailLog.create.mockClear();
  mockDb.emailLog.createMany.mockClear();
  mockDb.event.findUnique.mockClear();
  mockDb.event.findUnique.mockResolvedValue(null);
  mockApiLogger.warn.mockClear();
  lanesAtWrite.length = 0;
  mockDb.emailLog.create.mockImplementation(async () => {
    lanesAtWrite.push(getTenantOrgId());
    return {};
  });
  mockDb.emailLog.createMany.mockImplementation(async () => {
    lanesAtWrite.push(getTenantOrgId());
    return { count: 1 };
  });
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

describe("logEmail — htmlBody audit copy (store-by-default since July 16, 2026)", () => {
  const BASE = {
    to: "jane@x.com",
    subject: "Your certificates",
    provider: "ses",
    status: "SENT" as const,
    htmlBody: "<html><body>final rendered</body></html>",
  };

  it("persists htmlBody when context.storeBody is explicitly set", async () => {
    await logEmail({ ...BASE, context: { organizationId: "org-1", storeBody: true } });
    expect(mockDb.emailLog.create.mock.calls[0][0].data.htmlBody).toBe(BASE.htmlBody);
  });

  it("persists htmlBody by DEFAULT (storeBody unset) — every send stores its audit copy", async () => {
    await logEmail({ ...BASE, context: { organizationId: "org-1" } });
    expect(mockDb.emailLog.create.mock.calls[0][0].data.htmlBody).toBe(BASE.htmlBody);
  });

  it("persists htmlBody even with NO logContext at all (null-org → createMany path)", async () => {
    await logEmail({ ...BASE });
    expect(mockDb.emailLog.createMany.mock.calls[0][0].data[0].htmlBody).toBe(BASE.htmlBody);
  });

  it("drops htmlBody only on the explicit opt-out (storeBody: false)", async () => {
    await logEmail({ ...BASE, context: { organizationId: "org-1", storeBody: false } });
    expect(mockDb.emailLog.create.mock.calls[0][0].data.htmlBody).toBeNull();
  });

  it("maps rows to a hasBody flag and never returns the raw htmlBody in lists", async () => {
    mockDb.emailLog.findMany.mockResolvedValue([
      { id: "e1", htmlBody: "<html/>", subject: "A" },
      { id: "e2", htmlBody: null, subject: "B" },
    ]);
    const rows = await getEmailLogsFor("REGISTRATION", "reg-1", "org-1");
    expect(rows).toEqual([
      { id: "e1", subject: "A", hasBody: true },
      { id: "e2", subject: "B", hasBody: false },
    ]);
  });
});

describe("logEmail — attachmentNames (Aug 3, 2026)", () => {
  const BASE = {
    to: "jane@x.com",
    subject: "Payment Confirmation",
    provider: "ses",
    status: "SENT" as const,
  };

  it("persists the attachment filenames (the payment invoice+receipt case)", async () => {
    await logEmail({
      ...BASE,
      attachmentNames: ["INV-2026-001.pdf", "REC-2026-001.pdf"],
      context: { organizationId: "org-1" },
    });
    expect(mockDb.emailLog.create.mock.calls[0][0].data.attachmentNames).toEqual([
      "INV-2026-001.pdf",
      "REC-2026-001.pdf",
    ]);
  });

  it("defaults to [] when the send carried no attachments (null-org → createMany path)", async () => {
    await logEmail({ ...BASE });
    expect(mockDb.emailLog.createMany.mock.calls[0][0].data[0].attachmentNames).toEqual([]);
  });

  it("getEmailLogsFor selects attachmentNames for the history surfaces", async () => {
    await getEmailLogsFor("REGISTRATION", "reg-1", "org-1");
    expect(mockDb.emailLog.findMany.mock.calls[0][0].select.attachmentNames).toBe(true);
  });
});

describe("logEmail — org resolution + write-path routing (tenancy Domain #18)", () => {
  const BASE = {
    to: "jane@x.com",
    subject: "Confirmation",
    provider: "ses",
    status: "SENT" as const,
  };

  it("explicit context org wins: stamped + written via create ON that org's lane (no event lookup)", async () => {
    await logEmail({ ...BASE, context: { organizationId: "org-1", eventId: "evt-1" } });
    expect(mockDb.event.findUnique).not.toHaveBeenCalled();
    expect(mockDb.emailLog.create.mock.calls[0][0].data.organizationId).toBe("org-1");
    expect(lanesAtWrite).toEqual(["org-1"]);
    expect(mockDb.emailLog.createMany).not.toHaveBeenCalled();
  });

  it("missing org + tagged event: resolves the org 1-hop from the Event, stamps it, and rides ITS lane", async () => {
    // The historical class this closes: transactional senders threading
    // eventId but not organizationId minted NULL-org rows for tenant emails.
    mockDb.event.findUnique.mockResolvedValue({ organizationId: "org-evt" });
    await logEmail({ ...BASE, context: { eventId: "evt-1", entityType: "REGISTRATION" } });
    expect(mockDb.event.findUnique.mock.calls[0][0].where).toEqual({ id: "evt-1" });
    expect(mockDb.emailLog.create.mock.calls[0][0].data.organizationId).toBe("org-evt");
    expect(lanesAtWrite).toEqual(["org-evt"]);
    expect(mockDb.emailLog.createMany).not.toHaveBeenCalled();
  });

  it("no org, no event, but an AMBIENT tenant lane: stamps the ambient org (never a null row on a tenant's behalf)", async () => {
    await runWithTenant("org-ambient", () =>
      logEmail({ ...BASE, context: { entityType: "REGISTRATION", entityId: "reg-1" } }),
    );
    expect(mockDb.emailLog.create.mock.calls[0][0].data.organizationId).toBe("org-ambient");
    expect(lanesAtWrite).toEqual(["org-ambient"]);
    expect(mockDb.emailLog.createMany).not.toHaveBeenCalled();
  });

  it("genuinely org-less (no org, no event, no lane): NULL-org row via createMany, never create", async () => {
    await logEmail({ ...BASE, context: { entityType: "USER", entityId: "user-1" } });
    expect(mockDb.emailLog.create).not.toHaveBeenCalled();
    const row = mockDb.emailLog.createMany.mock.calls[0][0].data[0];
    expect(row.organizationId).toBeNull();
    expect(row.entityType).toBe("USER");
    // createMany (plain INSERT) is load-bearing: Prisma create() emits
    // INSERT..RETURNING, which the platform's strict USING would reject for a
    // row no lane can read.
    expect(lanesAtWrite).toEqual([null]);
  });

  it("never throws: a failed event lookup degrades to the null-org write (row kept, un-attributed)", async () => {
    mockDb.event.findUnique.mockRejectedValue(new Error("pool blip"));
    await expect(
      logEmail({ ...BASE, context: { eventId: "evt-1" } }),
    ).resolves.toBeUndefined();
    // The row is NOT lost — it lands via the null-org path.
    expect(mockDb.emailLog.createMany.mock.calls[0][0].data[0].organizationId).toBeNull();
  });

  it("event-not-found (stale/deleted eventId) is a LOGGED failure path, then falls back", async () => {
    mockDb.event.findUnique.mockResolvedValue(null);
    await logEmail({ ...BASE, context: { eventId: "evt-gone", entityType: "REGISTRATION" } });
    // Row kept (null-org path) — and both warn paths fired: event-not-found
    // + the unattributed-tenant-row alarm (a REGISTRATION row landing NULL-org
    // is lost attribution, never the intended auth-email class).
    expect(mockDb.emailLog.createMany.mock.calls[0][0].data[0].organizationId).toBeNull();
    const warns = mockApiLogger.warn.mock.calls.map((c) => c[0]?.msg);
    expect(warns).toContain("email-log:event-not-found; falling back to ambient org");
    expect(warns).toContain("email-log:unattributed-tenant-row");
  });
});
