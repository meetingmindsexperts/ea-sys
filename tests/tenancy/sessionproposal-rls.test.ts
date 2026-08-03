/**
 * Session Proposals domain sweep (Domain #14): the flat policies from
 * prisma/rls/sessionproposal.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, across SessionProposal +
 * SessionProposalTheme (both 1-hop from Event).
 *
 * Domain-specific proofs:
 *   - SessionProposalTheme has NO per-org unique field (only @@unique([eventId,
 *     name])), so BOTH orgs hold a theme on the SAME name → an unscoped
 *     `where:{ name }` returns only the caller's row (the MediaFile /
 *     Certificate-template shared-value shape).
 *   - SessionProposal is the identity-edge case (org-null SUBMITTERs propose):
 *     the routes wrap with the RESOURCE org, so a proposal read/write on the
 *     event's org lane resolves; a cross-tenant by-id / by-theme addressing
 *     misses.
 *
 * No defence-#1-in-isolation assertion: the proposal/theme mutations bind the
 * org via a prior org-scoped event load + the resource/session-org
 * runWithTenant wrap (the Abstract/Session precedent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  SPEAKER_A_ID,
  SESSION_PROPOSAL_A_ID,
  SESSION_PROPOSAL_B_ID,
  SESSION_PROPOSAL_THEME_A_ID,
  SESSION_PROPOSAL_THEME_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Session Proposal RLS (prisma/rls/sessionproposal.sql) via the SET LOCAL extension", () => {
  it("shared theme name is lane-scoped: unscoped by-name returns only the caller's row", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.sessionProposalTheme.findMany({
        where: { name: "Clinical Innovations" },
        select: { id: true, organizationId: true },
      }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.sessionProposalTheme.findMany({
        where: { name: "Clinical Innovations" },
        select: { id: true },
      }),
    );
    expect(a.map((r) => r.id)).toEqual([SESSION_PROPOSAL_THEME_A_ID]);
    expect(a.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(b.map((r) => r.id)).toEqual([SESSION_PROPOSAL_THEME_B_ID]);
  });

  it("SessionProposal is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.sessionProposal.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.sessionProposal.findUnique({ where: { id: SESSION_PROPOSAL_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("SessionProposalTheme cross-tenant by-id miss", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.sessionProposalTheme.findUnique({ where: { id: SESSION_PROPOSAL_THEME_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("the proposals-list read shape (nested speaker include) resolves the tenant's own proposal", async () => {
    // The route reads SessionProposal with a nested Speaker (swept #9) include —
    // both must resolve on the same lane.
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.sessionProposal.findMany({
        where: { eventId: EVENT_A_SHARED_ID },
        select: { id: true, speaker: { select: { id: true } } },
      }),
    );
    expect(rows.map((r) => r.id)).toEqual([SESSION_PROPOSAL_A_ID]);
    expect(rows[0]?.speaker.id).toBe(SPEAKER_A_ID);
  });

  it("scoped read by-theme returns the tenant's own proposal", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.sessionProposal.findMany({ where: { themeId: SESSION_PROPOSAL_THEME_A_ID }, select: { id: true } }),
    );
    expect(rows.map((r) => r.id)).toEqual([SESSION_PROPOSAL_A_ID]);
  });

  it("fail-closed: flag on but NO tenant store → zero rows on both tables", async () => {
    expect(await db.sessionProposal.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.sessionProposalTheme.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a SessionProposal for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.sessionProposal.create({
          data: {
            id: "tenancy-sprop-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            speakerId: SPEAKER_A_ID,
            title: "Smuggled Proposal",
            description: "should be rejected by WITH CHECK",
            status: "SUBMITTED",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN proposal to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.sessionProposal.update({
          where: { id: SESSION_PROPOSAL_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's proposal cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.sessionProposal.delete({ where: { id: SESSION_PROPOSAL_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("scoped SessionProposal by-id read resolves for the tenant's own row", async () => {
    const p = await runWithTenant(ORG_A_ID, () =>
      db.sessionProposal.findUnique({ where: { id: SESSION_PROPOSAL_A_ID }, select: { organizationId: true } }),
    );
    expect(p?.organizationId).toBe(ORG_A_ID);
  });
});
