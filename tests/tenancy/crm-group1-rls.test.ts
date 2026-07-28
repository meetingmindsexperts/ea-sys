/**
 * CRM full-domain sweep — POLICY LAYER, Group 1 (July 2026).
 *
 * The 10 simple direct-org Crm* models get the SAME flat per-domain RLS policy
 * the Contacts pilot ratified (prisma/rls/crm<model>.sql — byte-shape copies of
 * crmcontact.sql), enforced end-to-end through the ALS store → SET LOCAL
 * extension → pgbouncer as the non-owner app_user.
 *
 * Every model here carries a DIRECT organizationId, so isolation is proven
 * uniformly per model: (1) scoped findMany returns ONLY the tenant's rows,
 * (2) an unscoped by-id lookup of B's row misses under A's store (USING),
 * (3) fail-closed to zero rows with the flag on but NO tenant store,
 * (4) WITH CHECK rejects creating a row for another tenant,
 * (5) WITH CHECK blocks org-re-homing an own row, (6) a cross-tenant DELETE
 * misses (USING) → P2025.
 *
 * Policy-only pass (like MediaFile's first pass): NO defence-#1-in-isolation
 * assertion — the CRM services org-bind via lookups but their by-id mutations
 * are not yet compound-where'd; that C1 wiring is the follow-on app-sweep.
 *
 * CrmQuoteCounter's PRIMARY KEY *is* organizationId, so it cannot exercise the
 * WITH CHECK create-smuggle / re-home paths (both would collide on the PK, not
 * on RLS) — it runs the read/delete-isolation subset. Its policy file is a
 * byte-shape copy of the others, so WITH CHECK is structurally identical to the
 * 9 models that DO prove it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  UPLOADER_B_ID,
  CRM_CO_A_ID,
  CRM_CO_B_ID,
  CRM_PROD_A_ID,
  CRM_PROD_B_ID,
  CRM_STAGE_A_ID,
  CRM_STAGE_B_ID,
  CRM_TPL_A_ID,
  CRM_TPL_B_ID,
  CRM_CLAIM_B_ID,
  CRM_NOTIF_A_ID,
  CRM_NOTIF_B_ID,
  CRM_ACT_A_ID,
  CRM_ACT_B_ID,
  CRM_TASK_A_ID,
  CRM_TASK_B_ID,
  CRM_NOTE_A_ID,
  CRM_NOTE_B_ID,
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
  /** runWithTenant(A) findMany selecting organizationId — must be all A's. */
  scopedRead: () => Promise<{ organizationId: string }[]>;
  /** runWithTenant(A) lookup of B's row by id/PK — must be null (USING). */
  findB: () => Promise<unknown | null>;
  /** No tenant store — must return [] (fail-closed). */
  failClosed: () => Promise<unknown[]>;
  /** runWithTenant(A) delete of B's row — must P2025 (USING). */
  deleteB: () => Promise<unknown>;
  /** runWithTenant(A) create of a row for org B — must throw (WITH CHECK). */
  smuggle?: () => Promise<unknown>;
  /** runWithTenant(A) update of an own row to org B — must throw (WITH CHECK). */
  reHome?: () => Promise<unknown>;
}

const CASES: CrmRlsCase[] = [
  {
    name: "CrmCompany",
    scopedRead: () => db.crmCompany.findMany({ select: { organizationId: true } }),
    findB: () => db.crmCompany.findUnique({ where: { id: CRM_CO_B_ID }, select: { id: true } }),
    failClosed: () => db.crmCompany.findMany({ select: { id: true } }),
    deleteB: () => db.crmCompany.delete({ where: { id: CRM_CO_B_ID } }),
    smuggle: () =>
      db.crmCompany.create({
        data: { id: "tenancy-smuggle-co", organizationId: ORG_B_ID, name: "Smuggle", nameKey: "smuggle-co" },
      }),
    reHome: () => db.crmCompany.update({ where: { id: CRM_CO_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmProduct",
    scopedRead: () => db.crmProduct.findMany({ select: { organizationId: true } }),
    findB: () => db.crmProduct.findUnique({ where: { id: CRM_PROD_B_ID }, select: { id: true } }),
    failClosed: () => db.crmProduct.findMany({ select: { id: true } }),
    deleteB: () => db.crmProduct.delete({ where: { id: CRM_PROD_B_ID } }),
    smuggle: () =>
      db.crmProduct.create({
        data: { id: "tenancy-smuggle-prod", organizationId: ORG_B_ID, name: "Smuggle", category: "X", sku: "SMUGGLE-SKU" },
      }),
    reHome: () => db.crmProduct.update({ where: { id: CRM_PROD_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmPipelineStage",
    scopedRead: () => db.crmPipelineStage.findMany({ select: { organizationId: true } }),
    findB: () => db.crmPipelineStage.findUnique({ where: { id: CRM_STAGE_B_ID }, select: { id: true } }),
    failClosed: () => db.crmPipelineStage.findMany({ select: { id: true } }),
    deleteB: () => db.crmPipelineStage.delete({ where: { id: CRM_STAGE_B_ID } }),
    smuggle: () =>
      db.crmPipelineStage.create({
        data: { id: "tenancy-smuggle-stage", organizationId: ORG_B_ID, name: "Smuggle Stage", sortOrder: 9 },
      }),
    reHome: () => db.crmPipelineStage.update({ where: { id: CRM_STAGE_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmEmailTemplate",
    scopedRead: () => db.crmEmailTemplate.findMany({ select: { organizationId: true } }),
    findB: () => db.crmEmailTemplate.findUnique({ where: { id: CRM_TPL_B_ID }, select: { id: true } }),
    failClosed: () => db.crmEmailTemplate.findMany({ select: { id: true } }),
    deleteB: () => db.crmEmailTemplate.delete({ where: { id: CRM_TPL_B_ID } }),
    smuggle: () =>
      db.crmEmailTemplate.create({
        data: { id: "tenancy-smuggle-tpl", organizationId: ORG_B_ID, name: "Smuggle Template", subject: "s", body: "b" },
      }),
    reHome: () => db.crmEmailTemplate.update({ where: { id: CRM_TPL_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    // PK is organizationId — no create-smuggle / re-home (both collide on the PK,
    // not on RLS). Read + delete isolation still fully exercised.
    name: "CrmQuoteCounter",
    scopedRead: () => db.crmQuoteCounter.findMany({ select: { organizationId: true } }),
    findB: () => db.crmQuoteCounter.findUnique({ where: { organizationId: ORG_B_ID }, select: { organizationId: true } }),
    failClosed: () => db.crmQuoteCounter.findMany({ select: { organizationId: true } }),
    deleteB: () => db.crmQuoteCounter.delete({ where: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmEmailSendClaim",
    scopedRead: () => db.crmEmailSendClaim.findMany({ select: { organizationId: true } }),
    findB: () => db.crmEmailSendClaim.findUnique({ where: { id: CRM_CLAIM_B_ID }, select: { id: true } }),
    failClosed: () => db.crmEmailSendClaim.findMany({ select: { id: true } }),
    deleteB: () => db.crmEmailSendClaim.delete({ where: { id: CRM_CLAIM_B_ID } }),
    smuggle: () =>
      db.crmEmailSendClaim.create({
        data: { id: "tenancy-smuggle-claim", organizationId: ORG_B_ID, dedupHash: "smuggle-dedup" },
      }),
    // No non-PK id to re-home cleanly beyond org — org move covered by the smuggle create.
  },
  {
    name: "CrmNotification",
    scopedRead: () => db.crmNotification.findMany({ select: { organizationId: true } }),
    findB: () => db.crmNotification.findUnique({ where: { id: CRM_NOTIF_B_ID }, select: { id: true } }),
    failClosed: () => db.crmNotification.findMany({ select: { id: true } }),
    deleteB: () => db.crmNotification.delete({ where: { id: CRM_NOTIF_B_ID } }),
    // userId must be a real user so the ONLY rejection reason is RLS (WITH CHECK).
    smuggle: () =>
      db.crmNotification.create({
        data: { id: "tenancy-smuggle-notif", organizationId: ORG_B_ID, userId: UPLOADER_B_ID, type: "X", title: "t", message: "m" },
      }),
    reHome: () => db.crmNotification.update({ where: { id: CRM_NOTIF_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmActivity",
    scopedRead: () => db.crmActivity.findMany({ select: { organizationId: true } }),
    findB: () => db.crmActivity.findUnique({ where: { id: CRM_ACT_B_ID }, select: { id: true } }),
    failClosed: () => db.crmActivity.findMany({ select: { id: true } }),
    deleteB: () => db.crmActivity.delete({ where: { id: CRM_ACT_B_ID } }),
    smuggle: () =>
      db.crmActivity.create({
        data: { id: "tenancy-smuggle-act", organizationId: ORG_B_ID, entityType: "COMPANY", entityId: "x", action: "CREATE" },
      }),
    reHome: () => db.crmActivity.update({ where: { id: CRM_ACT_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmTask",
    scopedRead: () => db.crmTask.findMany({ select: { organizationId: true } }),
    findB: () => db.crmTask.findUnique({ where: { id: CRM_TASK_B_ID }, select: { id: true } }),
    failClosed: () => db.crmTask.findMany({ select: { id: true } }),
    deleteB: () => db.crmTask.delete({ where: { id: CRM_TASK_B_ID } }),
    smuggle: () =>
      db.crmTask.create({ data: { id: "tenancy-smuggle-task", organizationId: ORG_B_ID, title: "Smuggle" } }),
    reHome: () => db.crmTask.update({ where: { id: CRM_TASK_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
  {
    name: "CrmNote",
    scopedRead: () => db.crmNote.findMany({ select: { organizationId: true } }),
    findB: () => db.crmNote.findUnique({ where: { id: CRM_NOTE_B_ID }, select: { id: true } }),
    failClosed: () => db.crmNote.findMany({ select: { id: true } }),
    deleteB: () => db.crmNote.delete({ where: { id: CRM_NOTE_B_ID } }),
    smuggle: () =>
      db.crmNote.create({ data: { id: "tenancy-smuggle-note", organizationId: ORG_B_ID, body: "Smuggle" } }),
    reHome: () => db.crmNote.update({ where: { id: CRM_NOTE_A_ID }, data: { organizationId: ORG_B_ID } }),
  },
];

describe("CRM Group-1 RLS (flat org policy) via the SET LOCAL extension", () => {
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

      if (c.smuggle) {
        it("WITH CHECK rejects creating a row for ANOTHER tenant", async () => {
          await expect(runWithTenant(ORG_A_ID, c.smuggle!)).rejects.toThrow(/row-level security|denied/i);
        });
      }

      if (c.reHome) {
        it("org-re-homing UPDATE is blocked: cannot move an own row to another org (WITH CHECK)", async () => {
          await expect(runWithTenant(ORG_A_ID, c.reHome!)).rejects.toThrow(/row-level security|denied/i);
        });
      }
    });
  }
});
