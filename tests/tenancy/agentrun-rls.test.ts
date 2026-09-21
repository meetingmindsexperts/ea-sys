/**
 * AgentRun + AgentStep (Event Agent stored runs, Sep 21 2026): the policy from
 * prisma/rls/agentrun.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - No per-org unique field; both orgs' runs carry the SAME scalar userId,
 *     so the by-user read resolving to one lane's run is what proves scoping
 *     (the MediaFile shape). Each run's step carries the SAME tool name, so
 *     the step read by tool proves the denormalized org column scopes the
 *     child on its own, and the read through the parent's id proves the
 *     2-hop shape.
 *   - The ONE writer (src/lib/agent/run-store.ts) creates the run on the
 *     actor's lane, creates each step on the same lane, and finishes with a
 *     compound updateMany({ id, organizationId }). All three shapes are
 *     pinned here: on the own lane they succeed; a cross-tenant id misses.
 *   - Both columns are NOT NULL, so there is no NULL-org carve-out to prove:
 *     the policy is the strict flat shape on both halves.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  AGENT_RUN_A_ID,
  AGENT_RUN_B_ID,
  AGENT_STEP_A_ID,
  AGENT_STEP_B_ID,
  SHARED_AGENT_USER_ID,
  SHARED_AGENT_TOOL,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("AgentRun/AgentStep RLS (prisma/rls/agentrun.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED userId resolves to each lane's own run", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.agentRun.findMany({ where: { userId: SHARED_AGENT_USER_ID }, select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([AGENT_RUN_A_ID]);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.agentRun.findMany({ where: { userId: SHARED_AGENT_USER_ID }, select: { id: true } }),
    );
    expect(inB.map((r) => r.id)).toEqual([AGENT_RUN_B_ID]);
  });

  it("lane-scoped child: the SHARED tool name resolves to each lane's own step", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.agentStep.findMany({ where: { tool: SHARED_AGENT_TOOL }, select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([AGENT_STEP_A_ID]);
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.agentStep.findMany({ where: { tool: SHARED_AGENT_TOOL }, select: { id: true } }),
    );
    expect(inB.map((r) => r.id)).toEqual([AGENT_STEP_B_ID]);
  });

  it("2-hop: B's step is invisible from A's lane even when addressed by its run id", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.agentStep.findMany({ where: { runId: AGENT_RUN_B_ID }, select: { id: true } }),
    );
    expect(leaked).toEqual([]);
    const viaParent = await runWithTenant(ORG_A_ID, () =>
      db.agentRun.findUnique({ where: { id: AGENT_RUN_B_ID }, select: { steps: { select: { id: true } } } }),
    );
    expect(viaParent).toBeNull();
  });

  it("cross-tenant by-id read misses", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.agentRun.findUnique({ where: { id: AGENT_RUN_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("the writer's three shapes on the own lane: create the run, create a step, finish by compound updateMany", async () => {
    const created = await runWithTenant(ORG_A_ID, () =>
      db.agentRun.create({
        data: {
          id: "tenancy-agentrun-writer-probe",
          organizationId: ORG_A_ID,
          userId: "tenancy-agent-probe-user",
          role: "ORGANIZER",
          route: "org",
          messageLength: 5,
        },
        select: { id: true, organizationId: true },
      }),
    );
    expect(created.organizationId).toBe(ORG_A_ID);
    const step = await runWithTenant(ORG_A_ID, () =>
      db.agentStep.create({
        data: { runId: created.id, organizationId: ORG_A_ID, seq: 0, tool: "create_event", outcome: "RAN", write: true, durationMs: 3 },
        select: { id: true },
      }),
    );
    expect(step.id).toBeTruthy();
    const finished = await runWithTenant(ORG_A_ID, () =>
      db.agentRun.updateMany({
        where: { id: created.id, organizationId: ORG_A_ID },
        data: { outcome: "COMPLETED", toolCalls: 1, writes: 1 },
      }),
    );
    expect(finished.count).toBe(1);
    // Invisible to the other lane, step included.
    const inB = await runWithTenant(ORG_B_ID, () =>
      db.agentRun.findUnique({ where: { id: created.id }, select: { id: true } }),
    );
    expect(inB).toBeNull();
    const stepInB = await runWithTenant(ORG_B_ID, () =>
      db.agentStep.findUnique({ where: { id: step.id }, select: { id: true } }),
    );
    expect(stepInB).toBeNull();
    await runWithTenant(ORG_A_ID, () => db.agentRun.delete({ where: { id: created.id } }));
    // The cascade took the step with it.
    const gone = await runWithTenant(ORG_A_ID, () => db.agentStep.findUnique({ where: { id: step.id }, select: { id: true } }));
    expect(gone).toBeNull();
  });

  it("the compound finish misses cross-tenant: A cannot finish B's run", async () => {
    const res = await runWithTenant(ORG_A_ID, () =>
      db.agentRun.updateMany({
        where: { id: AGENT_RUN_B_ID, organizationId: ORG_B_ID },
        data: { outcome: "ERROR" },
      }),
    );
    expect(res.count).toBe(0);
    const untouched = await runWithTenant(ORG_B_ID, () =>
      db.agentRun.findUnique({ where: { id: AGENT_RUN_B_ID }, select: { outcome: true } }),
    );
    expect(untouched?.outcome).toBe("COMPLETED");
  });

  it("smuggle via create(): an explicit foreign org in A's lane is rejected, for a run and for a step", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.agentRun.create({
          data: { id: "tenancy-agentrun-smuggled", organizationId: ORG_B_ID, userId: "x", role: "ADMIN", route: "org", messageLength: 1 },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.agentStep.create({
          data: { runId: AGENT_RUN_A_ID, organizationId: ORG_B_ID, seq: 9, tool: "x", outcome: "RAN", durationMs: 1 },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK strict disjunct proven via createMany (no RETURNING — only WITH CHECK can reject it)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.agentRun.createMany({
          data: [{ id: "tenancy-agentrun-smuggled-many", organizationId: ORG_B_ID, userId: "x", role: "ADMIN", route: "org", messageLength: 1 }],
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN run to B (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.agentRun.update({ where: { id: AGENT_RUN_A_ID }, data: { organizationId: ORG_B_ID } }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("fail-closed: no tenant store → zero readable rows on both tables", async () => {
    expect(await db.agentRun.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.agentStep.count()).toBe(0);
  });

  it("cross-tenant DELETE misses: B's run cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.agentRun.delete({ where: { id: AGENT_RUN_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
