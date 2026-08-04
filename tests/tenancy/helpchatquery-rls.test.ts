/**
 * HelpChatQuery domain sweep (Domain #20 — the FINAL domain): the policy from
 * prisma/rls/helpchatquery.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - No per-org unique field; both orgs' fixture rows carry the SAME
 *     question text, so the by-question read resolving to one lane's row is
 *     what proves scoping (the MediaFile shape).
 *   - BOTH branches of the production writer (POST /api/help-chat capture)
 *     are pinned: an org-bound asker's `create()` on their lane succeeds and
 *     stays lane-visible; an org-null asker's row inserts via bare
 *     `createMany` (the WITH CHECK carve-out) while `create()` on the same
 *     shape is rejected — its INSERT..RETURNING must pass the strict USING
 *     (the Domain-#18/#19 lesson, which is WHY the writer branches).
 *   - The reader (GET /api/help-chat/queries) is deliberately NOT wrapped —
 *     operator-global (owner decision Aug 4, 2026); the fail-closed
 *     assertion here is exactly what that route would see from an app lane,
 *     documenting the privileged-lane precondition.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  HELP_QUERY_A_ID,
  HELP_QUERY_B_ID,
  HELP_QUERY_NULLORG_ID,
  SHARED_HELP_QUESTION,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("HelpChatQuery RLS (prisma/rls/helpchatquery.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED question text resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.helpChatQuery.findMany({
        where: { question: SHARED_HELP_QUESTION },
        select: { id: true },
      }),
    );
    expect(inA.map((r) => r.id)).toEqual([HELP_QUERY_A_ID]);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.helpChatQuery.findMany({
        where: { question: SHARED_HELP_QUESTION },
        select: { id: true },
      }),
    );
    expect(inB.map((r) => r.id)).toEqual([HELP_QUERY_B_ID]);
  });

  it("cross-tenant by-id read misses", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.helpChatQuery.findUnique({ where: { id: HELP_QUERY_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("the org-bound writer branch: create() on the asker's own lane succeeds and stays lane-visible", async () => {
    const created = await runWithTenant(ORG_A_ID, () =>
      db.helpChatQuery.create({
        data: {
          id: "tenancy-helpq-writer-probe",
          organizationId: ORG_A_ID,
          role: "ORGANIZER",
          question: "Writer-branch probe?",
          answer: "Yes.",
        },
      }),
    );
    expect(created.organizationId).toBe(ORG_A_ID);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.helpChatQuery.findUnique({ where: { id: created.id }, select: { id: true } }),
    );
    expect(inB).toBeNull();
    await runWithTenant(ORG_A_ID, () =>
      db.helpChatQuery.delete({ where: { id: created.id } }),
    );
  });

  it("ASYMMETRY write-half: the org-null asker's row inserts via bare createMany; create() is rejected on its RETURNING", async () => {
    const created = await db.helpChatQuery.createMany({
      data: [
        {
          id: HELP_QUERY_NULLORG_ID,
          organizationId: null,
          role: "REGISTRANT",
          question: "Org-less asker question (tenancy fixture)",
          answer: "Sample answer.",
        },
      ],
    });
    expect(created.count).toBe(1);
    await expect(
      db.helpChatQuery.create({
        data: {
          id: "tenancy-helpq-nullorg-returning",
          organizationId: null,
          role: "REGISTRANT",
          question: "RETURNING probe",
          answer: "Rejected.",
        },
      }),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("ASYMMETRY read-half: the NULL-org row is invisible to BOTH tenant lanes (operator privileged lane is its only reader)", async () => {
    for (const org of [ORG_A_ID, ORG_B_ID]) {
      const seen = await runWithTenant(org, () =>
        db.helpChatQuery.findUnique({
          where: { id: HELP_QUERY_NULLORG_ID },
          select: { id: true },
        }),
      );
      expect(seen).toBeNull();
    }
  });

  it("smuggle via create(): an explicit foreign org in A's lane is rejected", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.helpChatQuery.create({
          data: {
            id: "tenancy-helpq-smuggled",
            organizationId: ORG_B_ID,
            question: "smuggled",
            answer: "smuggled",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK strict disjunct proven via createMany (no RETURNING — only WITH CHECK can reject it)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.helpChatQuery.createMany({
          data: [
            {
              id: "tenancy-helpq-smuggled-many",
              organizationId: ORG_B_ID,
              question: "smuggled",
              answer: "smuggled",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN row to B (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.helpChatQuery.update({
          where: { id: HELP_QUERY_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("fail-closed: no tenant store → zero readable rows — exactly what the UNWRAPPED operator route sees from an app lane", async () => {
    expect(await db.helpChatQuery.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.helpChatQuery.count()).toBe(0);
  });

  it("cross-tenant DELETE misses: B's row cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.helpChatQuery.delete({ where: { id: HELP_QUERY_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
