/**
 * Invoice sweep (Phase 2, domain pass #4 — the second finance sweep): the flat
 * per-domain RLS policy from prisma/rls/invoice.sql — the SAME file the future
 * platform bootstrap applies — enforced end-to-end through the ALS store → SET
 * LOCAL extension → pgbouncer, as the non-owner app_user.
 *
 * Like BillingAccount (and unlike MediaFile's policy-only pass) Invoice got the
 * full recipe: the service compound-where's its by-id mutations + uses
 * tenantTransaction (C1); the staff routes + MCP executors wrap in
 * runWithTenant (C2a); the cross-domain invoice writers wrap their invoice
 * block (C2b). So this proves BOTH layers independently:
 *   - defence #1 (compound-where) blocks a cross-org write even with RLS out of
 *     the picture (owner connection bypasses the non-FORCE policy);
 *   - defence #2 (RLS) blocks a deliberately-unscoped read.
 *
 * `invoiceNumber` is GLOBALLY unique (no per-org shared-value collision like
 * Contact email / BillingAccount name), so scoping is proven by each lane
 * seeing only ITS invoices + an unscoped by-invoiceNumber / by-id lookup of B's
 * invoice missing under A's store.
 *
 * Transport correctness (50-lane pooler interleave) + the boot tripwire are
 * model-independent and already pinned on Event / Contact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_B_ONLY_ID,
  REG_B_ID,
  INVOICE_A_ID,
  INVOICE_B_ONLY_ID,
  INVOICE_B_ONLY_NUMBER,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Invoice RLS (prisma/rls/invoice.sql) via the SET LOCAL extension", () => {
  it("scoped findMany returns ONLY the tenant's own invoices", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.invoice.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    // A has exactly one invoice; B's two are invisible.
    expect(rows.map((r) => r.id)).toEqual([INVOICE_A_ID]);
  });

  it("each lane sees only ITS invoice count (A=1, B=2)", async () => {
    const a = await runWithTenant(ORG_A_ID, () => db.invoice.count());
    const b = await runWithTenant(ORG_B_ID, () => db.invoice.count());
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("a DELIBERATELY-unscoped invoiceNumber query cannot read another tenant's invoice (defence #2)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.invoice.findUnique({
        where: { invoiceNumber: INVOICE_B_ONLY_NUMBER },
        select: { id: true },
      }),
    );
    expect(leaked).toBeNull();
  });

  it("cross-tenant miss by id: B's invoice is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.invoice.findUnique({ where: { id: INVOICE_B_ONLY_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    const rows = await db.invoice.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("WITH CHECK rejects creating an invoice for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.invoice.create({
          data: {
            id: "tenancy-inv-smuggled",
            organizationId: ORG_B_ID, // tenant A writing into B
            eventId: EVENT_B_ONLY_ID,
            registrationId: REG_B_ID,
            type: "INVOICE",
            invoiceNumber: "TEN-SMUGGLED-001",
            sequenceNumber: 99,
            subtotal: 10,
            total: 10,
            currency: "USD",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN invoice to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.invoice.update({
          where: { id: INVOICE_A_ID, organizationId: ORG_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's invoice cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.invoice.delete({ where: { id: INVOICE_B_ONLY_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation: compound-where blocks a cross-org update even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy, so this exercises ONLY the
    // C1 compound-where layer — the shape transitionInvoiceStatus + the
    // createPaidInvoice/createCreditNote promote/flip now use. Guard:
    // TENANCY_DIRECT_URL must be the OWNER connection.
    if (!process.env.TENANCY_DIRECT_URL) {
      throw new Error("TENANCY_DIRECT_URL must be set — this test requires the OWNER connection");
    }
    const owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
    try {
      await expect(
        owner.invoice.update({
          where: { id: INVOICE_B_ONLY_ID, organizationId: ORG_A_ID },
          data: { status: "CANCELLED" },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
      // ...and the row is untouched.
      const row = await owner.invoice.findUnique({
        where: { id: INVOICE_B_ONLY_ID },
        select: { status: true },
      });
      expect(row?.status).toBe("DRAFT");
    } finally {
      await owner.$disconnect();
    }
  });
});
