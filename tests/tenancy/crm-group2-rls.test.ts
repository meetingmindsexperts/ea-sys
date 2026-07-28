/**
 * CRM full-domain sweep — POLICY LAYER, Group 2 (the deal graph).
 *
 * CrmDeal + its children (DealContact, DealProduct, DealDocument, EmailThread,
 * EmailMessage) get the SAME flat per-domain RLS policy (byte-shape copies of
 * crmcontact.sql), enforced through the ALS store → SET LOCAL extension →
 * pgbouncer as the non-owner app_user.
 *
 * Every model carries a direct organizationId (two junctions — DealContact,
 * DealProduct — carry it NULLABLE for blue-green, always written by the app).
 * Isolation is proven per model: (1) scoped findMany returns ONLY the tenant's
 * rows, (2) an unscoped by-id lookup of B's row misses under A's store (USING),
 * (3) fail-closed to zero rows with the flag on but NO tenant store,
 * (4) a cross-tenant DELETE misses (USING) → P2025, (5) WITH CHECK blocks
 * org-re-homing an own row.
 *
 * WITH CHECK is proven via the RE-HOME UPDATE path rather than a cross-org
 * create-smuggle: these models have RLS-gated REQUIRED parents (a deal / thread),
 * so a create under tenant A referencing a B-owned parent could fail on the FK
 * lookup rather than on the WITH CHECK, muddying the assertion. The re-home
 * updates an OWN (A-visible) row's org to B — the parents are unchanged and
 * visible, so the ONLY rejection reason is WITH CHECK. INSERT-side WITH CHECK is
 * already proven by Group 1's flat (byte-identical) policy.
 *
 * Policy-only pass: NO defence-#1-in-isolation assertion (C1 compound-where is
 * the follow-on app-sweep).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  CRM_DEAL_A_ID,
  CRM_DEAL_B_ID,
  CRM_DC_A_ID,
  CRM_DC_B_ID,
  CRM_DP_A_ID,
  CRM_DP_B_ID,
  CRM_DOC_A_ID,
  CRM_DOC_B_ID,
  CRM_THREAD_A_ID,
  CRM_THREAD_B_ID,
  CRM_MSG_A_ID,
  CRM_MSG_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

interface CrmRlsCase {
  name: string;
  scopedRead: () => Promise<{ organizationId: string | null }[]>;
  findB: () => Promise<unknown | null>;
  failClosed: () => Promise<unknown[]>;
  deleteB: () => Promise<unknown>;
  /** Update an OWN A row to org B — must throw (WITH CHECK). */
  reHome: () => Promise<unknown>;
}

const CASES: CrmRlsCase[] = [
  {
    name: "CrmDeal",
    scopedRead: () => db.crmDeal.findMany({ select: { organizationId: true } }),
    findB: () => db.crmDeal.findUnique({ where: { id: CRM_DEAL_B_ID }, select: { id: true } }),
    failClosed: () => db.crmDeal.findMany({ select: { id: true } }),
    deleteB: () => db.crmDeal.delete({ where: { id: CRM_DEAL_B_ID } }),
    reHome: () => db.crmDeal.update({ where: { id: CRM_DEAL_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmDealContact",
    scopedRead: () => db.crmDealContact.findMany({ select: { organizationId: true } }),
    findB: () => db.crmDealContact.findUnique({ where: { id: CRM_DC_B_ID }, select: { id: true } }),
    failClosed: () => db.crmDealContact.findMany({ select: { id: true } }),
    deleteB: () => db.crmDealContact.delete({ where: { id: CRM_DC_B_ID } }),
    reHome: () => db.crmDealContact.update({ where: { id: CRM_DC_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmDealProduct",
    scopedRead: () => db.crmDealProduct.findMany({ select: { organizationId: true } }),
    findB: () => db.crmDealProduct.findUnique({ where: { id: CRM_DP_B_ID }, select: { id: true } }),
    failClosed: () => db.crmDealProduct.findMany({ select: { id: true } }),
    deleteB: () => db.crmDealProduct.delete({ where: { id: CRM_DP_B_ID } }),
    reHome: () => db.crmDealProduct.update({ where: { id: CRM_DP_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmDealDocument",
    scopedRead: () => db.crmDealDocument.findMany({ select: { organizationId: true } }),
    findB: () => db.crmDealDocument.findUnique({ where: { id: CRM_DOC_B_ID }, select: { id: true } }),
    failClosed: () => db.crmDealDocument.findMany({ select: { id: true } }),
    deleteB: () => db.crmDealDocument.delete({ where: { id: CRM_DOC_B_ID } }),
    reHome: () => db.crmDealDocument.update({ where: { id: CRM_DOC_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmEmailThread",
    scopedRead: () => db.crmEmailThread.findMany({ select: { organizationId: true } }),
    findB: () => db.crmEmailThread.findUnique({ where: { id: CRM_THREAD_B_ID }, select: { id: true } }),
    failClosed: () => db.crmEmailThread.findMany({ select: { id: true } }),
    deleteB: () => db.crmEmailThread.delete({ where: { id: CRM_THREAD_B_ID } }),
    reHome: () => db.crmEmailThread.update({ where: { id: CRM_THREAD_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmEmailMessage",
    scopedRead: () => db.crmEmailMessage.findMany({ select: { organizationId: true } }),
    findB: () => db.crmEmailMessage.findUnique({ where: { id: CRM_MSG_B_ID }, select: { id: true } }),
    failClosed: () => db.crmEmailMessage.findMany({ select: { id: true } }),
    deleteB: () => db.crmEmailMessage.delete({ where: { id: CRM_MSG_B_ID } }),
    reHome: () => db.crmEmailMessage.update({ where: { id: CRM_MSG_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
];

describe("CRM Group-2 (deal graph) RLS via the SET LOCAL extension", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it("scoped findMany returns ONLY the tenant's own rows", async () => {
        const rows = await runWithTenant(ORG_A_ID, c.scopedRead);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
      });

      it("cross-tenant miss by id: B's row is invisible under A's store (USING)", async () => {
        const leaked = await runWithTenant(ORG_A_ID, c.findB);
        expect(leaked).toBeNull();
      });

      it("fail-closed: flag on but NO tenant store → zero rows", async () => {
        expect(await c.failClosed()).toHaveLength(0);
      });

      it("cross-tenant DELETE misses under A's store (USING) → P2025", async () => {
        await expect(runWithTenant(ORG_A_ID, c.deleteB)).rejects.toMatchObject({ code: "P2025" });
      });

      it("org-re-homing UPDATE is blocked: cannot move an own row to another org (WITH CHECK)", async () => {
        await expect(runWithTenant(ORG_A_ID, c.reHome)).rejects.toThrow(/row-level security|denied/i);
      });
    });
  }
});
