/**
 * Reimbursement domain sweep (Domain #17): the flat policies from
 * prisma/rls/reimbursement.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, on SpeakerReimbursement (1-hop from
 * Event) + SpeakerReimbursementDocument (2-hop via SpeakerReimbursement).
 *
 * Domain-specific proofs:
 *   - The token is GLOBALLY unique (the plaintext public link). A cross-tenant
 *     `findUnique({ token })` under the wrong lane returns NULL — the exact
 *     public-route bootstrap: resolveReimbursementEventOrg resolves the org
 *     from the un-swept Event by host+slug FIRST, then the token reads on
 *     that lane (the RSVP-token shape).
 *   - speakerId is also GLOBALLY unique (one form per speaker) — same proof.
 *   - The 2-hop document addressed by its parent reimbursementId resolves
 *     only on the owning tenant's lane.
 *   - The WITH CHECK create-smuggle uses the DOCUMENT (the 2-hop child has no
 *     insertable-fixture constraint, unlike the speakerId-unique parent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  SPEAKER_B_ID,
  REIMB_A_ID,
  REIMB_B_ID,
  REIMB_B_TOKEN,
  REIMB_DOC_A_ID,
  REIMB_DOC_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Reimbursement RLS (prisma/rls/reimbursement.sql) via the SET LOCAL extension", () => {
  it("SpeakerReimbursement is lane-scoped: per-lane count + scoped by-id read", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.speakerReimbursement.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.speakerReimbursement.count())).toBe(1);
    const own = await runWithTenant(ORG_A_ID, () =>
      db.speakerReimbursement.findUnique({
        where: { id: REIMB_A_ID },
        select: { organizationId: true },
      }),
    );
    expect(own?.organizationId).toBe(ORG_A_ID);
  });

  it("globally-unique token is lane-scoped: findUnique({ token: B }) under A misses (the public bootstrap)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.speakerReimbursement.findUnique({ where: { token: REIMB_B_TOKEN }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("globally-unique speakerId is lane-scoped: findUnique({ speakerId: B }) under A misses", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.speakerReimbursement.findUnique({ where: { speakerId: SPEAKER_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("2-hop SpeakerReimbursementDocument is lane-scoped: by parent reimbursementId + by-id miss", async () => {
    const own = await runWithTenant(ORG_A_ID, () =>
      db.speakerReimbursementDocument.findMany({
        where: { reimbursementId: REIMB_A_ID },
        select: { id: true },
      }),
    );
    expect(own.map((d) => d.id)).toEqual([REIMB_DOC_A_ID]);
    // B's documents drained by B's parent id under A's store → empty (the
    // dashboard delete-route read shape).
    const byForeignParent = await runWithTenant(ORG_A_ID, () =>
      db.speakerReimbursementDocument.findMany({
        where: { reimbursementId: REIMB_B_ID },
        select: { id: true },
      }),
    );
    expect(byForeignParent).toHaveLength(0);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.speakerReimbursementDocument.findUnique({ where: { id: REIMB_DOC_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows on both tables", async () => {
    expect(await db.speakerReimbursement.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.speakerReimbursementDocument.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a document for ANOTHER tenant (the insertable 2-hop child)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.speakerReimbursementDocument.create({
          data: {
            id: "tenancy-rmdoc-smuggled",
            reimbursementId: REIMB_A_ID, // A's own parent…
            organizationId: ORG_B_ID, // …smuggled into B's lane
            kind: "OTHER",
            url: "/uploads/reimbursements/x/smuggled.pdf",
            filename: "smuggled.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN reimbursement to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.speakerReimbursement.update({
          where: { id: REIMB_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's reimbursement cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.speakerReimbursement.delete({ where: { id: REIMB_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
