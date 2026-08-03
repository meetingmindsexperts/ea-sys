/**
 * Certificates domain sweep (Domain #13): the flat policies from
 * prisma/rls/certificate.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, across CertificateTemplate +
 * IssuedCertificate + CertificateIssueRun + CertificateSerialCounter (1-hop) +
 * CertificateIssueRunItem (2-hop via CertificateIssueRun).
 *
 * Domain-specific proofs beyond the standard set:
 *   - CertificateTemplate has NO per-org unique field, so BOTH orgs hold a
 *     template on the SAME name → an unscoped `where:{ name }` returns only the
 *     caller's row (the MediaFile shared-value shape).
 *   - IssuedCertificate.serial is GLOBALLY @unique (no shared collision), so
 *     scoping is proven by per-lane count + a cross-tenant by-id / by-serial miss
 *     (the Invoice shape).
 *   - CertificateIssueRunItem is 2-hop (runId → CertificateIssueRun → Event),
 *     proven lane-scoped even when addressed by the parent runId.
 *   - CertificateSerialCounter is a composite-PK (@@id([eventId, type])) FLAT-
 *     column counter — its cross-tenant row is invisible under the other org's
 *     store, so the atomic upsert can't spuriously collide (the
 *     RegistrationSerialCounter payoff).
 *
 * No defence-#1-in-isolation assertion: the cert mutations bind the org via a
 * prior org-scoped event load / the session-org runWithTenant wrap (the
 * Session/CRM precedent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  EVENT_B_SHARED_ID,
  REG_A_ID,
  CERT_TEMPLATE_A_ID,
  CERT_TEMPLATE_B_ID,
  ISSUED_CERT_A_ID,
  ISSUED_CERT_B_ID,
  CERT_B_SERIAL,
  CERT_RUN_A_ID,
  CERT_RUN_B_ID,
  CERT_RUN_ITEM_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Certificate RLS (prisma/rls/certificate.sql) via the SET LOCAL extension", () => {
  it("shared template name is lane-scoped: unscoped by-name returns only the caller's row", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.certificateTemplate.findMany({
        where: { name: "Attendance Certificate" },
        select: { id: true, organizationId: true },
      }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.certificateTemplate.findMany({
        where: { name: "Attendance Certificate" },
        select: { id: true },
      }),
    );
    expect(a.map((r) => r.id)).toEqual([CERT_TEMPLATE_A_ID]);
    expect(a.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(b.map((r) => r.id)).toEqual([CERT_TEMPLATE_B_ID]);
  });

  it("IssuedCertificate: per-lane count + cross-tenant by-id AND by-serial miss (global-unique serial)", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.issuedCertificate.count())).toBe(1);
    const byId = await runWithTenant(ORG_A_ID, () =>
      db.issuedCertificate.findUnique({ where: { id: ISSUED_CERT_B_ID }, select: { id: true } }),
    );
    expect(byId).toBeNull();
    // B's serial is globally unique — invisible under A's store despite no
    // org filter in the where (the Invoice-number cross-tenant-miss shape).
    const bySerial = await runWithTenant(ORG_A_ID, () =>
      db.issuedCertificate.findUnique({ where: { serial: CERT_B_SERIAL }, select: { id: true } }),
    );
    expect(bySerial).toBeNull();
  });

  it("CertificateIssueRun is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.certificateIssueRun.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.certificateIssueRun.findUnique({ where: { id: CERT_RUN_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("CertificateIssueRunItem (2-hop) is lane-scoped, incl. addressed by the parent runId", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.certificateIssueRunItem.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.certificateIssueRunItem.findUnique({ where: { id: CERT_RUN_ITEM_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    // The worker read shape: draining B's run's items under A's store → empty.
    const byForeignRun = await runWithTenant(ORG_A_ID, () =>
      db.certificateIssueRunItem.findMany({ where: { runId: CERT_RUN_B_ID }, select: { id: true } }),
    );
    expect(byForeignRun).toHaveLength(0);
  });

  it("CertificateSerialCounter (composite-PK flat column): per-lane count + cross-tenant by-key miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.certificateSerialCounter.count())).toBe(1);
    // B's counter, addressed by its composite PK, is invisible under A's store —
    // so the atomic allocateSerial upsert can't spuriously collide against a
    // policy-invisible row (the RegistrationSerialCounter flat-column payoff).
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.certificateSerialCounter.findUnique({
        where: { eventId_type: { eventId: EVENT_B_SHARED_ID, type: "ATTENDANCE" } },
        select: { lastSerial: true },
      }),
    );
    expect(leaked).toBeNull();
  });

  it("serial counter UPSERT (the flat-column payoff, review M4): own-org increment works; a cross-tenant upsert is REJECTED, not misrouted", async () => {
    // Own org — the exact allocateSerial shape (create stamps org, update
    // increments + conditionally re-stamps) increments the visible row.
    const own = await runWithTenant(ORG_A_ID, () =>
      db.certificateSerialCounter.upsert({
        where: { eventId_type: { eventId: EVENT_A_SHARED_ID, type: "ATTENDANCE" } },
        create: { eventId: EVENT_A_SHARED_ID, type: "ATTENDANCE", lastSerial: 1, organizationId: ORG_A_ID },
        update: { lastSerial: { increment: 1 }, organizationId: ORG_A_ID },
        select: { lastSerial: true },
      }),
    );
    expect(own.lastSerial).toBeGreaterThan(1);

    // Cross-tenant: B's counter is invisible under A → the upsert takes the
    // INSERT path into an existing composite PK / or the row fails the policy.
    // Either way it must REJECT — never silently increment B's counter.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.certificateSerialCounter.upsert({
          where: { eventId_type: { eventId: EVENT_B_SHARED_ID, type: "ATTENDANCE" } },
          create: { eventId: EVENT_B_SHARED_ID, type: "ATTENDANCE", lastSerial: 99, organizationId: ORG_A_ID },
          update: { lastSerial: { increment: 1 } },
        }),
      ),
    ).rejects.toBeTruthy();

    // ...and B's counter is untouched (owner view — bypasses the policy).
    const owner = ownerClient();
    try {
      const row = await owner.certificateSerialCounter.findUnique({
        where: { eventId_type: { eventId: EVENT_B_SHARED_ID, type: "ATTENDANCE" } },
        select: { lastSerial: true, organizationId: true },
      });
      expect(row?.lastSerial).toBe(1);
      expect(row?.organizationId).toBe(ORG_B_ID);
    } finally {
      await owner.$disconnect();
    }
  });

  it("fail-closed: flag on but NO tenant store → zero rows on all 5 tables", async () => {
    expect(await db.certificateTemplate.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.issuedCertificate.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.certificateIssueRun.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.certificateIssueRunItem.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.certificateSerialCounter.findMany({ select: { lastSerial: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a CertificateTemplate for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.certificateTemplate.create({
          data: {
            id: "tenancy-ctpl-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            name: "Smuggled Template",
            category: "ATTENDANCE",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN IssuedCertificate to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.issuedCertificate.update({
          where: { id: ISSUED_CERT_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's CertificateIssueRun cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.certificateIssueRun.delete({ where: { id: CERT_RUN_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation (review L3): the compound-where template delete alone blocks cross-tenant — owner client bypasses the policy", async () => {
    // The route/MCP delete shape is { id, organizationId: <caller org> }. Run
    // it as the OWNER (RLS bypassed), so ONLY the compound-where is doing the
    // work — a wrong-org id must P2025, never delete.
    const owner = ownerClient();
    try {
      await expect(
        owner.certificateTemplate.delete({
          where: { id: CERT_TEMPLATE_B_ID, organizationId: ORG_A_ID },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
      const still = await owner.certificateTemplate.findUnique({
        where: { id: CERT_TEMPLATE_B_ID },
        select: { id: true },
      });
      expect(still?.id).toBe(CERT_TEMPLATE_B_ID);
    } finally {
      await owner.$disconnect();
    }
  });

  it("scoped IssuedCertificate by-registration read returns the tenant's own cert", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.issuedCertificate.findMany({ where: { registrationId: REG_A_ID }, select: { id: true } }),
    );
    expect(rows.map((r) => r.id)).toEqual([ISSUED_CERT_A_ID]);
  });

  it("scoped CertificateIssueRun read for the tenant's own run resolves", async () => {
    const run = await runWithTenant(ORG_A_ID, () =>
      db.certificateIssueRun.findUnique({ where: { id: CERT_RUN_A_ID }, select: { organizationId: true } }),
    );
    expect(run?.organizationId).toBe(ORG_A_ID);
  });
});

function ownerClient(): PrismaClient {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL must be set — owner-view assertions require the OWNER connection");
  return new PrismaClient({ datasourceUrl: url });
}
