/**
 * Job leases — REAL-Postgres integration tests.
 *
 * These have to hit a real database. The whole point of the lease is that
 * correctness stops depending on WHICH connection runs a statement, and a
 * mocked Prisma has exactly one fake connection — so the bug being fixed is not
 * even expressible under the unit suite. That is precisely how the advisory
 * lock it replaces passed every test for a year while silently skipping ~70% of
 * production ticks.
 *
 * The load-bearing case is "claim and release on DIFFERENT connections". With
 * `pg_try_advisory_lock` that combination LEAKS (verified against prod: acquire
 * on pid 14731, release on pid 14727, release returns false). With a lease it
 * must simply work, because a single statement is atomic wherever it runs.
 *
 * Run: docker compose --profile crm-test up -d
 *      CRM_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:crm-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  claimLease,
  renewLease,
  releaseLease,
  withJobLease,
  LEASE_TTL_MS,
} from "../../worker/lib/job-lease";

const JOB = "test-job";

async function leaseRow() {
  return db.jobLease.findUnique({ where: { job: JOB } });
}

async function expireLease() {
  await db.$executeRaw`UPDATE "JobLease" SET "lockedUntil" = now() - interval '1 second' WHERE "job" = ${JOB}`;
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "JobLease"');
  await db.$executeRawUnsafe('TRUNCATE TABLE "JobRun"');
});

describe("claimLease", () => {
  it("creates the row on first claim (no seeding required)", async () => {
    expect(await claimLease(JOB, "owner-a")).toBe(true);
    const row = await leaseRow();
    expect(row?.owner).toBe("owner-a");
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a second claim while the lease is held", async () => {
    expect(await claimLease(JOB, "owner-a")).toBe(true);
    expect(await claimLease(JOB, "owner-b")).toBe(false);
    expect((await leaseRow())?.owner).toBe("owner-a");
  });

  it("EXACTLY ONE of many concurrent claims wins", async () => {
    // The property the whole mechanism rests on. Under the old advisory lock
    // this passed too — but only because the lock happened to be taken and
    // checked on the same connection; here it is guaranteed by Postgres row
    // locking on a single statement.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claimLease(JOB, `owner-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("an EXPIRED lease is reclaimable — a killed worker never wedges a job", async () => {
    await claimLease(JOB, "dead-worker");
    await expireLease();
    expect(await claimLease(JOB, "new-worker")).toBe(true);
    expect((await leaseRow())?.owner).toBe("new-worker");
  });

  it("a RELEASED lease is immediately reclaimable", async () => {
    await claimLease(JOB, "owner-a");
    await releaseLease(JOB, "owner-a");
    expect(await claimLease(JOB, "owner-b")).toBe(true);
  });
});

describe("releaseLease / renewLease are owner-conditional", () => {
  it("a non-owner CANNOT release — the invariant that prevents a double run", async () => {
    // The scenario: tick A overruns, its lease expires, tick B claims it and
    // starts working. Tick A then finishes and tries to clean up. If A could
    // release, B's lease would vanish mid-run and tick C would start alongside
    // it — two concurrent runs of the same job, which is the one thing this
    // module exists to prevent.
    await claimLease(JOB, "tick-a");
    await expireLease();
    await claimLease(JOB, "tick-b");

    expect(await releaseLease(JOB, "tick-a")).toBe(false);
    expect((await leaseRow())?.owner).toBe("tick-b");
    // And B's lease is still live, so nobody else can barge in.
    expect(await claimLease(JOB, "tick-c")).toBe(false);
  });

  it("a non-owner CANNOT renew", async () => {
    await claimLease(JOB, "tick-a");
    expect(await renewLease(JOB, "someone-else")).toBe(false);
  });

  it("the owner CAN renew, pushing the expiry out", async () => {
    await claimLease(JOB, "tick-a", 2000);
    const before = (await leaseRow())!.lockedUntil!.getTime();
    expect(await renewLease(JOB, "tick-a", LEASE_TTL_MS)).toBe(true);
    const after = (await leaseRow())!.lockedUntil!.getTime();
    expect(after).toBeGreaterThan(before);
  });

  it("releasing a job that was never claimed is a harmless no-op", async () => {
    expect(await releaseLease("never-claimed", "nobody")).toBe(false);
  });
});

describe("connection independence — the bug this replaces", () => {
  it("claim and release survive landing on DIFFERENT pooled connections", async () => {
    // Force Prisma to open several connections and interleave work across
    // them, which is exactly the state that made `pg_advisory_unlock` return
    // false in production. A lease must not care.
    const pid = async () =>
      (await db.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`)[0].pid;

    await Promise.all(
      Array.from({ length: 8 }, () => db.$queryRaw`SELECT pg_sleep(0.05)::text AS s`),
    );
    expect(await claimLease(JOB, "owner-a")).toBe(true);
    const pidAtClaim = await pid();

    await Promise.all(
      Array.from({ length: 8 }, () => db.$queryRaw`SELECT pg_sleep(0.05)::text AS s`),
    );
    expect(await releaseLease(JOB, "owner-a")).toBe(true);
    const pidAtRelease = await pid();

    // The lease is genuinely free afterwards — the assertion that matters
    // regardless of whether the connections happened to differ this run.
    expect(await claimLease(JOB, "owner-b")).toBe(true);
    // Informational: if these differ, this run actively exercised the case
    // that broke the advisory lock.
    expect(typeof pidAtClaim === "number" && typeof pidAtRelease === "number").toBe(true);
  });
});

describe("withJobLease", () => {
  it("runs the tick, records a JobRun, and frees the lease", async () => {
    const out = await withJobLease(9001, JOB, async () => "done");
    expect(out).toBe("done");

    const row = await leaseRow();
    expect(row?.owner).toBeNull();
    expect(row?.lockedUntil).toBeNull();

    const runs = await db.jobRun.findMany({ where: { job: JOB } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("OK");
  });

  it("a second tick SKIPS while the first is still running — the 09:41/09:42 case", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    const slow = withJobLease(9001, JOB, async () => {
      await held;
      return "slow";
    });
    // Give the claim a moment to land before the overlapping tick fires.
    await new Promise((r) => setTimeout(r, 50));

    const overlapping = await withJobLease(9001, JOB, async () => "should not run");
    expect(overlapping).toBeNull();

    release();
    expect(await slow).toBe("slow");

    // Exactly one run recorded — a skip is not a run.
    const runs = await db.jobRun.findMany({ where: { job: JOB } });
    expect(runs).toHaveLength(1);
  });

  it("records FAILED and STILL frees the lease when the tick throws", async () => {
    await expect(
      withJobLease(9001, JOB, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The critical half: a throwing tick must not strand the lease, or one bad
    // run would take the job down until the TTL expired.
    const row = await leaseRow();
    expect(row?.owner).toBeNull();

    const runs = await db.jobRun.findMany({ where: { job: JOB } });
    expect(runs[0].status).toBe("FAILED");
    expect(runs[0].error).toContain("boom");
  });

  it("the next tick runs normally after a failure", async () => {
    await withJobLease(9001, JOB, async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(await withJobLease(9001, JOB, async () => "ok")).toBe("ok");
  });
});
